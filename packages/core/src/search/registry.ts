/**
 * Orders providers and runs a query: eligible engines via the browser (DuckDuckGo lite by default) →
 * keyless first-party federation as the last resort. `kind`-scoped queries go straight to the
 * matching federation providers.
 */

import { createHash } from "node:crypto";
import type { Audit } from "../audit.js";
import type { Cache } from "../cache.js";
import type { Settings } from "../config.js";
import type { HttpLike } from "../fetch/types.js";
import type { EngineProvider } from "./engines.js";
import { federationProviders } from "./federation.js";
import {
  dedupe,
  SearchError,
  type EngineSummary,
  type SearchKind,
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
  fellBackToFederation: boolean;
  /** Human-readable notes about what happened (rate limits, cooldowns), shown to the model. */
  notes: string[];
}

/** Round-robin merge so no single provider crowds the others out of a small result budget. */
export function interleave(lists: SearchResult[][]): SearchResult[] {
  const out: SearchResult[] = [];
  const max = Math.max(0, ...lists.map((l) => l.length));
  for (let i = 0; i < max; i++) for (const l of lists) if (l[i]) out.push(l[i]);
  return out;
}

const RATE_LIMIT_COOLDOWN_MS = 10 * 60_000;

export class SearchRegistry {
  readonly web: SearchProvider[] = [];
  readonly federation: SearchProvider[];
  private readonly cooldown = new Map<string, { until: number; why: string }>();

  constructor(
    private readonly settings: Settings,
    private readonly cache: Cache,
    private readonly audit: Audit,
    http: HttpLike,
    /** Search-engine result-page providers (browser tier), in preference order; only available ones are used. */
    private readonly engines: EngineProvider[] = [],
  ) {
    // "first-party" mode: no engine result pages at all (queries stay with the sites they concern).
    // Order: eligible engines via the browser (DuckDuckGo lite by default: keyless, robots-permitted,
    // unlogged by DDG) → first-party federation.
    this.web = settings.searchMode === "all" ? engines.filter((p) => p.available()) : [];
    this.federation = settings.searchMode === "off" ? [] : federationProviders(http);
  }

  describe(): string {
    if (this.settings.searchMode === "off") return "search disabled (FEARCH_SEARCH_MODE=off)";
    const names = this.web.map((p) => p.name);
    const off = this.unusedEngines().map((x) => `${x.name} (${x.why})`);
    return `mode=${this.settings.searchMode}; web: ${names.join(" → ") || "(none)"}; federation: ${this.federation.map((p) => p.name).join(", ")}${off.length ? `; engines listed but not used: ${off.join("; ")}` : ""}`;
  }

  /** Engines the operator listed in --engines that the other dials make ineligible. */
  private unusedEngines(): { name: string; why: string }[] {
    return this.engines.flatMap((p) => {
      const why = p.ineligibleReason();
      return why ? [{ name: p.name, why }] : [];
    });
  }

  private forKind(kind: SearchKind): SearchProvider[] {
    return this.federation.filter((p) => p.kinds.includes(kind));
  }

  /**
   * Peers for the general-web fallback (no web provider answered). Q&A, web docs and repositories
   * first; Wikipedia only when the query doesn't look like code; package indexes never (they are
   * for `kind: packages`).
   */
  private webFallback(query: string): SearchProvider[] {
    const technical =
      /[A-Z][a-z]+[A-Z]|[a-z]+\.[a-z]+\(|[_:/()<>{}=]|\b(npm|pip|cargo|api|error|exception|config|install|version|function|class|async)\b/i.test(
        query,
      ) || query.split(/\s+/).length > 5;
    const order = technical
      ? ["stackexchange", "mdn", "hackernews", "github"]
      : ["stackexchange", "mdn", "wikipedia", "hackernews", "marginalia", "github"];
    return order.map((n) => this.federation.find((p) => p.name === n)).filter((p): p is SearchProvider => !!p);
  }

  async search(q: SearchQuery): Promise<SearchOutcome> {
    if (this.settings.searchMode === "off") {
      throw new SearchError(
        "Search is disabled on this server (FEARCH_SEARCH_MODE=off). Ask the user for a URL, or fetch a site's /llms.txt to discover its pages.",
      );
    }
    const key = createHash("sha1")
      .update(JSON.stringify({ ...q, v: 2 }))
      .digest("hex");
    const cached = this.cache.getSearch<{ results: SearchResult[]; providers: string[]; summary?: EngineSummary }>(key);
    if (cached) {
      this.audit.record({ url: `search:${q.query}`, cache: "hit" });
      const providers = [...this.web, ...this.federation].filter((p) => cached.providers.includes(p.name));
      return {
        results: cached.results,
        providers,
        fromCache: true,
        fellBackToFederation: false,
        notes: [],
        summary: cached.summary,
      };
    }

    const errors: string[] = [];
    const notes: string[] = [];
    const used: SearchProvider[] = [];
    let results: SearchResult[] = [];
    let summary: EngineSummary | undefined;
    let fellBack = false;
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
        if (/rate.?limit|HTTP 429|too many requests/i.test(msg)) {
          const why = p.posture === "browser" ? `${p.name} showed its bot-check page` : "rate-limited";
          this.cooldown.set(p.name, { until: now + RATE_LIMIT_COOLDOWN_MS, why });
          notes.push(`${p.name}: ${why}`);
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
    // Peers: run all, then interleave so a small budget still shows every provider.
    const runPeers = async (providers: SearchProvider[]) => {
      const lists = await Promise.all(providers.map(runOne));
      results = dedupe([...results, ...interleave(lists)]);
    };

    if (q.kind && q.kind !== "web") {
      await runPeers(this.forKind(q.kind));
    } else {
      const chain = [...this.web];
      for (const u of this.unusedEngines()) notes.push(`${u.name}: listed in --engines but not used — ${u.why}`);
      await runChain(chain);
      if (!results.length) {
        fellBack = true;
        await runPeers(this.webFallback(q.query));
      }
    }

    if (!results.length)
      throw new SearchError(
        `No results from any provider (${[...errors, ...notes].join("; ") || "no providers configured"}).`,
      );
    results = results.slice(0, q.maxResults);
    // Cache only clean outcomes. If a preferred provider failed (bot-check, parse error, cooldown) and a
    // lower one answered, the next call should get another chance at the preferred one rather than
    // 15 minutes of the fallback's answer.
    if (!preferredFailed && !fellBack)
      this.cache.setSearch(key, { results, providers: used.map((p) => p.name), summary });
    return { results, providers: used, fromCache: false, fellBackToFederation: fellBack, notes, summary };
  }
}
