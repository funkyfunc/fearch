/**
 * Search-engine result pages opened in the browser tier.
 *
 * Eligibility is where the dials meet: an engine is only used if it is listed in --engines *and*
 * either its robots.txt permits its result pages (DuckDuckGo lite does: `/lite/`) or a person is
 * present — a visible browser (headed or extension) with handoff on, where the result page is the
 * person's own browsing rather than a crawl (Google and Bing both `Disallow: /search`, which governs
 * unattended crawlers, not a browser someone oversees). `--robots off` also qualifies, as the
 * explicit user-agent posture. Robots-permitted engines are still verified live before every request.
 *
 * One page per search call, ≥3 s between requests to an engine. A challenge page is the engine's "no":
 * in headless mode the provider stops and cools down; with a person present the tab is handed to
 * them, who may pass it themselves — the tool never does.
 */

import * as cheerio from "cheerio";
import type { AnyNode } from "domhandler";
import { mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { personPresent, type Settings } from "../config.js";
import type { BrowserTier } from "../fetch/browser.js";
import type { RobotsChecker } from "../fetch/robots.js";
import type { Politeness } from "../politeness.js";
import {
  dedupe,
  filterDomains,
  SearchError,
  type EngineSummary,
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
  url(query: string): string;
  parse(html: string, provider: string): SearchResult[];
  isChallenge(status: number, html: string, url?: string): boolean;
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
 * Challenge detectors must not fire on a normal results page (Bing's scripts contain the word
 * "challenge"; a false positive would hand a good page to the person and wait). Rule: a definitive
 * status, or a challenge marker *and* no parsed results.
 */
export function ddgChallenge(status: number, html: string): boolean {
  return (
    status === 202 || (!/class="result-link"/.test(html) && /anomaly|challenge|captcha|unusual traffic/i.test(html))
  );
}

const bingChallenge = (status: number, html: string): boolean =>
  status === 403 || status === 429 || (!/class="b_algo"/.test(html) && /verify you|not a robot|captcha/i.test(html));

/**
 * Google's check lives at /sorry/…; once passed, the browser lands on a results page with <h3>
 * headings whose source still mentions "sorry" in scripts — so the URL and the presence of results
 * decide, not strings in the source (a real results page must never count as a challenge, or the
 * handoff would wait forever after the person has passed it).
 */
const googleChallenge = (status: number, html: string, url = ""): boolean => {
  if (/\/sorry\//.test(url)) return true;
  if (/<h3/.test(html)) return false;
  return status === 429 || /unusual traffic from your computer network|not a robot|recaptcha/i.test(html);
};

// ---------------------------------------------------------------- Bing

/** Bing wraps result links as /ck/a?…&u=a1<base64url of the URL>. */
export function unwrapBing(href: string): string {
  try {
    const u = new URL(href, "https://www.bing.com");
    const p = u.searchParams.get("u");
    if (u.pathname.startsWith("/ck/") && p && p.startsWith("a1")) {
      const b64 = p.slice(2).replace(/-/g, "+").replace(/_/g, "/");
      const decoded = Buffer.from(b64 + "=".repeat((4 - (b64.length % 4)) % 4), "base64").toString("utf8");
      if (/^https?:\/\//.test(decoded)) return decoded;
    }
    return u.toString();
  } catch {
    return href;
  }
}

export function parseBing(html: string, provider: string): SearchResult[] {
  const $ = cheerio.load(html);
  const out: SearchResult[] = [];
  $("li.b_algo").each((_, li) => {
    const a = $(li).find("h2 a").first();
    const url = unwrapBing(a.attr("href") ?? "");
    const title = a.text().trim();
    if (!title || !/^https?:/.test(url) || skipHost(url, /(^|\.)bing\.com$/, /(^|\.)microsoft\.com$/)) return;
    const snippet = $(li).find(".b_caption p, p").first().text().replace(/\s+/g, " ").trim();
    out.push({ title, url, snippet, provider });
  });
  return out;
}

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
    const marker = $("div, span, h1, h2").filter(
      (_, e) => $(e).children().length === 0 && /^AI (Overview|Mode)/.test($(e).text().trim()),
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
    .replace(/Shared?\s*\d+\s*files?\s*$/, "")
    .replace(/Show (more|all)\s*$/i, "")
    .trim();
  if (text.length < 80 || /^(An AI Overview is not available|Can't generate)/.test(text)) return null;
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
    url: (q) => `${DDG_LITE}?q=${encodeURIComponent(q)}&kl=us-en`,
    parse: parseLite,
    isChallenge: ddgChallenge,
    resultsSelector: "a.result-link",
  },
  bing: {
    name: "bing",
    label: "Bing",
    host: "www.bing.com",
    robotsPermitted: false,
    privacy: "queries are logged by Microsoft",
    url: (q) => `https://www.bing.com/search?q=${encodeURIComponent(q)}&setlang=en&cc=US`,
    parse: parseBing,
    isChallenge: bingChallenge,
    resultsSelector: "li.b_algo",
  },
  google: {
    name: "google",
    label: "Google",
    host: "www.google.com",
    robotsPermitted: false,
    privacy: "queries are logged by Google, tied to any Google session in the tool profile",
    url: (q) => `https://www.google.com/search?q=${encodeURIComponent(q)}&hl=en&num=10`,
    parse: parseGoogle,
    isChallenge: googleChallenge,
    resultsSelector: "a h3",
    overview: parseGoogleOverview,
  },
};

export class EngineProvider implements SearchProvider {
  readonly name: string;
  readonly kinds: SearchProvider["kinds"] = ["web"];
  readonly posture: SearchProvider["posture"] = "browser";

  constructor(
    readonly spec: EngineSpec,
    private readonly settings: Settings,
    private readonly browser: BrowserTier,
    private readonly robots: RobotsChecker,
    private readonly politeness: Politeness,
    private readonly gapMs = 3000,
  ) {
    this.name = spec.name;
  }

  get disclosure(): string {
    const how =
      this.browser.browserChannel === "extension"
        ? "your own Chrome (fearch bridge extension)"
        : this.browser.headed
          ? "the visible browser window"
          : "the self-identified headless browser";
    const robots = this.spec.robotsPermitted
      ? "robots.txt allows this page"
      : personPresent(this.settings)
        ? "opened as your own browsing — you oversee this browser and are handed any challenge"
        : "robots.txt disallows result pages; opened because robots is off";
    return `${this.spec.label} via ${how} (${robots}; ${this.spec.privacy})`;
  }

  /** Listed in --engines, browser on, and robots-eligible. */
  available(): boolean {
    return this.browser.enabled() && this.settings.engines.includes(this.name) && this.eligible();
  }

  eligible(): boolean {
    return this.spec.robotsPermitted || personPresent(this.settings) || this.settings.robotsPolicy === "off";
  }

  /** Why a listed engine is not used, for `doctor`. */
  ineligibleReason(): string | null {
    if (!this.settings.engines.includes(this.name)) return null;
    if (!this.browser.enabled()) return "browser tier is off";
    if (!this.eligible())
      return `${this.spec.host} disallows result pages for crawlers; eligible with a visible browser you oversee (--browser headed or extension)`;
    return null;
  }

  async search(q: SearchQuery): Promise<SearchResponse> {
    const query = q.site ? `${q.query} site:${q.site}` : q.query;
    const url = this.spec.url(query);
    // Robots-permitted engines are verified live (the permission could have been withdrawn). Engines
    // eligible through the person-present or robots-off posture are the person's own browsing — the
    // crawler rules don't apply, so robots.txt is not consulted for their result pages.
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
            isChallenge: (h, s, u) => this.spec.isChallenge(s, h, u),
            settleSelector: this.spec.resultsSelector,
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
    if (this.spec.isChallenge(rendered.status, rendered.html, rendered.finalUrl)) {
      // The engine's "no". Stop and cool down (the registry treats "rate-limited" as such).
      const hint = this.browser.headed
        ? this.settings.handoff
          ? "it was shown in the browser window but not passed in time"
          : "handoff is disabled (FEARCH_HANDOFF=0); with it on you would be handed the page to pass yourself"
        : "with --browser headed or extension the page would be handed to you to pass yourself";
      throw new SearchError(
        `${this.name}: rate-limited — ${this.spec.label} showed its bot-check page (HTTP ${rendered.status}); not retrying (${hint})`,
      );
    }
    const results = filterDomains(dedupe(this.spec.parse(rendered.html, this.name)), q);
    if (!results.length) {
      const dump = this.dumpUnparsed(rendered.html);
      throw new SearchError(
        `${this.name}: no results parsed (markup may have changed${dump ? `; page saved to ${dump} for debugging` : ""})`,
      );
    }
    const overview = this.spec.overview?.(rendered.html);
    return {
      results: results.slice(0, q.maxResults),
      summary: overview ? { ...overview, provider: this.name } : undefined,
    };
  }

  /** Keep the last few pages that produced no results, so a markup change can be diagnosed from disk. */
  private dumpUnparsed(html: string): string | null {
    try {
      const dir = join(this.settings.cacheDir, "debug");
      mkdirSync(dir, { recursive: true });
      const old = readdirSync(dir)
        .filter((f) => f.startsWith(`${this.name}-`))
        .sort();
      for (const f of old.slice(0, Math.max(0, old.length - 2))) rmSync(join(dir, f), { force: true });
      const path = join(dir, `${this.name}-${new Date().toISOString().replace(/[:.]/g, "-")}.html`);
      writeFileSync(path, html);
      return path;
    } catch {
      return null;
    }
  }
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
