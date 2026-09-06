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
import { HandoffPending, type BrowserTier, type Rendered } from "../fetch/browser.js";
import type { RobotsChecker } from "../fetch/robots.js";
import type { Politeness } from "../politeness.js";
import {
  dedupe,
  filterDomains,
  RateLimited,
  SearchCheckRequired,
  SearchError,
  type EngineSummary,
  type Parsed,
  type Recency,
  type SearchOptions,
  type SearchProvider,
  type SearchResponse,
  type SearchQuery,
  type SearchResult,
} from "./provider.js";
import { overviewPending, parseGoogleOverview } from "./overview.js";
import { parseByShape, resultsPageMarkdown } from "./shape.js";

/** How long a results page may keep streaming its generated answer before the page is read as is. */
const OVERVIEW_WAIT_MS = 8000;
/** Fewer results than this from the engine's own parser, and the page's shape is consulted too. */
const MIN_FIRST_CLASS = 3;

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
  /** The engine's own "nothing matched" page — an answer, not a parser failure; absent for an engine that always answers. */
  noResults?: RegExp;
  /**
   * "You press search": the engine's home page with the query prefilled but not submitted, and how to
   * recognise the results page the person lands on. Only for engines whose result pages are not
   * robots-permitted — the ones where the person's own hand on the query is the point.
   */
  human?: { homeUrl(query: string, locale?: string): string; resultsUrl: RegExp };
  /** Selector that exists on a real results page; the browser waits for it before judging the page. */
  resultsSelector: string;
  /** The engine's own generated answer on the page, if any (see overview.ts). */
  overview?(html: string, query: string): Omit<EngineSummary, "provider"> | null;
  /**
   * A plainer results page of the same query (Google's "Web" tab, `udm=14`): requested once when
   * the default page could not be parsed at all, before the page is handed over as markdown.
   */
  plainUrl?(query: string, recency?: Recency, locale?: string): string;
  /** True while that answer is still streaming in, so the render waits a little longer for it. */
  overviewPending?(html: string): boolean;
  /** How long the render may wait for that answer; AI Mode streams longer than an overview. */
  overviewWaitMs?: number;
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
 * Google results, in every layout seen so far (classic 2026-08-29; Web Guide 2026-09-05). A result
 * is a heading inside a link: `<a><h3>` on the classic page, `<a><div role=heading aria-level=3>` in
 * Web Guide (which has no h3 at all — the first version of this parser read "no results" there).
 * Headings inside lists are carousels and generated-answer citations, not results. The page also
 * embeds, per organic result, a JSON row `["<url>","<title>","<snippet>",1,"en","US",…]` — the most
 * reliable snippet, joined by URL (or by title where the href is an opaque `/goto` token).
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
  const embedded: { url: string; title: string; snippet: string }[] = [];
  for (const m of html.matchAll(
    /\["(https?:\/\/[^"\\]+)","((?:[^"\\]|\\.)*)","((?:[^"\\]|\\.)*)",\d+,"[a-z]{2}","[A-Z]{2}"/g,
  )) {
    embedded.push({ url: m[1], title: unescapeJson(m[2]), snippet: unescapeJson(m[3]) });
  }
  const norm = (s: string) => s.replace(/\s+/g, " ").trim().toLowerCase();
  const sameUrl = (a: string, b: string) =>
    a.replace(/[#?].*$/, "").replace(/\/$/, "") === b.replace(/[#?].*$/, "").replace(/\/$/, "");
  const byTitle = (title: string) => {
    const t = norm(title).replace(/\s*(\.\.\.|…)$/, "");
    return (
      embedded.find((e) => norm(e.title) === t) ??
      embedded.find((e) => norm(e.title).startsWith(t) || t.startsWith(norm(e.title)))
    );
  };

  $("a h3, a [role=heading]").each((_, h) => {
    if ($(h).closest("li, [role=listitem], [role=list]").length) return;
    const title = $(h).text().replace(/\s+/g, " ").trim();
    const a = $(h).closest("a");
    const block = $(h).closest("div[data-snf], div.yuRUbf, div.g, div[data-hveid]");
    const hrefUrl = unwrapGoogle(a.attr("href") ?? "");
    const direct = /^https?:/.test(hrefUrl) && !/\/goto\?/.test(hrefUrl);
    const hit = (direct && embedded.find((e) => sameUrl(e.url, hrefUrl))) || byTitle(title);
    const url = direct
      ? hrefUrl
      : (hit?.url ?? fromCite(block.find("cite").first().text() || $(h).parent().parent().find("cite").first().text()));
    const snippetSel = "div[data-sncf], .VwiC3b, [data-content-feature]";
    const domSnippet =
      block.find(snippetSel).first().text() ||
      block.next().find(snippetSel).first().text() ||
      block.next().filter(snippetSel).text() ||
      cardSnippet($, a, title);
    add(url, title, hit?.snippet || domSnippet || "");
  });
  // Nothing in the DOM at all (unexpected layout): fall back to the embedded JSON alone, in page order.
  if (!out.length) for (const e of embedded) add(e.url, e.title, e.snippet);
  return out;
}

/**
 * AI Mode's citations: the external links of the reply, in order, each with the text it is attached
 * to as the snippet. They are results in the sense that matters — the pages the answer rests on.
 */
export function parseAiModeCitations(html: string, provider: string): SearchResult[] {
  const $ = cheerio.load(html);
  const out: SearchResult[] = [];
  const seen = new Set<string>();
  $("a[href]").each((_, a) => {
    const url = unwrapGoogle($(a).attr("href") ?? "");
    if (!/^https?:/.test(url) || skipHost(url, ...GOOGLE_OWN) || seen.has(url)) return;
    const card = $(a).closest("li, [role=listitem], div");
    const title =
      $(a).find("h3, [role=heading]").first().text().replace(/\s+/g, " ").trim() ||
      $(a).text().replace(/\s+/g, " ").trim() ||
      new URL(url).hostname;
    if (title.length < 4) return;
    seen.add(url);
    const snippet = card.text().replace(/\s+/g, " ").replace(title, "").trim().slice(0, 300);
    out.push({ title: title.slice(0, 200), url, snippet, provider });
  });
  return out;
}

/** AI Mode streams its reply first and its citations later: the page is done when both are there. */
function aiModePending(html: string): boolean {
  if (overviewPending(html)) return true;
  return !/AI Mode reply for/.test(html) || parseAiModeCitations(html, "google-ai").length === 0;
}

/**
 * Web Guide draws each result as a card: source name, display URL, date, and a one-line description
 * of its own. The description is the text of the card that is not the title or the display URL.
 */
function cardSnippet($: cheerio.CheerioAPI, a: cheerio.Cheerio<AnyNode>, title: string): string {
  const card = a.parent().parent();
  if (!card.length) return "";
  const runs = card
    .find("*")
    .toArray()
    .filter((e) => $(e).children().length === 0)
    .map((e) => $(e).text().replace(/\s+/g, " ").trim())
    .filter((t) => t.length >= 25 && t !== title && !/›|^https?:/.test(t));
  return runs.sort((x, y) => y.length - x.length)[0] ?? "";
}

function unescapeJson(s: string): string {
  try {
    return JSON.parse(`"${s}"`) as string;
  } catch {
    return s;
  }
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
    resultsSelector: "a h3, a [role=heading]",
    overview: parseGoogleOverview,
    overviewPending,
    plainUrl: (q, r, loc = "en-US") => `${ENGINE_SPECS.google.url(q, r, loc)}&udm=14`,
    human: {
      // The home page with ?q= prefills the box without searching (measured 2026-09-01); Enter submits.
      homeUrl: (q, loc = "en-US") => `https://www.google.com/?q=${encodeURIComponent(q)}&hl=${localeParts(loc).lang}`,
      resultsUrl: /\/search\?/,
    },
  },
  /**
   * Google's AI Mode (`udm=50`, measured 2026-09-06): the same `/search` page family under the same
   * posture as Google result pages — listed by the operator, every query approved in the client, run
   * as the person's browsing. The page is a generated reply with the pages it cites; the reply is the
   * summary, the citations are the results. One question per search call, never a follow-up: fearch
   * asks, it does not converse. The citations load after the reply, so the render waits for them.
   */
  "google-ai": {
    name: "google-ai",
    label: "Google AI Mode",
    host: "www.google.com",
    robotsPermitted: false,
    privacy: "queries are logged by Google, tied to whichever Google session the browser profile holds",
    url: (q, _r, loc = "en-US") => {
      const { lang, region } = localeParts(loc);
      return `https://www.google.com/search?q=${encodeURIComponent(q)}&udm=50&hl=${lang}${region ? `&gl=${region.toLowerCase()}` : ""}`;
    },
    parse: parseAiModeCitations,
    isChallenge: googleChallenge,
    resultsSelector: "h3",
    overview: parseGoogleOverview,
    overviewPending: aiModePending,
    overviewWaitMs: 25_000,
  },
};

/**
 * The query as the engine receives it: `site` as the engine's own operator, and up to three
 * `allowed_domains` the same way (`(site:a OR site:b)`) so the engine narrows the search rather than
 * the tool discarding twenty unrelated results afterwards. Longer lists are enforced on the results only.
 */
export function scopedQuery(q: SearchQuery): string {
  const domains = q.site ? [q.site] : (q.allowedDomains ?? []);
  if (!domains.length || domains.length > 3) return q.query;
  const ops = domains.map((d) => `site:${d}`);
  return `${q.query} ${ops.length === 1 ? ops[0] : `(${ops.join(" OR ")})`}`;
}

export class EngineProvider implements SearchProvider {
  readonly name: string;
  readonly label: string;
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
          ? this.browser.incognitoAllowed?.() === false
            ? "a background window of your installed Chrome (fresh incognito context; the extension lacks incognito permission)"
            : "your own Chrome, incognito"
          : "your own Chrome, your profile"
        : ch === "auto"
          ? `a background window of your installed Chrome (${incognito ? "fresh incognito context" : "tool profile"}; a check brings it forward for you)`
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
    const query = scopedQuery(q);
    // The person approved (and may have edited) the query in their client: it runs as their
    // submission. Where nobody could be asked that way and the engine needs their act, the engine's
    // home page is handed over in the browser with the query in the box and the person presses Enter.
    const submittedByPerson = !!opts.submittedByPerson;
    const human = this.needsApproval && !submittedByPerson && this.spec.human ? this.spec.human : null;
    // An engine whose result pages are not robots-permitted runs only as the person's act; where
    // nobody can be asked and there is no search box to hand over, it does not run.
    if (this.needsPerson && !submittedByPerson && !human)
      throw new SearchError(
        `${this.name}: every ${this.spec.label} query needs your approval in your MCP client, and this client cannot show the form`,
      );
    this.lastIncognito = opts.incognito;
    // (Recency has no place in a query the person submits by hand; the engine's UI applies it if at all.)
    const url = human
      ? human.homeUrl(query, this.settings.locale)
      : this.spec.url(query, q.recency, this.settings.locale);
    const ready = (html: string, at: string) =>
      human!.resultsUrl.test(at) &&
      !this.spec.isChallenge(html, 200, at) &&
      (cheerio.load(html)(this.spec.resultsSelector).length > 0 || !!this.spec.noResults?.test(html));
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
    let rendered: Rendered;
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
            // A generated answer streams in after the results: wait briefly for one that is coming,
            // never for one that isn't (no label on the page). Same wait on every tier.
            settleUntil: this.spec.overviewPending ? (html) => !this.spec.overviewPending!(html) : undefined,
            settleUntilMs: this.spec.overviewWaitMs ?? OVERVIEW_WAIT_MS,
          }),
        Math.max(this.gapMs, crawlDelayMs),
      );
    } catch (e) {
      // The check is being put to the person as the tool's result; the page waits for their answer.
      if (e instanceof HandoffPending)
        throw new SearchCheckRequired(e.id, e.url, e.where, this.name, async (r) =>
          this.finish(r, q, !!human, submittedByPerson),
        );
      throw new SearchError(`${this.name}: browser error (${(e as Error).message.split("\n")[0]})`);
    }
    const first = this.finish(rendered, q, !!human, submittedByPerson);
    if (first.parsed !== "page" || human || !this.spec.plainUrl) return first;
    // Nothing parsed from the default page: one look at the engine's plainer page of the same
    // query (a documented view of its own UI, the same query, the same identity), then the page.
    try {
      const plain = await this.politeness.run(
        this.spec.host,
        () =>
          this.browser.render(this.spec.plainUrl!(query, q.recency, this.settings.locale), {
            session: true,
            handoff: false,
            incognito: opts.incognito,
            isChallenge: this.spec.isChallenge,
            settleSelector: this.spec.resultsSelector,
          }),
        this.gapMs,
      );
      if (this.spec.isChallenge(plain.html, plain.status, plain.finalUrl)) return first;
      const second = this.read(plain.html, q);
      const saved = /page saved to [^)]+/.exec(second.note ?? "")?.[0];
      const note = `${this.name}: the default results page was not recognised; ${second.parsed === "page" ? "its plain Web view follows as a page" : `results read from its plain Web view${second.parsed === "shape" ? " by page shape (approximate)" : ""}`}${saved ? ` (${saved})` : ""}`;
      return { ...second, summary: second.summary ?? first.summary, note };
    } catch {
      return first;
    }
  }

  /** Everything after the render: the engine's answer, judged and parsed. A suspended check resumes here. */
  private finish(rendered: Rendered, q: SearchQuery, human: boolean, submittedByPerson: boolean): SearchResponse {
    if (human && !rendered.handedOff) {
      // The tab/window was closed when the render returned: there is nothing left to press Enter in.
      throw new SearchError(
        `${this.name}: the query was opened in ${rendered.handoffWhere ?? "your browser"} but not submitted within ${Math.round(this.settings.handoffTimeoutMs / 1000)} s, so that tab was closed — search again when you are at the screen and press Enter there`,
      );
    }
    // Approved in the client: the query ran as the person's act. Where a check was then handed to
    // them stays as the tier reported it (a window, a tab), for the hint below.
    if (submittedByPerson)
      rendered = { ...rendered, handedOff: true, handoffWhere: rendered.handoffWhere ?? "your MCP client" };
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
    return this.read(rendered.html, q);
  }

  /**
   * The ladder. Rung 1: the engine's own parser, exact. Rung 2, when that recognises almost nothing:
   * the page's shape — a title that is a link, a display URL, a snippet — approximate and said so.
   * Rung 3, when nothing on the page reads as a result: the page itself as markdown, for the agent
   * to read. An engine's own "nothing matched" page is an answer, not a rung; the page is kept
   * (redacted) whenever rung 1 came up empty, so the parser can be fixed from disk.
   */
  private read(html: string, q: SearchQuery): SearchResponse {
    const overview = this.spec.overview?.(html, q.query);
    const summary = overview ? { ...overview, provider: this.name } : undefined;
    let results = dedupe(this.spec.parse(html, this.name));
    let parsed: Parsed = "first-class";
    if (results.length < MIN_FIRST_CLASS) {
      const shaped = parseByShape(html, this.spec.host, this.name);
      if (shaped.length > results.length) {
        results = shaped;
        parsed = "shape";
      }
    }
    if (!results.length) {
      const dump = this.dumpUnparsed(html);
      const saved = dump ? ` (page saved to ${dump})` : "";
      // An interstitial that merely mentions "did not match" must not pass as an honest empty answer.
      if (this.spec.noResults?.test(html) && !/<h3|role="heading"/i.test(html))
        throw new SearchError(`${this.name}: no results for this query${saved}`);
      return {
        results: [],
        summary,
        parsed: "page",
        page: resultsPageMarkdown(html),
        note: `${this.name}: no result could be parsed from this page (layout not recognised${saved}); the results column follows as markdown`,
      };
    }
    if (parsed === "shape") this.dumpUnparsed(html);
    const filtered = filterDomains(results, q);
    if (!filtered.length) throw new SearchError(`${this.name}: no results matched the domain filters`);
    return {
      results: filtered.slice(0, q.maxResults),
      summary,
      parsed,
      note:
        parsed === "shape"
          ? `${this.name}: results read by page shape (the layout was not recognised) — titles and snippets are approximate`
          : undefined,
    };
  }

  /**
   * Keep the last two pages that produced no results, so a markup change (or an interstitial read as
   * "no results") can be diagnosed from disk. An engine page opened in the person's own profile
   * carries their account chrome, so the account header and any e-mail are removed first.
   */
  private dumpUnparsed(html: string): string | null {
    try {
      const dir = join(this.settings.cacheDir, "debug");
      mkdirSync(dir, { recursive: true });
      const old = readdirSync(dir)
        .filter((f) => f.startsWith(`${this.name}-`))
        .sort();
      for (const f of old.slice(0, Math.max(0, old.length - 1))) rmSync(join(dir, f), { force: true });
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
