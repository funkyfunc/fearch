/** fearch: respectful web search + page reading for coding agents (stdio MCP server). */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { Audit } from "./audit.js";
import { Cache } from "./cache.js";
import { copyFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { settingsFromEnv, type Settings } from "./config.js";
import { BrowserRenderer } from "./fetch/browser.js";
import { applyBudget } from "./fetch/budget.js";
import { renderDiagnosis } from "./fetch/diagnose.js";
import { makeCursor, resolveCursor, viewId } from "./fetch/cursor.js";
import { describeAge } from "./fetch/freshness.js";
import { BlockedURL } from "./fetch/guard.js";
import { findPattern, renderPattern } from "./fetch/pattern.js";
import { DiagnosedError, Fetcher, type PageDoc } from "./fetch/pipeline.js";
import { applyLinkMode, renderPage } from "./fetch/render.js";
import { RobotsChecker } from "./fetch/robots.js";
import { findSection, focusSections, joinSections, renderOutline, splitSections } from "./fetch/sections.js";
import { FetchError, Transport } from "./fetch/transport.js";
import { fetchedText } from "./fetch/types.js";
import { BudgetExceeded, Politeness } from "./politeness.js";
import type { SearchProvider, SearchResult } from "./search/provider.js";
import { SearchError } from "./search/provider.js";
import { engineProviders } from "./search/engines.js";
import { SearchRegistry } from "./search/registry.js";
import { renderResults } from "./search/render.js";

export const SEARCH_DESCRIPTION = `Search the web. Returns a ranked markdown list of results (title, URL, snippet) and names the provider the query went to.

Use this for discovery — docs pages, GitHub repos/issues, blog posts, error messages, package names. Then call \`fetch\` on the best URL. To save a round trip, pass \`fetch_top=N\` (1–3): the top N results are fetched and the passages most relevant to your query are included inline.

\`kind\` routes to first-party APIs: "code" (GitHub repos/issues), "qa" (StackOverflow), "packages" (npm, crates.io), "docs" (MDN, Wikipedia), "papers" (arXiv, OpenAlex, Semantic Scholar), "community" (Hacker News). Prefer a kind when the question fits one — those APIs are more reliable and more precise than general web search. Omit it for general web search. \`site="docs.python.org"\` restricts to a domain; \`recency="w"\` limits to the past week (d/w/m/y). Results carry a date when the provider knows one. Quote exact error strings. If results are poor, rephrase rather than paging.

This server searches only where automated clients are permitted (DuckDuckGo lite in a real, self-identified browser; first-party APIs), identifies itself honestly, and never impersonates a browser or hides that it is automated.`;

export const FETCH_DESCRIPTION = `Fetch a web page and return its main content as clean markdown (boilerplate removed; code blocks and tables preserved). Handles HTML, markdown, plain text, PDF, GitHub (files, READMEs, issues, tree listings, releases, gists), PyPI, npm, StackOverflow and llms.txt.

Output is bounded by \`max_chars\` (default 12000). Long pages: don't page blindly — pick a mode:
  - \`mode="focus", query="what you are looking for"\` → only the sections relevant to that phrase (BM25, no LLM).
  - \`mode="section", query="Heading text"\` → exactly that section and its subsections (fuzzy match; the error lists available headings).
  - \`mode="pattern", query="regex"\` → only matches with context and positions ("does this page mention X?").
  - \`mode="read"\` (default) with \`cursor\` copied from the footer to continue where you left off.
The header says when the page was last updated when the site declares it; "may be stale" means over a year old.
\`urls=[...]\` (max 5) reads several pages in one call. \`include_links=true\` keeps hyperlinks as reference-style links.

Respectful by design: identifies itself honestly, honours robots.txt (including AI-agent opt-outs), and waits between requests to a host. If the plain HTTP client gets an empty JavaScript shell or is refused, the page is opened once in a real, self-identified headless browser (no stealth, no CAPTCHA solving). If that is refused too (403, CAPTCHA, paywall, login) the refusal is final — you get a Diagnosis explaining why and what to do instead; do not retry the same URL. \`via="archive"\` reads a Wayback Machine copy, only for pages that are gone (404/410).`;

const READ_ONLY = { readOnlyHint: true, openWorldHint: true, idempotentHint: true, destructiveHint: false } as const;

export interface AppState {
  settings: Settings;
  audit: Audit;
  cache: Cache;
  transport: Transport;
  politeness: Politeness;
  robots: RobotsChecker;
  fetcher: Fetcher;
  search: SearchRegistry;
  browser: BrowserRenderer;
}

/** One-time move of the browser profile from the pre-rename cache directory (websearch-mcp → fearch). */
function migrateLegacyProfile(settings: Settings): void {
  try {
    const legacy = settings.browserStatePath.replace(/([\\/])fearch([\\/])browser-state\.json$/, "$1websearch-mcp$2browser-state.json");
    if (legacy !== settings.browserStatePath && !existsSync(settings.browserStatePath) && existsSync(legacy)) {
      mkdirSync(dirname(settings.browserStatePath), { recursive: true });
      copyFileSync(legacy, settings.browserStatePath);
    }
  } catch {
    /* best effort */
  }
}

export function createState(settings = settingsFromEnv()): AppState {
  migrateLegacyProfile(settings);
  const audit = new Audit(settings);
  const cache = new Cache(settings.noCache ? null : `${settings.cacheDir}/cache-v2.sqlite`);
  const transport = new Transport(settings, audit);
  const politeness = new Politeness(settings.perHostDelayMs, settings.sessionBudget);
  const robots = new RobotsChecker(
    cache,
    async (url) => {
      // Own queue key: robots.txt is fetched once per host per hour and must not consume the
      // Crawl-delay gap that belongs between *page* requests.
      const r = await politeness.run(`robots:${new URL(url).host}`, () => transport.get(url, { source: "robots.txt", headers: { accept: "text/plain, */*;q=0.5" }, maxBytes: 512 * 1024 }));
      return { status: r.status, body: fetchedText(r) };
    },
    settings.ignoreRobots,
    settings.robotsPolicy,
  );
  const browser = new BrowserRenderer(settings, audit);
  const fetcher = new Fetcher(settings, cache, transport, robots, politeness, audit, browser);
  const engines = engineProviders(settings, browser, robots, politeness);
  const search = new SearchRegistry(settings, cache, audit, fetcher.http("search", { budget: false }), engines);
  return { settings, audit, cache, transport, politeness, robots, fetcher, search, browser };
}

// ---------------------------------------------------------------------------
// fetch rendering
// ---------------------------------------------------------------------------

export type ReadMode = "read" | "focus" | "section" | "pattern" | "raw";

export interface RenderOptions {
  mode: ReadMode;
  /** Phrase (focus), heading (section), or regex (pattern). */
  query?: string;
  maxChars: number;
  cursor?: string;
  includeLinks: boolean;
  contextChars?: number;
}

export class SectionNotFound extends Error {}
export class BadRequest extends Error {}

function docFacts(doc: PageDoc): string[] {
  const facts: string[] = [];
  if (doc.robots) facts.push(`robots: ${doc.robots}`);
  if (doc.updated) facts.push(describeAge(doc.updated));
  if (doc.licence.length) facts.push(`licence: ${doc.licence.join(" | ")}`);
  return facts;
}

export function renderDoc(doc: PageDoc, o: RenderOptions): string {
  const facts = docFacts(doc);
  const view = viewId(o.mode, o.query);
  const { offset, note: cursorNote } = resolveCursor(o.cursor, view);
  const notes: string[] = [doc.note, cursorNote ?? ""].filter(Boolean);
  const base = { title: doc.title, url: doc.finalUrl, source: doc.source, facts };

  if (o.mode === "raw") {
    const window = applyBudget(doc.markdown, offset, o.maxChars);
    return renderPage({ ...base, window, note: notes.join(" "), nextCursor: makeCursor(window.end, view) });
  }
  if (o.mode === "pattern") {
    if (!o.query) throw new BadRequest("mode=pattern needs `query` (a regex).");
    const { body } = applyLinkMode(doc.markdown, false);
    const res = findPattern(body, o.query, o.contextChars ?? 200);
    const text = renderPattern(o.query, res, body.length);
    const window = applyBudget(text, 0, o.maxChars);
    return renderPage({ ...base, window: { ...window, total: 0 }, note: notes.join(" ") });
  }

  const sections = splitSections(doc.markdown);
  let selected = doc.markdown;
  let outline = "";
  let shownCount = sections.length;
  if (o.mode === "section") {
    if (!o.query) throw new BadRequest("mode=section needs `query` (a heading).");
    const sub = findSection(sections, o.query);
    if (!sub) {
      const available = sections.filter((s) => s.level > 0).map((s) => s.title).join(" · ").slice(0, 2000);
      throw new SectionNotFound(`No section matching '${o.query}' on ${doc.finalUrl}. Available sections: ${available || "(none — page has no headings)"}`);
    }
    selected = joinSections(sub);
    outline = renderOutline(sections, new Set(sub.map((s) => s.index)));
    shownCount = sub.length;
    notes.push(`Section: '${o.query}'.`);
  } else if (o.mode === "focus") {
    if (!o.query) throw new BadRequest("mode=focus needs `query` (what you are looking for).");
    const chosen = focusSections(sections, o.query, o.maxChars);
    selected = joinSections(chosen);
    outline = renderOutline(sections, new Set(chosen.map((s) => s.index)));
    shownCount = chosen.length;
    notes.push(`Focus: '${o.query}'.`);
  }
  const { body, footer } = applyLinkMode(selected, o.includeLinks);
  const window = applyBudget(body, offset, o.maxChars);
  if (o.mode === "read" && window.truncated) {
    const shown = new Set(sections.filter((s) => s.start < window.end && s.end > window.start).map((s) => s.index));
    outline = renderOutline(sections, shown);
    shownCount = shown.size;
  }
  return renderPage({
    ...base,
    window,
    outline,
    linksFooter: footer,
    note: notes.join(" "),
    sections: { shown: shownCount, total: sections.length },
    nextCursor: makeCursor(window.end, view),
  });
}

function errorText(url: string, e: unknown): string {
  if (e instanceof DiagnosedError) return `Fetch refused or failed for ${url}\n${renderDiagnosis(e.diagnosis)}`;
  if (e instanceof BlockedURL || e instanceof FetchError || e instanceof BudgetExceeded || e instanceof SectionNotFound || e instanceof BadRequest || e instanceof SearchError) return e.message;
  return `Unexpected error: ${(e as Error).message ?? String(e)}`;
}

async function fetchOne(state: AppState, url: string, o: RenderOptions & { archive?: boolean }): Promise<string> {
  const doc = await state.fetcher.fetch(url, { raw: o.mode === "raw", via: o.archive ? "archive" : undefined });
  return renderDoc(doc, o);
}

async function excerpt(state: AppState, url: string, query: string): Promise<string | undefined> {
  try {
    const doc = await state.fetcher.fetch(url);
    const chosen = focusSections(splitSections(doc.markdown), query, state.settings.excerptChars);
    const { body } = applyLinkMode(joinSections(chosen), false);
    const w = applyBudget(body, 0, state.settings.excerptChars);
    const text = w.text.trim();
    return text ? (w.truncated ? text + " …" : text) : undefined;
  } catch (e) {
    state.audit.log("info", `excerpt skipped for ${url}: ${(e as Error).message}`);
    return undefined;
  }
}

/** MCP progress notifications, when the client asked for them (`_meta.progressToken`). Never throws. */
function progressReporter(extra: { _meta?: { progressToken?: string | number }; sendNotification?: (n: never) => Promise<void> }, total: number) {
  const token = extra?._meta?.progressToken;
  const send = extra?.sendNotification;
  if (token === undefined || !send) return async () => {};
  return async (progress: number, message: string) => {
    try {
      await send({ method: "notifications/progress", params: { progressToken: token, progress, total, message } } as never);
    } catch {
      // progress is best-effort
    }
  };
}

// ---------------------------------------------------------------------------
// server
// ---------------------------------------------------------------------------

export function buildServer(state: AppState): McpServer {
  const server = new McpServer({ name: "fearch", version: state.settings.version });

  server.registerTool(
    "search",
    {
      title: "Web search",
      description: SEARCH_DESCRIPTION,
      inputSchema: {
        query: z.string().min(2).describe("Search query. Supports quoted phrases."),
        max_results: z.number().int().min(1).max(20).default(8).describe("Number of results (default 8)."),
        recency: z.enum(["d", "w", "m", "y"]).optional().describe("Restrict to the past day/week/month/year."),
        site: z.string().optional().describe("Restrict results to this domain, e.g. 'docs.python.org'."),
        kind: z.enum(["web", "code", "qa", "packages", "docs", "papers", "community"]).optional().describe("Route to first-party APIs: code=GitHub, qa=StackOverflow, packages=npm+crates.io, docs=MDN+Wikipedia, papers=arXiv+OpenAlex+Semantic Scholar, community=Hacker News."),
        allowed_domains: z.array(z.string()).optional().describe("Only include results from these domains."),
        blocked_domains: z.array(z.string()).optional().describe("Never include results from these domains."),
        fetch_top: z.number().int().min(0).max(3).default(0).describe("Also fetch the top N results and include query-focused excerpts inline."),
      },
      annotations: READ_ONLY,
    },
    async (args, extra) => {
      const query = args.query.trim();
      const progress = progressReporter(extra, 1 + args.fetch_top);
      try {
        const outcome = await state.search.search({
          query,
          maxResults: args.max_results,
          recency: args.recency,
          site: args.site?.trim() || undefined,
          allowedDomains: args.allowed_domains,
          blockedDomains: args.blocked_domains,
          kind: args.kind,
        });
        await progress(1, `search done via ${outcome.providers.map((p) => p.name).join("+") || "cache"}`);
        if (args.fetch_top) {
          const top: SearchResult[] = outcome.results.slice(0, args.fetch_top);
          let done = 0;
          const excerpts = await Promise.all(
            top.map(async (r) => {
              const ex = await excerpt(state, r.url, query);
              done++;
              await progress(1 + done, `excerpt ${done}/${top.length}: ${r.url}`);
              return ex;
            }),
          );
          top.forEach((r, i) => (r.excerpt = excerpts[i]));
        }
        return { content: [{ type: "text", text: renderResults(query, outcome) }] };
      } catch (e) {
        return { content: [{ type: "text", text: errorText(`search:${query}`, e) }], isError: true };
      }
    },
  );

  server.registerTool(
    "fetch",
    {
      title: "Fetch page",
      description: FETCH_DESCRIPTION,
      inputSchema: {
        url: z.string().optional().describe("URL to fetch."),
        urls: z.array(z.string()).max(5).optional().describe("Up to 5 URLs to fetch in one call (same mode/query for all)."),
        mode: z
          .enum(["read", "focus", "section", "pattern", "raw"])
          .default("read")
          .describe("read: the page from the start. focus: only sections relevant to `query`. section: the heading named by `query`. pattern: regex matches with context. raw: unprocessed body."),
        query: z.string().optional().describe("For focus (a phrase), section (a heading), or pattern (a regex)."),
        max_chars: z.number().int().min(500).max(100_000).optional().describe("Character budget (default 12000)."),
        cursor: z.string().optional().describe("Continuation token copied from a previous footer."),
        include_links: z.boolean().default(false).describe("Keep hyperlinks as reference-style links with a footer."),
        context_chars: z.number().int().min(20).max(2000).default(200).describe("pattern mode: context around each match."),
        archive: z.boolean().default(false).describe("Read a Wayback Machine copy — only for pages that are gone (404/410); never a bypass for blocked pages."),
      },
      annotations: READ_ONLY,
    },
    async (args, extra) => {
      const targets = [...(args.url ? [args.url] : []), ...(args.urls ?? [])].map((u) => u.trim()).filter(Boolean);
      if (!targets.length) return { content: [{ type: "text", text: "Provide `url` or `urls`." }], isError: true };
      if (targets.length > 5) return { content: [{ type: "text", text: "At most 5 URLs per call." }], isError: true };
      let budget = args.max_chars ?? state.settings.maxChars;
      if (targets.length > 1 && args.max_chars === undefined) budget = Math.max(2000, Math.floor(budget / targets.length));
      const o: RenderOptions & { archive?: boolean } = {
        mode: args.mode,
        query: args.query?.trim() || undefined,
        maxChars: budget,
        cursor: args.cursor,
        includeLinks: args.include_links,
        contextChars: args.context_chars,
        archive: args.archive,
      };
      const progress = progressReporter(extra, targets.length);

      if (targets.length === 1) {
        try {
          const text = await fetchOne(state, targets[0], o);
          await progress(1, `fetched ${targets[0]}`);
          return { content: [{ type: "text", text }] };
        } catch (e) {
          return { content: [{ type: "text", text: errorText(targets[0], e) }], isError: true };
        }
      }
      let done = 0;
      const outs = await Promise.allSettled(
        targets.map(async (t) => {
          try {
            return await fetchOne(state, t, o);
          } finally {
            done++;
            await progress(done, `${done}/${targets.length}: ${t}`);
          }
        }),
      );
      const parts = outs.map((r, i) => (r.status === "fulfilled" ? r.value : `# (failed) ${targets[i]}\n${errorText(targets[i], r.reason)}\n`));
      return { content: [{ type: "text", text: parts.join("\n\n=====\n\n") }] };
    },
  );

  return server;
}

export function describeProviders(providers: SearchProvider[]): string {
  return providers.map((p) => `${p.name} (${p.posture})`).join(", ");
}
