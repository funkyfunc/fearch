/**
 * Orders the eligible engines and runs a query through them, in --engines order, via the browser
 * tier. Search does one thing: engines, or an honest no. When no engine answers, the failure names
 * every reason and what to do next; nothing is silently substituted (an automatic fallback used to
 * guess a query's shape and route legal questions to MDN — confidently irrelevant results are worse
 * than a clear no).
 */

import { createHash } from "node:crypto";
import type { Audit } from "../audit.js";
import type { Cache } from "../cache.js";
import type { Settings } from "../config.js";
import type { EngineProvider } from "./engines.js";
import {
  dedupe,
  RateLimited,
  SearchError,
  type EngineSummary,
  type SearchProvider,
  type SearchQuery,
  type SearchResult,
} from "./provider.js";

export interface SearchOutcome {
  results: SearchResult[];
  providers: SearchProvider[];
  fromCache: boolean;
  /** The engine's own generated answer box, when the page carried one. Labelled, never merged into results. */
  summary?: EngineSummary;
  /** Human-readable notes about what happened (rate limits, cooldowns), shown to the model. */
  notes: string[];
}

const RATE_LIMIT_COOLDOWN_MS = 10 * 60_000;

export class SearchRegistry {
  readonly web: SearchProvider[] = [];
  private readonly cooldown = new Map<string, { until: number; why: string }>();

  constructor(
    private readonly settings: Settings,
    private readonly cache: Cache,
    private readonly audit: Audit,
    /** Search-engine result-page providers (browser tier), in preference order; only available ones are used. */
    private readonly engines: EngineProvider[] = [],
  ) {
    this.web = settings.searchMode === "off" ? [] : engines.filter((p) => p.available());
  }

  describe(): string {
    if (this.settings.searchMode === "off") return "search disabled (--search off)";
    const names = this.web.map((p) => p.name);
    const off = this.unusedEngines().map((x) => `${x.name} (${x.why})`);
    return `engines: ${names.join(" → ") || "(none)"}${off.length ? `; listed but not used: ${off.join("; ")}` : ""}`;
  }

  /** Engines the operator listed in --engines that the other dials make ineligible. */
  private unusedEngines(): { name: string; why: string }[] {
    return this.engines.flatMap((p) => {
      const why = p.ineligibleReason();
      return why ? [{ name: p.name, why }] : [];
    });
  }

  async search(q: SearchQuery): Promise<SearchOutcome> {
    if (this.settings.searchMode === "off") {
      throw new SearchError(
        "Search is disabled on this server (--search off). Ask the user for a URL, or fetch a site's /llms.txt to discover its pages.",
      );
    }
    const key = createHash("sha1")
      .update(JSON.stringify({ ...q, v: 2 }))
      .digest("hex");
    const cached = this.cache.getSearch<{ results: SearchResult[]; providers: string[]; summary?: EngineSummary }>(key);
    if (cached) {
      this.audit.record({ url: `search:${q.query}`, cache: "hit" });
      const providers = this.web.filter((p) => cached.providers.includes(p.name));
      return {
        results: cached.results,
        providers,
        fromCache: true,
        notes: [],
        summary: cached.summary,
      };
    }

    const errors: string[] = [];
    const notes: string[] = [];
    const used: SearchProvider[] = [];
    let results: SearchResult[] = [];
    let summary: EngineSummary | undefined;
    /** A provider ahead of the first one that answered failed or was skipped (chain searches only). */
    let preferredFailed = false;
    const now = Date.now();

    const runOne = async (p: SearchProvider): Promise<SearchResult[]> => {
      const cd = this.cooldown.get(p.name);
      if (cd && cd.until > now) {
        notes.push(`${p.name}: skipped (${cd.why}; retrying after ${Math.ceil((cd.until - now) / 60_000)} min)`);
        return [];
      }
      try {
        const r = await p.search(q);
        used.push(p);
        summary ??= r.summary;
        this.audit.record({
          url: `search:${q.query}`,
          provider: p.name,
          status: "ok",
          note: `${r.results.length} results`,
        });
        return r.results;
      } catch (e) {
        const msg = (e as Error).message;
        errors.push(msg);
        this.audit.record({ url: `search:${q.query}`, provider: p.name, status: "error", note: msg });
        if (e instanceof RateLimited) {
          const why = p.posture === "browser" ? `${p.name} showed its bot-check page` : "rate-limited";
          this.cooldown.set(p.name, { until: now + RATE_LIMIT_COOLDOWN_MS, why });
          notes.push(`${p.name}: ${why}`);
        } else {
          // Say why an answer is missing (a robots.txt timeout, a parse failure) instead of burying it.
          const line = msg.split("\n")[0].slice(0, 160);
          notes.push(line.startsWith(`${p.name}:`) ? line : `${p.name}: ${line}`);
        }
        return [];
      }
    };

    // Ordered chain: stop as soon as we have enough.
    const runChain = async (providers: SearchProvider[]) => {
      for (const p of providers) {
        if (results.length >= q.maxResults) break;
        const got = await runOne(p);
        if (!got.length && !results.length) preferredFailed = true;
        results = dedupe([...results, ...got]);
      }
    };
    for (const u of this.unusedEngines()) notes.push(`${u.name}: listed in --engines but not used — ${u.why}`);
    await runChain(this.web);

    if (!results.length)
      throw new SearchError(
        `No results (${[...new Set([...errors, ...notes])].join("; ") || "no engines configured"}). ` +
          "Fetch a URL you already know, or retry after any cooldown named above.",
      );
    results = results.slice(0, q.maxResults);
    // Cache only clean outcomes. If a preferred provider failed (bot-check, parse error, cooldown) and a
    // lower one answered, the next call should get another chance at the preferred one rather than
    // 15 minutes of the fallback's answer.
    if (!preferredFailed) this.cache.setSearch(key, { results, providers: used.map((p) => p.name), summary });
    return { results, providers: used, fromCache: false, notes, summary };
  }
}
