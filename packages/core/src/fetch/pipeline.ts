/**
 * Fetch orchestration. One read of a URL walks these steps in order:
 *
 *   guard (SSRF, allow/deny) → cache → fast path (documented APIs) → robots.txt → budget →
 *   obtain the page (honest GET, or one self-identified browser attempt) → signals, freshness, llms.txt →
 *   extract → cache.
 *
 * A refusal anywhere is final and surfaces as a `DiagnosedError` carrying a `Diagnosis`.
 */

import type { Audit } from "../audit.js";
import type { Cache, CachedPage } from "../cache.js";
import { domainMatches, type Settings } from "../config.js";
import { BudgetExceeded, type Politeness } from "../politeness.js";
import { BrowserUnavailable, type BrowserTier } from "./browser.js";
import {
  BROWSER_RETRY_KINDS,
  diagnose,
  diagnoseBudget,
  diagnoseContentSignal,
  diagnoseRobots,
  diagnoseUnpassedChallenge,
  finalizeAfterBrowser,
  isChallengePage,
  type Diagnosis,
} from "./diagnose.js";
import {
  cleanMarkdownSource,
  detectShell,
  htmlTitle,
  htmlToMarkdown,
  pdfToMarkdown,
  splitFrontmatter,
} from "./extract.js";
import { freshness, type Freshness } from "./freshness.js";
import { assertPublicUrl, BlockedURL } from "./guard.js";
import { isApiUrl, llmsTxt, resolveFastPath, rewriteUrl } from "./resolver.js";
import type { RobotsChecker, RobotsDecision } from "./robots.js";
import { knownLicence, licenceSignals, parseContentSignal } from "./signals.js";
import { FetchError, type Transport } from "./transport.js";
import { fetchedText, type Fetched, type HttpLike } from "./types.js";

export { BlockedURL };

export interface PageDoc {
  url: string;
  finalUrl: string;
  title: string;
  /** Where the content came from: `direct (html/main)`, `browser`, `github-readme`, `cache ← …`. */
  source: string;
  markdown: string;
  note: string;
  robots: string;
  licence: string[];
  cached: boolean;
  updated?: Freshness;
}

export class DiagnosedError extends Error {
  constructor(
    public readonly url: string,
    public readonly diagnosis: Diagnosis,
  ) {
    super(diagnosis.message);
    this.name = "DiagnosedError";
  }
}

export interface FetchOptions {
  raw?: boolean;
  via?: "archive";
}

const PAGE_FRESH_MS = 24 * 3600_000;
const LLMS_TXT_LINK_RE = /<([^>]+)>;[^,]*rel="?llms-txt"?/i;

/** A page as the pipeline holds it between obtaining it and finishing the document. */
interface Page {
  fetched: Fetched;
  robots: string;
  signals: string[];
}

export class Fetcher {
  /** URLs the live site reported gone (404/410) this session; the only ones `via: "archive"` may read. */
  private readonly gone = new Set<string>();

  constructor(
    private readonly settings: Settings,
    private readonly cache: Cache,
    private readonly transport: Transport,
    private readonly robots: RobotsChecker,
    private readonly politeness: Politeness,
    private readonly audit: Audit,
    private readonly browser?: BrowserTier,
  ) {}

  /**
   * HttpLike adapter for fast paths and search providers: same UA, politeness, audit, SSRF.
   * `budget: false` exempts calls from the session *page* budget (search-provider API calls are
   * bounded by per-host politeness and the providers' own quotas instead).
   */
  http(source = "api", opts: { budget?: boolean } = {}): HttpLike {
    return async (url, init) => {
      const u = new URL(url);
      const safe = await assertPublicUrl(url, { allowPrivate: this.settings.allowPrivate });
      if (opts.budget !== false) this.politeness.charge();
      const r = await this.politeness.run(
        u.host,
        () => this.transport.get(safe, { headers: init?.headers, method: init?.method, body: init?.body, source }),
        this.settings.hostGapsMs[u.hostname.toLowerCase()],
      );
      const text = fetchedText(r);
      return {
        status: r.status,
        headers: r.headers,
        text: async () => text,
        json: async () => JSON.parse(text) as unknown,
      };
    };
  }

  async fetch(rawUrl: string, opts: FetchOptions = {}): Promise<PageDoc> {
    const url = rewriteUrl(await assertPublicUrl(rawUrl, { allowPrivate: this.settings.allowPrivate }));
    // A bare host or http:// was upgraded to https optimistically and may fall back; an explicit
    // https:// is a request for encryption and never falls back to the clear.
    const httpFallback = !/^\s*https:\/\//i.test(rawUrl);
    this.checkLists(url);
    if (opts.via === "archive") return this.fromArchive(url);
    if (opts.raw) return this.fetchRaw(url, httpFallback);

    const cached = this.cache.getPage(url, true);
    if (cached && this.isFresh(cached)) {
      this.audit.record({ url, cache: "hit" });
      return this.fromCache(url, cached, "cache", "cached");
    }

    // Fast paths talk only to documented public APIs, under those APIs' terms; the HTML page's
    // robots.txt rules do not apply to them.
    const fast = await resolveFastPath(url, this.http("api"));
    if (fast) return this.finish(url, { fetched: fast, robots: "api terms", signals: [] });

    const decision = await this.checkRobots(url);
    this.charge(url);
    const page = await this.obtain(url, cached, decision, httpFallback);
    if (page === "not-modified") {
      this.cache.touchPage(url);
      return this.fromCache(url, cached!, "cache (revalidated)", robotsLabel(decision));
    }
    return this.finish(url, page);
  }

  // ---- steps -----------------------------------------------------------------------------------

  private checkLists(url: string): void {
    const host = new URL(url).hostname;
    if (this.settings.denyDomains.length && domainMatches(host, this.settings.denyDomains)) {
      throw new BlockedURL(`'${host}' is on the deny list (--deny-domains).`);
    }
    if (this.settings.allowDomains.length && !domainMatches(host, this.settings.allowDomains) && !isApiUrl(url)) {
      throw new BlockedURL(`'${host}' is not on the allow list (--allow-domains).`);
    }
  }

  /** A cached page is served as-is for a day when the origin gave us no validators to revalidate with. */
  private isFresh(cached: CachedPage): boolean {
    return Date.now() - cached.fetchedAt < PAGE_FRESH_MS && !cached.etag && !cached.lastModified;
  }

  private async checkRobots(url: string): Promise<RobotsDecision> {
    const decision = await this.robots.check(url);
    if (decision.allowed) return decision;
    this.audit.record({
      url,
      robots: decision.status === "unavailable" ? "unavailable" : "disallowed",
      note: decision.reason,
    });
    if (decision.contentSignal)
      throw new DiagnosedError(url, diagnoseContentSignal("robots.txt", decision.contentSignal));
    throw new DiagnosedError(url, diagnoseRobots(decision.reason ?? "disallowed"));
  }

  private charge(url: string, units = 1): void {
    try {
      for (let i = 0; i < units; i++) this.politeness.charge();
    } catch (e) {
      if (e instanceof BudgetExceeded) throw new DiagnosedError(url, diagnoseBudget(e.message));
      throw e;
    }
  }

  /**
   * Get the page from the network: the honest GET first, then — if the plain client got a JS shell or
   * was refused — one self-identified browser attempt. Hosts known to need the browser skip the GET.
   */
  private async obtain(
    url: string,
    cached: CachedPage | null,
    decision: RobotsDecision,
    httpFallback: boolean,
  ): Promise<Page | "not-modified"> {
    const host = new URL(url).host;
    const robots = robotsLabel(decision);
    const browserOn = this.browser?.enabled() ?? false;

    if (!cached && browserOn && this.cache.needsBrowser(host)) {
      const known: Diagnosis = {
        kind: "js_required",
        retryable: false,
        message: "host known to need a browser",
        nextAction: "",
      };
      const fetched = await this.renderWithBrowser(
        url,
        host,
        known,
        decision.crawlDelayMs,
        httpFallback,
        "skipped (host known to need a browser)",
      );
      return { fetched, robots, signals: [] };
    }

    // A redirect to another host is a request to that host: check its robots.txt before following.
    const beforeCrossHostRedirect = async (next: string) => {
      const d = await this.robots.check(next);
      if (!d.allowed)
        throw new DiagnosedError(next, diagnoseRobots(`${d.reason ?? "disallowed"} — after redirect from ${url}`));
    };
    const conditional = cached ? { etag: cached.etag, lastModified: cached.lastModified } : undefined;
    const r = await this.politeness.run(
      host,
      () => this.transport.get(url, { conditional, source: "direct", beforeCrossHostRedirect, httpFallback }),
      decision.crawlDelayMs,
    );
    if (r.notModified && cached) return "not-modified";

    let fetched: Fetched = r;
    const dx = diagnose(r, { isShell: r.kind === "html" && detectShell(fetchedText(r)) });
    if (dx) {
      if (dx.kind === "not_found") this.gone.add(url);
      if (!BROWSER_RETRY_KINDS.has(dx.kind) || !browserOn) throw new DiagnosedError(url, dx);
      fetched = await this.renderWithBrowser(url, host, dx, decision.crawlDelayMs, httpFallback);
      // Remember, so the next read of this host starts with the right client (same identity, same rules).
      this.cache.setNeedsBrowser(host);
    }

    // Content-Signal response header: ai-input=no means "don't feed my pages into an AI model".
    const cs = parseContentSignal(fetched.headers["content-signal"]);
    if (cs?.aiInput === false) {
      this.audit.record({
        url,
        status: fetched.status,
        note: `Content-Signal ai-input=no (${cs.raw}); content withheld`,
      });
      throw new DiagnosedError(url, diagnoseContentSignal("HTTP header", cs.raw));
    }
    return { fetched, robots, signals: licenceSignals(fetched.headers, fetchedText(fetched)) };
  }

  /** Extract, annotate (licence, freshness, llms.txt), cache, and return the document. */
  private async finish(url: string, page: Page): Promise<PageDoc> {
    const { fetched, robots } = page;
    const signals = [...page.signals];
    const lic = knownLicence(new URL(fetched.finalUrl).hostname);
    if (lic) signals.push(lic);

    let doc = await this.toDocument(url, fetched, robots, signals);
    const updated = freshness(fetched.headers, fetched.kind === "html" ? fetchedText(fetched) : undefined);
    if (updated.date) doc.updated = updated;

    const notes: string[] = [];
    // The header shows the final URL; when the host changed under us, say where we came from.
    if (new URL(fetched.finalUrl).host !== new URL(url).host) notes.push(`Note: redirected from ${url}.`);
    const llmsLink = LLMS_TXT_LINK_RE.exec(fetched.headers["link"] ?? "")?.[1] ?? fetched.headers["x-llms-txt"];
    if (llmsLink) notes.push(`Note: this site advertises an agent index at ${new URL(llmsLink, fetched.finalUrl)}.`);
    doc.note = notes.join(" ");
    doc = await this.preferLlmsTxt(url, fetched.finalUrl, doc);

    if (!doc.markdown.trim())
      throw new FetchError(`Fetched ${url} but extracted no readable content (source: ${doc.source}).`);
    this.cache.setPage({
      url,
      finalUrl: doc.finalUrl,
      title: doc.title,
      source: doc.source,
      markdown: doc.markdown,
      etag: fetched.headers["etag"] ?? null,
      lastModified: fetched.headers["last-modified"] ?? null,
      licence: signals.length ? signals.join(" | ") : null,
      updated: doc.updated ?? null,
    });
    return doc;
  }

  /**
   * On a docs site's root pages, /llms.txt is usually a far better index than the HTML home. Probed on
   * the origin the page actually came from, and never recommended when that is the page itself.
   */
  private async preferLlmsTxt(url: string, finalUrl: string, doc: PageDoc): Promise<PageDoc> {
    const final = new URL(finalUrl);
    const depth = final.pathname.split("/").filter(Boolean).length;
    if (depth > 1 || /\/llms\.txt$/.test(final.pathname)) return doc;
    const llms = await llmsTxt(finalUrl, this.http("llms.txt")).catch(() => null);
    if (!llms) return doc;
    if (depth === 0 || doc.markdown.trim().length < 500) {
      return { ...doc, title: doc.title || "llms.txt", source: "llms.txt", markdown: withTrailingNewline(llms) };
    }
    return {
      ...doc,
      note: `${doc.note} Note: this site publishes ${final.origin}/llms.txt (an agent-friendly index of its docs).`.trim(),
    };
  }

  private async fetchRaw(url: string, httpFallback: boolean): Promise<PageDoc> {
    const decision = await this.checkRobots(url);
    this.charge(url);
    const host = new URL(url).host;
    const r = await this.politeness.run(
      host,
      () => this.transport.get(url, { source: "direct", httpFallback }),
      decision.crawlDelayMs,
    );
    // Raw follows the same ladder as read: a JS shell or a refusal earns the one browser attempt,
    // and the agent gets the rendered DOM — the HTML they asked for, not an empty scaffold. A page
    // that renders fine over plain HTTP costs no browser. An unpassed bot check is a refusal here too.
    const dx = diagnose(r, { isShell: r.kind === "html" && detectShell(fetchedText(r)) });
    if (dx && BROWSER_RETRY_KINDS.has(dx.kind) && (this.browser?.enabled() ?? false)) {
      const fetched = await this.renderWithBrowser(url, host, dx, decision.crawlDelayMs, httpFallback);
      return this.document(url, fetched.finalUrl, {
        title: htmlTitle(fetchedText(fetched)),
        source: `raw (browser DOM), ${fetched.source.replace(/^browser(?: \(partial render\))?,? ?/, "")}`.replace(
          /, $/,
          "",
        ),
        markdown: fetchedText(fetched),
        robots: robotsLabel(decision),
        licence: [],
      });
    }
    return this.document(url, r.finalUrl, {
      title: r.kind === "html" ? htmlTitle(fetchedText(r)) : "",
      source: `raw (${r.kind}, HTTP ${r.status})`,
      markdown: fetchedText(r),
      robots: robotsLabel(decision),
      licence: licenceSignals(r.headers),
    });
  }

  // ---- documents -------------------------------------------------------------------------------

  private document(
    url: string,
    finalUrl: string,
    d: Pick<PageDoc, "title" | "source" | "markdown" | "robots" | "licence"> & Partial<PageDoc>,
  ): PageDoc {
    return { url, finalUrl, note: "", cached: false, ...d };
  }

  private fromCache(url: string, cached: CachedPage, sourcePrefix: string, robots: string): PageDoc {
    return this.document(url, cached.finalUrl, {
      title: cached.title,
      source: `${sourcePrefix} ← ${cached.source}`,
      markdown: cached.markdown,
      robots,
      licence: cached.licence ? cached.licence.split(" | ") : [],
      cached: true,
      updated: cached.updated ?? undefined,
    });
  }

  /** Turn fetched bytes of any supported kind into a document with markdown content. */
  private async toDocument(url: string, f: Fetched, robots: string, licence: string[]): Promise<PageDoc> {
    const doc = (title: string, source: string, markdown: string) =>
      this.document(url, f.finalUrl, { title, source, markdown, robots, licence });
    if (f.kind === "pdf") {
      const data = typeof f.body === "string" ? new TextEncoder().encode(f.body) : f.body;
      const ex = await pdfToMarkdown(data);
      return doc(ex.title, `${f.source} (pdf)`, ex.markdown);
    }
    if (f.kind === "html") {
      const ex = htmlToMarkdown(fetchedText(f));
      return doc(ex.title, f.source === "direct" ? `direct (html/${ex.method})` : f.source, ex.markdown);
    }
    // markdown, text, json
    const { meta, body } = splitFrontmatter(fetchedText(f));
    const text = f.kind === "markdown" ? cleanMarkdownSource(body) : body;
    return doc(
      meta.title ?? firstHeading(text),
      f.source === "direct" ? `direct (${f.kind})` : f.source,
      withTrailingNewline(text),
    );
  }

  // ---- the browser tier ------------------------------------------------------------------------

  /**
   * One browser attempt, under the same robots decision and host queue. A browser read costs two
   * budget units in total (the plain attempt already paid one). If the rendered page is itself a
   * challenge/login/paywall/shell, the refusal is final — unless the check was handed to the person
   * and merely not passed yet, in which case the answer is "waiting for you; call again".
   */
  private async renderWithBrowser(
    url: string,
    host: string,
    plain: Diagnosis,
    crawlDelayMs: number | undefined,
    httpFallback: boolean,
    directLabel?: string,
  ): Promise<Fetched> {
    const attempts = [`direct: ${directLabel ?? plain.kind}`];
    this.charge(url, 1);
    let rendered;
    try {
      rendered = await this.politeness.run(
        host,
        () => this.browser!.render(url, { handoff: true, httpFallback }),
        crawlDelayMs,
      );
    } catch (e) {
      if (e instanceof BlockedURL) throw e;
      if (e instanceof BrowserUnavailable) this.audit.log("warn", `browser tier unavailable: ${e.message}`);
      const why =
        e instanceof BrowserUnavailable
          ? `unavailable (${e.message})`
          : `error (${(e as Error).message.split("\n")[0]})`;
      throw new DiagnosedError(url, { ...plain, attempts: [...attempts, `browser: ${why}`] });
    }
    const provenance = [
      rendered.salvaged ? "browser (partial render)" : "browser",
      rendered.label,
      rendered.handedOff && "challenge passed by you",
    ];
    const fetched: Fetched = {
      url,
      finalUrl: rendered.finalUrl,
      kind: "html",
      body: rendered.html,
      source: provenance.filter(Boolean).join(", "),
      status: rendered.status,
      contentType: "text/html",
      headers: {},
    };
    // A page the person just unlocked is never re-classified as a refusal — their pass is the final
    // word on access. If what's behind the gate is nearly empty, that near-empty page is the answer.
    if (rendered.handedOff) return fetched;
    // The same detector that decides whether to hand a page to the person decides whether what came
    // back is still a bot check: a Cloudflare interstitial has text and no empty mount point, so the
    // shell heuristic alone would wave it through as content.
    if (isChallengePage(rendered.html, rendered.status, rendered.finalUrl)) {
      throw new DiagnosedError(
        url,
        diagnoseUnpassedChallenge([...attempts, "browser: captcha_or_challenge"], rendered.handoffWhere),
      );
    }
    const dx = diagnose(fetched, { isShell: detectShell(rendered.html) });
    if (dx) throw new DiagnosedError(url, finalizeAfterBrowser(dx, [...attempts, `browser: ${dx.kind}`]));
    return fetched;
  }

  // ---- the archive -----------------------------------------------------------------------------

  /** Wayback Machine, only for pages the live site reports gone. Never a bypass for blocks. */
  private async fromArchive(url: string): Promise<PageDoc> {
    if (!this.gone.has(url)) {
      // Verify the live page is actually gone first; a blocked page stays blocked.
      try {
        const live = await this.fetch(url);
        return { ...live, note: `${live.note} The live page is available; archive not used.`.trim() };
      } catch (e) {
        if (!(e instanceof DiagnosedError) || e.diagnosis.kind !== "not_found") throw e;
      }
    }
    const avail = await this.http("archive")(`https://archive.org/wayback/available?url=${encodeURIComponent(url)}`, {
      headers: { accept: "application/json" },
    });
    if (avail.status !== 200) throw new FetchError(`Wayback availability API returned HTTP ${avail.status}.`);
    const data = (await avail.json()) as { archived_snapshots?: { closest?: { url: string; timestamp: string } } };
    const snap = data.archived_snapshots?.closest;
    if (!snap) throw new FetchError("No archived snapshot exists for this URL.");

    const rawUrl = snap.url.replace(`/web/${snap.timestamp}/`, `/web/${snap.timestamp}id_/`);
    await this.checkRobots(rawUrl);
    this.charge(url);
    const r = await this.politeness.run("web.archive.org", () =>
      this.transport.get(rawUrl, { source: `archive (${snap.timestamp.slice(0, 8)})` }),
    );
    if (r.status !== 200) throw new FetchError(`Archive snapshot returned HTTP ${r.status}.`);
    const doc = await this.toDocument(url, { ...r, url, finalUrl: url }, "allowed (web.archive.org)", []);
    const when = `${snap.timestamp.slice(0, 4)}-${snap.timestamp.slice(4, 6)}-${snap.timestamp.slice(6, 8)}`;
    return { ...doc, note: `Archived copy from ${when}; the live page reported 404/410.` };
  }
}

function robotsLabel(d: RobotsDecision): string {
  return d.status === "api" ? "api terms" : "allowed";
}

function firstHeading(text: string): string {
  const line = text.split("\n", 5).find((l) => l.startsWith("# "));
  return line ? line.slice(2).trim() : "";
}

function withTrailingNewline(s: string): string {
  return s.endsWith("\n") ? s : s + "\n";
}
