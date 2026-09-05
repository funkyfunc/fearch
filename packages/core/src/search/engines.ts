/**
 * Search-engine result pages opened in the browser tier.
 *
 * Eligibility is where the dials meet: an engine is only used if it is listed in --engines *and*
 * either its robots.txt permits its result pages (DuckDuckGo lite does: `/lite/`) or a person is
 * present — a visible browser (headed or extension) with handoff on, where the result page is the
 * person's own browsing rather than a crawl (Google's `Disallow: /search` governs unattended
 * crawlers, not a browser someone oversees). Robots-permitted engines are still verified live before
 * every request.
 *
 * Engine pages are never opened headless: the person's own Chrome via the extension, or a background
 * window of the installed Chrome with the tool profile. One page per search call, ≥3 s between
 * requests to an engine. A challenge page is the engine's "no": the person is asked whether to see
 * it and may pass it themselves — the tool never does; where nobody can be asked, the provider stops
 * and cools down.
 */

import * as cheerio from "cheerio";
import type { AnyNode } from "domhandler";
import { mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { localeParts, personPresent, type Settings } from "../config.js";
import type { BrowserTier } from "../fetch/browser.js";
import type { RobotsChecker } from "../fetch/robots.js";
import type { Politeness } from "../politeness.js";
import {
  dedupe,
  filterDomains,
  RateLimited,
  SearchError,
  type EngineSummary,
  type Recency,
  type SearchOptions,
  type SearchProvider,
  type SearchResponse,
  type SearchQuery,
  type SearchResult,
} from "./provider.js";

export interface EngineSpec {
  name: string;
  label: string;
  host: string;
  /** Does the engine's own robots.txt permit the result page we open? (Checked live too.) */
  robotsPermitted: boolean;
  /** What the engine says about queries (shown in the disclosure). */
  privacy: string;
  url(query: string, recency?: Recency, locale?: string): string;
  parse(html: string, provider: string): SearchResult[];
  /** Same shape as the generic `isChallengePage`, so the browser tier can take it as-is. */
  isChallenge(html: string, status: number, url?: string): boolean;
  /** The engine's own "nothing matched" page — an answer, not a parser failure. */
  noResults: RegExp;
  /**
   * "You press search": the engine's home page with the query prefilled but not submitted, and how to
   * recognise the results page the person lands on. Only for engines whose result pages are not
   * robots-permitted — the ones where the person's own hand on the query is the point.
   */
  human?: { homeUrl(query: string, locale?: string): string; resultsUrl: RegExp };
  /** Selector that exists on a real results page; the browser waits for it before judging the page. */
  resultsSelector: string;
  /** Extract the engine's own generated answer box, if the page carries one. */
  overview?(html: string): Omit<EngineSummary, "provider"> | null;
}

const skipHost = (url: string, ...hosts: RegExp[]): boolean => {
  try {
    const h = new URL(url).hostname;
    return hosts.some((re) => re.test(h));
  } catch {
    return true;
  }
};

// ---------------------------------------------------------------- DuckDuckGo lite

export const DDG_LITE = "https://lite.duckduckgo.com/lite/";

/** DDG's region-lang code for a locale ("de-DE" → "de-de", "en-GB" → "uk-en"); worldwide without a region. */
export function ddgRegion(locale = "en-US"): string {
  const { lang, region } = localeParts(locale);
  if (!region) return "wt-wt";
  const r = region.toLowerCase();
  return `${r === "gb" ? "uk" : r}-${lang}`;
}

function unwrapDdg(href: string): string {
  try {
    const u = new URL(href, "https://duckduckgo.com");
    const uddg = u.searchParams.get("uddg");
    if (u.pathname.startsWith("/l/") && uddg) return decodeURIComponent(uddg);
    return u.toString();
  } catch {
    return href;
  }
}

/** Parse a DDG lite results page: link rows followed by snippet rows in one table. */
export function parseLite(html: string, provider: string): SearchResult[] {
  const $ = cheerio.load(html);
  const out: SearchResult[] = [];
  $("a.result-link").each((_, a) => {
    const url = unwrapDdg($(a).attr("href") ?? "");
    if (!/^https?:/.test(url) || skipHost(url, /(^|\.)duckduckgo\.com$/)) return;
    const row = $(a).closest("tr");
    const snippet = row.next("tr").find(".result-snippet").text().replace(/\s+/g, " ").trim();
    out.push({ title: $(a).text().trim(), url, snippet, provider });
  });
  return out;
}

/**
 * Challenge detectors must not fire on a normal results page (engine scripts mention "challenge";
 * a false positive would hand a good page to the person and wait). Rule: a definitive status, or a
 * challenge marker *and* no parsed results.
 */
export function ddgChallenge(html: string, status: number): boolean {
  return (
    status === 202 || (!/class="result-link"/.test(html) && /anomaly|challenge|captcha|unusual traffic/i.test(html))
  );
}

/**
 * Google's check lives at /sorry/…; once passed, the browser lands on a results page with <h3>
 * headings whose source still mentions "sorry" in scripts — so the URL and the presence of results
 * decide, not strings in the source (a real results page must never count as a challenge, or the
 * handoff would wait forever after the person has passed it).
 */
const googleChallenge = (html: string, status: number, url = ""): boolean => {
  if (/\/sorry\//.test(url)) return true;
  if (/<h3/.test(html)) return false;
  return status === 429 || /unusual traffic from your computer network|not a robot|recaptcha/i.test(html);
};

// ---------------------------------------------------------------- Google

function unwrapGoogle(href: string): string {
  try {
    const u = new URL(href, "https://www.google.com");
    if (u.pathname === "/url") return u.searchParams.get("q") ?? u.searchParams.get("url") ?? u.toString();
    return u.toString();
  } catch {
    return href;
  }
}

const GOOGLE_OWN = [
  /(^|\.)google\.[a-z.]+$/,
  /(^|\.)googleusercontent\.com$/,
  /(^|\.)gstatic\.com$/,
  /(^|\.)youtube\.com$/,
];

/** Google's display URL ("https://host › a › b") back to a URL; lossy for query strings, used only as a fallback. */
function fromCite(text: string): string {
  const t = text.replace(/\s+/g, " ").trim();
  if (!t) return "";
  const m = /^(https?:\/\/[^\s›]+)((?:\s*›\s*[^\s›]+)*)/.exec(t);
  if (!m) return "";
  return (
    m[1] +
    m[2]
      .split("›")
      .map((s) => s.trim())
      .filter(Boolean)
      .map((s) => "/" + s.replace(/\.\.\.$/, ""))
      .join("")
  );
}

/**
 * Google, 2026 layout (measured 2026-08-29 on a real results page): each organic result is an
 * `<h3>` inside `<a class="zReHs" href="/goto?url=<opaque token>">` — the href no longer carries the
 * destination — with the display URL in `<cite>`. The page also embeds, per result, a JSON array
 * `["<url>","<title>","<snippet>",1,"en","US",…]` which is the most reliable source of all three, so
 * results are read from the DOM (order, titles) and joined to the JSON by title; the `<cite>` display
 * URL is the fallback when no JSON entry matches. Older `<a href="https://…"><h3>` markup still parses.
 */
export function parseGoogle(html: string, provider: string): SearchResult[] {
  const $ = cheerio.load(html);
  const out: SearchResult[] = [];
  const seen = new Set<string>();
  const add = (url: string, title: string, snippet: string) => {
    if (!title || !/^https?:/.test(url) || skipHost(url, ...GOOGLE_OWN) || seen.has(url)) return;
    seen.add(url);
    out.push({ title, url, snippet: snippet.replace(/\s+/g, " ").trim().slice(0, 300), provider });
  };
  // Embedded per-result JSON: url, title, snippet.
  const embedded: { url: string; title: string; snippet: string }[] = [];
  for (const m of html.matchAll(
    /\["(https?:\/\/[^"\\]+)","((?:[^"\\]|\\.)*)","((?:[^"\\]|\\.)*)",\d+,"[a-z]{2}","[A-Z]{2}"/g,
  )) {
    embedded.push({ url: m[1], title: unescapeJson(m[2]), snippet: unescapeJson(m[3]) });
  }
  const norm = (s: string) => s.replace(/\s+/g, " ").trim().toLowerCase();
  const byTitle = (title: string) => {
    const t = norm(title).replace(/\s*(\.\.\.|…)$/, "");
    return (
      embedded.find((e) => norm(e.title) === t) ??
      embedded.find((e) => norm(e.title).startsWith(t) || t.startsWith(norm(e.title)))
    );
  };

  $("h3").each((_, h) => {
    const title = $(h).text().trim();
    const a = $(h).closest("a");
    const block = $(h).closest("div[data-snf], div.yuRUbf, div.g, div[data-hveid]");
    const hrefUrl = unwrapGoogle(a.attr("href") ?? "");
    const hit = byTitle(title);
    const url =
      /^https?:/.test(hrefUrl) && !/\/goto\?/.test(hrefUrl)
        ? hrefUrl
        : (hit?.url ??
          fromCite(block.find("cite").first().text() || $(h).parent().parent().find("cite").first().text()));
    const snippetSel = "div[data-sncf], .VwiC3b, [data-content-feature]";
    const domSnippet =
      block.find(snippetSel).first().text() ||
      block.next().find(snippetSel).first().text() ||
      block.next().filter(snippetSel).text();
    add(url, title, hit?.snippet || domSnippet || "");
  });
  // Nothing in the DOM at all (unexpected layout): fall back to the embedded JSON alone, in page order.
  if (!out.length) for (const e of embedded) add(e.url, e.title, e.snippet);
  return out;
}

function unescapeJson(s: string): string {
  try {
    return JSON.parse(`"${s}"`) as string;
  } catch {
    return s;
  }
}

/**
 * Google's AI Overview / AI Mode reply, when the results page carries one. The markup is volatile and
 * A/B-tested, so the anchor is the stable container id (`#m-x-content`) with a text-marker fallback;
 * hidden elements are dropped first — every overview region carries "not available" fallback spans
 * with display:none, which must not be mistaken for content (or vice versa).
 */
export function parseGoogleOverview(html: string): Omit<EngineSummary, "provider"> | null {
  const $ = cheerio.load(html);
  let region: cheerio.Cheerio<AnyNode> = $("#m-x-content").first();
  if (!region.length) {
    // "AI Overview" or "AI Mode reply for …" mark a real overview region; the bare "AI Mode" TAB in
    // the results-page navigation must not (it would make the tab bar the "overview").
    const marker = $("div, span, h1, h2").filter(
      (_, e) => $(e).children().length === 0 && /^(AI Overview|AI Mode reply)/.test($(e).text().trim()),
    );
    if (!marker.length) return null;
    region = marker.first().closest("div[id], div[jscontroller]");
  }
  if (!region.length) return null;
  region
    .find("style, script, svg, noscript, [aria-hidden=true], [style*='display:none'], [style*='display: none']")
    .remove();

  const sources: EngineSummary["sources"] = [];
  const seen = new Set<string>();
  const ownHosts = GOOGLE_OWN.filter((re) => !re.source.includes("youtube"));
  region.find("a[href^='http']").each((_, a) => {
    const url = unwrapGoogle($(a).attr("href") ?? "");
    if (!/^https?:/.test(url) || skipHost(url, ...ownHosts) || seen.has(url)) return;
    seen.add(url);
    sources.push({ title: $(a).text().replace(/\s+/g, " ").trim() || new URL(url).hostname, url });
  });

  // cheerio's .text() joins adjacent elements without whitespace ("apiA REST"); prepending a space
  // to every tag before extracting keeps element boundaries as word boundaries.
  const spaced = cheerio
    .load(`<x>${(region.html() ?? "").replace(/</g, " <")}</x>`)("x")
    .text();
  const text = spaced
    .replace(/\s+/g, " ")
    .replace(/^(\s*AI (Overview\b|Mode reply for [^A-Z]*))+\s*/, "")
    // Everything from the disclaimer on is Google's UI (export buttons, dialogs), not the answer.
    .replace(/\s*AI can make mistakes[\s\S]*$/, "")
    .replace(/\s*(Save to Google (Drive|Gmail)|When you export,[^.]*\.|Got it|Transcribing\.\.\.)/g, "")
    .replace(/Shared?\s*\d+\s*files?\s*$/, "")
    .replace(/Show (more|all)\s*$/i, "")
    .trim();
  if (text.length < 80 || /^(An AI Overview is not available|Can't generate|All Web Images)/.test(text)) return null;
  return { text: text.slice(0, 2500), sources: sources.slice(0, 10) };
}

// ---------------------------------------------------------------- specs

export const ENGINE_SPECS: Record<string, EngineSpec> = {
  duckduckgo: {
    name: "duckduckgo",
    label: "DuckDuckGo lite",
    host: "lite.duckduckgo.com",
    robotsPermitted: true,
    privacy: "DDG does not log searches",
    url: (q, r, loc) => `${DDG_LITE}?q=${encodeURIComponent(q)}&kl=${ddgRegion(loc)}${r ? `&df=${r}` : ""}`,
    parse: parseLite,
    isChallenge: ddgChallenge,
    noResults: /No (more )?results\./i,
    resultsSelector: "a.result-link",
  },
  google: {
    name: "google",
    label: "Google",
    host: "www.google.com",
    robotsPermitted: false,
    privacy: "queries are logged by Google, tied to whichever Google session the browser profile holds",
    url: (q, r, loc = "en-US") => {
      const { lang, region } = localeParts(loc);
      return `https://www.google.com/search?q=${encodeURIComponent(q)}&hl=${lang}${region ? `&gl=${region.toLowerCase()}` : ""}&num=10${r ? `&tbs=qdr:${r}` : ""}`;
    },
    parse: parseGoogle,
    isChallenge: googleChallenge,
    noResults: /did not match any documents|No results found for/i,
    resultsSelector: "a h3",
    overview: parseGoogleOverview,
    human: {
      // The home page with ?q= prefills the box without searching (measured 2026-09-01); Enter submits.
      homeUrl: (q, loc = "en-US") => `https://www.google.com/?q=${encodeURIComponent(q)}&hl=${localeParts(loc).lang}`,
      resultsUrl: /\/search\?/,
    },
  },
};

export class EngineProvider implements SearchProvider {
  readonly name: string;
  readonly label: string;
  readonly posture: SearchProvider["posture"] = "browser";
  /** Result pages the engine's robots.txt does not permit: opened only as the person's own act. */
  readonly needsPerson: boolean;
  /** The profile choice the last query ran with, for the disclosure line. */
  private lastIncognito: boolean | undefined;

  constructor(
    readonly spec: EngineSpec,
    private readonly settings: Settings,
    private readonly browser: BrowserTier,
    private readonly robots: RobotsChecker,
    private readonly politeness: Politeness,
    private readonly gapMs = 3000,
  ) {
    this.name = spec.name;
    this.label = spec.label;
    this.needsPerson = !spec.robotsPermitted;
  }

  /** One line, once per response: which browser opened the page, on whose authority, and who logs it. */
  get disclosure(): string {
    const ch = this.browser.browserChannel;
    const incognito = this.lastIncognito ?? this.settings.incognito;
    const how =
      ch === "extension"
        ? incognito
          ? "your own Chrome, incognito"
          : "your own Chrome, your profile"
        : ch === "auto"
          ? `a background window of your installed Chrome (${incognito ? "fresh incognito context" : "tool profile"}; a check brings it forward for you)`
          : this.settings.browser === "headed"
            ? "the visible browser window"
            : "a browser window";
    const robots = this.spec.robotsPermitted ? "robots.txt permits" : "each query approved or submitted by you";
    return `${this.spec.label} via ${how} — ${robots}; ${this.spec.privacy}`;
  }

  /**
   * A query on this engine needs the person's act: always for an engine whose result pages are not
   * robots-permitted (Google), and for every engine with `--human-search`. The registry asks through
   * the client first; when nobody can be asked that way, the search box is handed over in the browser.
   */
  private get needsApproval(): boolean {
    return this.needsPerson || this.settings.humanSearch;
  }

  /** Listed in --engines, browser on, and robots-eligible. */
  available(): boolean {
    return this.browser.enabled() && this.settings.engines.includes(this.name) && this.eligible();
  }

  /**
   * An engine page is opened only in a browser a person could see — their own Chrome, or a window of
   * the installed Chrome (background until a check needs them) — never headless. So a display (or the
   * extension) is needed for any engine; Google additionally needs the person on call for its checks.
   */
  eligible(): boolean {
    return this.settings.canSurface && (this.spec.robotsPermitted || personPresent(this.settings));
  }

  /** Why a listed engine is not used, for `doctor`. */
  ineligibleReason(): string | null {
    if (!this.settings.engines.includes(this.name)) return null;
    if (!this.browser.enabled()) return "browser tier is off";
    if (!this.settings.canSurface)
      return "engine result pages open in a real browser window, never headless, and no browser window can be shown here (headless mode, or no display)";
    if (!this.eligible())
      return `${this.spec.host} disallows result pages for crawlers; eligible when a person is on call to pass its checks (a display, handoff on)`;
    return null;
  }

  async search(q: SearchQuery, opts: SearchOptions = {}): Promise<SearchResponse> {
    const query = q.site ? `${q.query} site:${q.site}` : q.query;
    // The person approved (and may have edited) the query in their client: it runs as their
    // submission. Where nobody could be asked that way and the engine needs their act, the engine's
    // home page is handed over in the browser with the query in the box and the person presses Enter.
    const submittedByPerson = !!opts.submittedByPerson;
    const human = this.needsApproval && !submittedByPerson && this.spec.human ? this.spec.human : null;
    this.lastIncognito = opts.incognito;
    // (Recency has no place in a query the person submits by hand; the engine's UI applies it if at all.)
    const url = human
      ? human.homeUrl(query, this.settings.locale)
      : this.spec.url(query, q.recency, this.settings.locale);
    const ready = (html: string, at: string) =>
      human!.resultsUrl.test(at) &&
      !this.spec.isChallenge(html, 200, at) &&
      (cheerio.load(html)(this.spec.resultsSelector).length > 0 || this.spec.noResults.test(html));
    // Robots-permitted engines are verified live (the permission could have been withdrawn). Engines
    // eligible through the person-present rule are the person's own browsing — the crawler rules
    // don't apply, so robots.txt is not consulted for their result pages.
    let crawlDelayMs = 0;
    if (this.spec.robotsPermitted) {
      const decision = await this.robots.check(url);
      if (!decision.allowed)
        throw new SearchError(
          `${this.name}: robots.txt disallows ${url.split("?")[0]} (${decision.reason ?? "disallowed"})`,
        );
      crawlDelayMs = decision.crawlDelayMs ?? 0;
    }
    let rendered;
    try {
      rendered = await this.politeness.run(
        this.spec.host,
        () =>
          this.browser.render(url, {
            session: true,
            handoff: true,
            incognito: opts.incognito,
            isChallenge: this.spec.isChallenge,
            handToPerson: human
              ? {
                  message: `Your query is filled into ${this.spec.label}'s search box — press Enter there to run it yourself.`,
                  ready,
                }
              : undefined,
            settleSelector: human ? undefined : this.spec.resultsSelector,
            // Generated answer boxes stream in after the results; wait briefly for one that is coming,
            // never for one that isn't (no marker on the page).
            settleUntil: this.spec.overview
              ? (html) => !/AI Overview/.test(html) || this.spec.overview!(html) !== null
              : undefined,
            settleUntilMs: 2500,
          }),
        Math.max(this.gapMs, crawlDelayMs),
      );
    } catch (e) {
      throw new SearchError(`${this.name}: browser error (${(e as Error).message.split("\n")[0]})`);
    }
    if (human && !rendered.handedOff) {
      // The tab/window was closed when the render returned: there is nothing left to press Enter in.
      throw new SearchError(
        `${this.name}: the query was opened in ${rendered.handoffWhere ?? "your browser"} but not submitted within ${Math.round(this.settings.handoffTimeoutMs / 1000)} s, so that tab was closed — search again when you are at the screen and press Enter there`,
      );
    }
    if (submittedByPerson) rendered = { ...rendered, handedOff: true, handoffWhere: "your MCP client" };
    if (this.spec.isChallenge(rendered.html, rendered.status, rendered.finalUrl)) {
      // The engine's "no". The registry decides whether that means a cooldown (nobody can be asked)
      // or just this answer (a person is on call and will be asked again next time).
      const at = new Date().toISOString().slice(11, 16) + " UTC";
      const hint = !this.settings.handoff
        ? "handoff is disabled (--no-handoff); with it on you would be handed the page to pass yourself"
        : rendered.handoff === "declined"
          ? "you declined to open it"
          : rendered.handoffWhere
            ? `it was opened in ${rendered.handoffWhere} at ${at} but not passed in time — pass it there and search again`
            : this.settings.canSurface
              ? "the last check went unanswered, so it was not handed to you again yet"
              : "no browser window can be shown in this environment; run fearch where one can appear (or pair the extension) to pass it yourself";
      throw new RateLimited(
        `${this.name}: ${this.spec.label} showed its bot-check page (HTTP ${rendered.status}); ${hint}`,
      );
    }
    const parsed = this.spec.parse(rendered.html, this.name);
    const results = filterDomains(dedupe(parsed), q);
    if (!parsed.length) {
      // An empty results page is an answer; a page with results we cannot read is a parser problem.
      if (this.spec.noResults.test(rendered.html)) throw new SearchError(`${this.name}: no results for this query`);
      const dump = this.dumpUnparsed(rendered.html);
      throw new SearchError(
        `${this.name}: no results parsed (markup may have changed${dump ? `; page saved to ${dump} for debugging` : "; run with --log-level debug to save the page"})`,
      );
    }
    if (!results.length) throw new SearchError(`${this.name}: no results matched the domain filters`);
    const overview = this.spec.overview?.(rendered.html);
    return {
      results: results.slice(0, q.maxResults),
      summary: overview ? { ...overview, provider: this.name } : undefined,
    };
  }

  /**
   * Keep the last few pages that produced no results, so a markup change can be diagnosed from disk.
   * Only at debug level: an engine page opened in the person's own profile carries their account
   * chrome, so it is never written by default and the account header and any e-mail are removed.
   */
  private dumpUnparsed(html: string): string | null {
    if (this.settings.logLevel !== "debug") return null;
    try {
      const dir = join(this.settings.cacheDir, "debug");
      mkdirSync(dir, { recursive: true });
      const old = readdirSync(dir)
        .filter((f) => f.startsWith(`${this.name}-`))
        .sort();
      for (const f of old.slice(0, Math.max(0, old.length - 2))) rmSync(join(dir, f), { force: true });
      const path = join(dir, `${this.name}-${new Date().toISOString().replace(/[:.]/g, "-")}.html`);
      writeFileSync(path, redactAccount(html));
      return path;
    } catch {
      return null;
    }
  }
}

/** Strip the signed-in account chrome and any e-mail addresses from an engine page before it touches disk. */
export function redactAccount(html: string): string {
  return html
    .replace(/<header[\s\S]*?<\/header>/gi, "<!-- header removed -->")
    .replace(/[\w.+-]+@[\w-]+(\.[\w-]+)+/g, "[redacted-email]");
}

/** All known engines, in --engines order first, then the rest (unlisted ones are never available). */
export function engineProviders(
  settings: Settings,
  browser: BrowserTier,
  robots: RobotsChecker,
  politeness: Politeness,
): EngineProvider[] {
  const order = [...settings.engines, ...Object.keys(ENGINE_SPECS).filter((n) => !settings.engines.includes(n))];
  return order.map((n) => new EngineProvider(ENGINE_SPECS[n], settings, browser, robots, politeness));
}
