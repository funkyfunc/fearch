/**
 * Fetch orchestration:
 * validate+SSRF → allow/deny → cache (conditional GET) → robots.txt → politeness → fast paths →
 * honest GET → diagnose → extract. A refusal is final and comes back as a Diagnosis.
 */

import type { Audit } from "../audit.js";
import type { Cache } from "../cache.js";
import { domainMatches, type Settings } from "../config.js";
import { BudgetExceeded, type Politeness } from "../politeness.js";
import type { BrowserRenderer } from "./browser.js";
import { BrowserUnavailable } from "./browser.js";
import { BROWSER_RETRY_KINDS, diagnose, diagnoseBudget, diagnoseContentSignal, diagnoseRobots, finalizeAfterBrowser, type Diagnosis } from "./diagnose.js";
import { cleanMarkdownSource, detectShell, htmlToMarkdown, pdfToMarkdown, splitFrontmatter } from "./extract.js";
import { freshness, type Freshness } from "./freshness.js";
import { assertPublicUrl, BlockedURL } from "./guard.js";
export { BlockedURL };
import { isApiUrl, llmsTxt, resolveFastPath, rewriteUrl } from "./resolver.js";
import type { RobotsChecker } from "./robots.js";
import { knownLicence, licenceSignals, parseContentSignal } from "./signals.js";
import { FetchError, type Transport } from "./transport.js";
import { fetchedText, type Fetched, type HttpLike } from "./types.js";

export interface PageDoc {
  url: string;
  finalUrl: string;
  title: string;
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

export class Fetcher {
  private readonly gone = new Set<string>();

  constructor(
    private readonly settings: Settings,
    private readonly cache: Cache,
    private readonly transport: Transport,
    private readonly robots: RobotsChecker,
    private readonly politeness: Politeness,
    private readonly audit: Audit,
    private readonly browser?: BrowserRenderer,
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
      return { status: r.status, headers: r.headers, text: async () => text, json: async () => JSON.parse(text) as unknown };
    };
  }

  private checkLists(url: string): void {
    const host = new URL(url).hostname;
    if (this.settings.denyDomains.length && domainMatches(host, this.settings.denyDomains)) {
      throw new BlockedURL(`'${host}' is on FEARCH_DENY_DOMAINS.`);
    }
    if (this.settings.allowDomains.length && !domainMatches(host, this.settings.allowDomains) && !isApiUrl(url)) {
      throw new BlockedURL(`'${host}' is not on FEARCH_ALLOW_DOMAINS.`);
    }
  }

  private toDoc(url: string, f: Fetched, extra: Partial<PageDoc> = {}): Promise<PageDoc> | PageDoc {
    const base = { url, finalUrl: f.finalUrl, note: "", robots: extra.robots ?? "", licence: extra.licence ?? [], cached: false };
    if (f.kind === "pdf") {
      const data = typeof f.body === "string" ? new TextEncoder().encode(f.body) : f.body;
      return pdfToMarkdown(data).then((ex) => ({ ...base, title: ex.title, source: `${f.source} (pdf)`, markdown: ex.markdown }));
    }
    if (f.kind === "markdown" || f.kind === "text" || f.kind === "json") {
      const { meta, body } = splitFrontmatter(fetchedText(f));
      const text = f.kind === "markdown" ? cleanMarkdownSource(body) : body;
      let title = meta.title ?? "";
      if (!title) {
        for (const line of text.split("\n").slice(0, 5)) {
          if (line.startsWith("# ")) {
            title = line.slice(2).trim();
            break;
          }
        }
      }
      const source = f.source === "direct" ? `direct (${f.kind})` : f.source;
      return { ...base, title, source, markdown: text.endsWith("\n") ? text : text + "\n" };
    }
    const ex = htmlToMarkdown(fetchedText(f), f.finalUrl);
    const source = f.source === "direct" ? `direct (html/${ex.method})` : f.source;
    return { ...base, title: ex.title, source, markdown: ex.markdown };
  }

  async fetch(rawUrl: string, opts: FetchOptions = {}): Promise<PageDoc> {
    let url = await assertPublicUrl(rawUrl, { allowPrivate: this.settings.allowPrivate });
    url = rewriteUrl(url);
    this.checkLists(url);
    const host = new URL(url).host;

    if (opts.via === "archive") return this.fromArchive(url);

    // Cache (with validators for a conditional request).
    const cached = opts.raw ? null : this.cache.getPage(url, true);
    if (cached && !opts.raw && Date.now() - cached.fetchedAt < 24 * 3600_000 && !cached.etag && !cached.lastModified) {
      this.audit.record({ url, cache: "hit" });
      return { url, finalUrl: cached.finalUrl, title: cached.title, source: `cache ← ${cached.source}`, markdown: cached.markdown, note: "", robots: "cached", licence: cached.licence ? cached.licence.split(" | ") : [], cached: true, updated: cached.updated ?? undefined };
    }

    // Fast paths first: they talk only to documented public APIs (api.github.com, registry.npmjs.org…)
    // under those APIs' terms, so the HTML page's robots.txt rules do not apply to them.
    if (!opts.raw) {
      const fast = await resolveFastPath(url, this.http("api"));
      if (fast) {
        const doc = await this.toDoc(url, fast, { robots: "api terms" });
        this.cache.setPage({ url, finalUrl: doc.finalUrl, title: doc.title, source: doc.source, markdown: doc.markdown, etag: null, lastModified: null, licence: null, updated: null });
        return doc;
      }
    }

    // robots.txt before anything touches the host's pages.
    let robotsLine = "";
    const decision = await this.robots.check(url);
    if (!decision.allowed) {
      this.audit.record({ url, robots: decision.status === "unavailable" ? "unavailable" : "disallowed", note: decision.reason });
      if (decision.contentSignal) throw new DiagnosedError(url, diagnoseContentSignal("robots.txt", decision.contentSignal));
      throw new DiagnosedError(url, diagnoseRobots(decision.reason ?? "disallowed"));
    }
    robotsLine = decision.status === "api" ? "api terms" : decision.status === "ignored" ? "off (FEARCH_ROBOTS_POLICY=off)" : "allowed";

    try {
      this.politeness.charge();
    } catch (e) {
      if (e instanceof BudgetExceeded) throw new DiagnosedError(url, diagnoseBudget(e.message));
      throw e;
    }

    // Honest GET (conditional when we hold validators).
    const conditional = cached && !opts.raw ? { etag: cached.etag, lastModified: cached.lastModified } : undefined;
    // A redirect to another host is a request to that host: check its robots.txt before following.
    const beforeCrossHostRedirect = async (next: string) => {
      const d = await this.robots.check(next);
      if (!d.allowed) throw new DiagnosedError(next, diagnoseRobots(`${d.reason ?? "disallowed"} — after redirect from ${url}`));
    };

    // Host known (last 24h) to need a browser: skip the plain attempt that would just fail.
    if (!opts.raw && !cached && this.browser?.enabled() && this.cache.needsBrowser(host)) {
      const fetched = await this.renderWithBrowser(url, host, { kind: "js_required", retryable: false, message: "host known to need a browser", nextAction: "" }, decision.crawlDelayMs, "skipped (host known to need a browser)");
      const html = fetchedText(fetched);
      const signals = licenceSignals(fetched.headers, html);
      const updated = freshness(fetched.headers, html);
      const doc = await this.toDoc(url, fetched, { robots: robotsLine, licence: signals });
      doc.updated = updated.date ? updated : undefined;
      if (!doc.markdown.trim()) throw new FetchError(`Rendered ${url} but extracted no readable content.`);
      this.cache.setPage({ url, finalUrl: doc.finalUrl, title: doc.title, source: doc.source, markdown: doc.markdown, etag: null, lastModified: null, licence: signals.length ? signals.join(" | ") : null, updated: doc.updated ?? null });
      return doc;
    }

    const r = await this.politeness.run(host, () => this.transport.get(url, { conditional, source: "direct", beforeCrossHostRedirect }), decision.crawlDelayMs);

    if (r.notModified && cached) {
      this.cache.touchPage(url);
      return { url, finalUrl: cached.finalUrl, title: cached.title, source: `cache (revalidated) ← ${cached.source}`, markdown: cached.markdown, note: "", robots: robotsLine, licence: cached.licence ? cached.licence.split(" | ") : [], cached: true, updated: cached.updated ?? undefined };
    }

    if (opts.raw) {
      return { url, finalUrl: r.finalUrl, title: "", source: `raw (${r.kind}, HTTP ${r.status})`, markdown: fetchedText(r), note: "", robots: robotsLine, licence: licenceSignals(r.headers), cached: false };
    }

    let html = r.kind === "html" ? fetchedText(r) : undefined;
    const shell = html ? detectShell(html) : false;
    const dx = diagnose(r, { isShell: shell });
    let fetched: Fetched = r;
    if (dx) {
      if (dx.kind === "not_found") this.gone.add(url);
      if (!BROWSER_RETRY_KINDS.has(dx.kind) || !this.browser?.enabled()) throw new DiagnosedError(url, dx);
      // One honest browser attempt: the plain client was refused or got a JS shell.
      fetched = await this.renderWithBrowser(url, host, dx, decision.crawlDelayMs);
      html = fetchedText(fetched);
      // Remember that this host needs a browser, so the next read skips the plain attempt (still
      // the same identity and rules — just the right client first).
      this.cache.setNeedsBrowser(host);
    }

    // Content-Signal response header: ai-input=no → do not hand the page to the model (unless policy is minimal).
    const cs = parseContentSignal(fetched.headers["content-signal"]);
    if (cs?.aiInput === false && this.settings.robotsPolicy !== "minimal" && this.settings.robotsPolicy !== "off") {
      this.audit.record({ url, status: fetched.status, note: `Content-Signal ai-input=no (${cs.raw}); content withheld` });
      throw new DiagnosedError(url, diagnoseContentSignal("HTTP header", cs.raw));
    }

    const signals = licenceSignals(fetched.headers, html);
    const lic = knownLicence(new URL(fetched.finalUrl).hostname);
    if (lic) signals.push(lic);
    const linkHdr = fetched.headers["link"] ?? "";
    const llmsLink = /<([^>]+)>;[^,]*rel="?llms-txt"?/i.exec(linkHdr)?.[1] ?? fetched.headers["x-llms-txt"];
    const updated = freshness(fetched.headers, html);
    let doc = await this.toDoc(url, fetched, { robots: robotsLine, licence: signals });
    doc.updated = updated.date ? updated : undefined;
    if (llmsLink) doc.note = `Note: this site advertises an agent index at ${new URL(llmsLink, fetched.finalUrl).toString()}.`;

    // Root pages of docs sites: llms.txt is usually a far better index than the HTML home.
    const depth = new URL(url).pathname.split("/").filter(Boolean).length;
    if (depth <= 1) {
      const llms = await llmsTxt(url, this.http("llms.txt")).catch(() => null);
      if (llms) {
        const origin = new URL(url).origin;
        if (depth === 0 || doc.markdown.trim().length < 500) {
          doc = { ...doc, title: doc.title || "llms.txt", source: "llms.txt", markdown: llms.endsWith("\n") ? llms : llms + "\n" };
        } else {
          doc.note = `Note: this site publishes ${origin}/llms.txt (an agent-friendly index of its docs).`;
        }
      }
    }

    if (!doc.markdown.trim()) throw new FetchError(`Fetched ${url} but extracted no readable content (source: ${doc.source}).`);

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
   * The browser tier. Same robots decision, same host queue (browser fetches cost two budget units).
   * If the rendered page is itself a challenge/login/paywall/shell, the refusal is final.
   */
  private async renderWithBrowser(url: string, host: string, plain: Diagnosis, crawlDelayMs?: number, directLabel?: string): Promise<Fetched> {
    const attempts = [`direct: ${directLabel ?? plain.kind}`];
    try {
      this.politeness.charge();
      this.politeness.charge();
    } catch (e) {
      if (e instanceof BudgetExceeded) throw new DiagnosedError(url, diagnoseBudget(e.message));
      throw e;
    }
    let rendered;
    try {
      rendered = await this.politeness.run(host, () => this.browser!.render(url, { session: this.settings.browserSession, handoff: true }), crawlDelayMs);
    } catch (e) {
      if (e instanceof BrowserUnavailable) {
        this.audit.log("warn", `browser tier unavailable: ${e.message}`);
        throw new DiagnosedError(url, { ...plain, attempts: [...attempts, `browser: unavailable (${e.message})`] });
      }
      if (e instanceof BlockedURL) throw e;
      throw new DiagnosedError(url, { ...plain, attempts: [...attempts, `browser: error (${(e as Error).message.split("\n")[0]})`] });
    }
    const f: Fetched = {
      url,
      finalUrl: rendered.finalUrl,
      kind: "html",
      body: rendered.html,
      source: [rendered.salvaged ? "browser (partial render)" : "browser", rendered.handedOff ? "challenge passed by you" : "", rendered.usedSession ? "your session" : ""].filter(Boolean).join(", "),
      status: rendered.status,
      contentType: "text/html",
      headers: {},
    };
    const shell = detectShell(rendered.html);
    const dx = diagnose(f, { isShell: shell });
    if (dx) throw new DiagnosedError(url, finalizeAfterBrowser(dx, [...attempts, `browser: ${dx.kind}`]));
    return f;
  }

  /** Wayback Machine, only for pages the live site reports gone. Never a bypass for blocks. */
  private async fromArchive(url: string): Promise<PageDoc> {
    if (!this.gone.has(url)) {
      // Verify the live page is actually gone first; a blocked page stays blocked.
      try {
        const live = await this.fetch(url);
        return { ...live, note: (live.note ? live.note + " " : "") + "The live page is available; archive not used." };
      } catch (e) {
        if (!(e instanceof DiagnosedError) || e.diagnosis.kind !== "not_found") throw e;
      }
    }
    const avail = await this.http("archive")(`https://archive.org/wayback/available?url=${encodeURIComponent(url)}`, { headers: { accept: "application/json" } });
    if (avail.status !== 200) throw new FetchError(`Wayback availability API returned HTTP ${avail.status}.`);
    const data = (await avail.json()) as { archived_snapshots?: { closest?: { url: string; timestamp: string } } };
    const snap = data.archived_snapshots?.closest;
    if (!snap) throw new FetchError("No archived snapshot exists for this URL.");
    const rawUrl = snap.url.replace(`/web/${snap.timestamp}/`, `/web/${snap.timestamp}id_/`);
    const decision = await this.robots.check(rawUrl);
    if (!decision.allowed) throw new DiagnosedError(rawUrl, diagnoseRobots(decision.reason ?? "disallowed"));
    this.politeness.charge();
    const r = await this.politeness.run("web.archive.org", () => this.transport.get(rawUrl, { source: `archive (${snap.timestamp.slice(0, 8)})` }));
    if (r.status !== 200) throw new FetchError(`Archive snapshot returned HTTP ${r.status}.`);
    const doc = await this.toDoc(url, { ...r, url, finalUrl: url }, { robots: "allowed (web.archive.org)" });
    return { ...doc, note: `Archived copy from ${snap.timestamp.slice(0, 4)}-${snap.timestamp.slice(4, 6)}-${snap.timestamp.slice(6, 8)}; the live page reported 404/410.` };
  }
}
