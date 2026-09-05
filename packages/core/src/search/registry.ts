/**
 * Orders the eligible engines and runs a query through them, in --engines order, via the browser
 * tier. Search does one thing: engines, or an honest no. When no engine answers, the failure names
 * every reason and what to do next; nothing is silently substituted (an automatic fallback used to
 * guess a query's shape and route legal questions to MDN — confidently irrelevant results are worse
 * than a clear no).
 *
 * The person's part: before a query reaches an engine that needs their act (Google — its result
 * pages are not robots-permitted — or every engine with `--human-search`), they are shown a form in
 * their MCP client: the query, the engine, their profile or incognito, and whether to ask again. What
 * they accept runs as their submission. DuckDuckGo lite, robots-permitted, runs without asking.
 */

import { createHash } from "node:crypto";
import type { Audit } from "../audit.js";
import type { Cache } from "../cache.js";
import { personPresent, type Settings } from "../config.js";
import type { BrowserTier } from "../fetch/browser.js";
import type { EngineProvider } from "./engines.js";
import {
  dedupe,
  RateLimited,
  SearchError,
  type ConfirmQuery,
  type EngineSummary,
  type QueryChoice,
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

/**
 * How long an engine that showed its bot check sits out *when nobody can be asked to pass it*: a
 * headless client retrying a refusal is hammering. With a person on call there is no cooldown — the
 * check is put to them again on the next search.
 */
export const RATE_LIMIT_COOLDOWN_MS = 5 * 60_000;

export class SearchRegistry {
  readonly web: SearchProvider[] = [];
  private readonly cooldown = new Map<string, { until: number; why: string }>();
  private confirm: ConfirmQuery | undefined;
  /** "Don't ask me again": the engine and profile the person settled on for this session. */
  private remembered: { engine: string; useProfile: boolean } | null = null;

  constructor(
    private readonly settings: Settings,
    private readonly cache: Cache,
    private readonly audit: Audit,
    /** Search-engine result-page providers (browser tier), in preference order; only available ones are used. */
    private readonly engines: EngineProvider[] = [],
    private readonly browser?: BrowserTier,
  ) {
    this.web = settings.searchMode === "off" ? [] : engines.filter((p) => p.available());
  }

  /** Install how the person is asked before an engine query runs (the MCP server's elicitation form). */
  onConfirmQuery(confirm: ConfirmQuery | undefined): void {
    this.confirm = confirm;
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

  /** Does this query need the person's say-so before it reaches `p`? */
  private mustAsk(p: SearchProvider): boolean {
    if (this.settings.humanSearch) return true;
    return !!p.needsPerson && this.remembered?.engine !== p.name;
  }

  async search(q: SearchQuery, opts: { noCache?: boolean } = {}): Promise<SearchOutcome> {
    if (this.settings.searchMode === "off") {
      throw new SearchError(
        "Search is disabled on this server (--search off). Ask the user for a URL, or fetch a site's /llms.txt to discover its pages.",
      );
    }
    // Keyed on the engine list too: a cached answer from one configuration must not be served as
    // the answer of another (`--engines` changed, or doctor probing a server with no engines).
    const key = createHash("sha1")
      .update(JSON.stringify({ ...q, engines: this.web.map((p) => p.name), v: 3 }))
      .digest("hex");
    const cached = opts.noCache
      ? null
      : this.cache.getSearch<{ results: SearchResult[]; providers: string[]; summary?: EngineSummary }>(key);
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
    const canAsk = personPresent(this.settings);

    // The person's remembered engine leads the chain; a remembered profile choice rides along.
    const providers = [...this.web];
    if (this.remembered) {
      const i = providers.findIndex((p) => p.name === this.remembered!.engine);
      if (i > 0) providers.unshift(...providers.splice(i, 1));
    }
    const offerProfile = this.browser?.browserChannel === "extension";
    let query = q.query;
    let submittedByPerson = false;
    let incognito: boolean | undefined;
    const tried = new Set<string>();

    const runOne = async (p: SearchProvider): Promise<SearchResult[]> => {
      const cd = this.cooldown.get(p.name);
      if (cd && cd.until > now) {
        notes.push(`${p.name}: skipped (${cd.why}; retrying after ${Math.ceil((cd.until - now) / 60_000)} min)`);
        return [];
      }
      tried.add(p.name);
      try {
        const r = await p.search({ ...q, query }, { submittedByPerson, incognito });
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
        const line = msg.split("\n")[0].slice(0, 200);
        if (e instanceof RateLimited && !canAsk) {
          // Nobody can pass the check for us: sit the engine out rather than retry a refusal.
          const at = new Date(now).toISOString().slice(11, 16) + " UTC";
          const why = `${p.name} refused automated clients from this address at ${at}`;
          this.cooldown.set(p.name, { until: now + RATE_LIMIT_COOLDOWN_MS, why });
          notes.push(`${line} — ${p.name} skipped for ${RATE_LIMIT_COOLDOWN_MS / 60_000} min`);
        } else {
          // Say why an answer is missing (a bot check waiting for the person, a robots.txt timeout, a
          // parse failure) instead of burying it.
          notes.push(line.startsWith(`${p.name}:`) ? line : `${p.name}: ${line}`);
        }
        return [];
      }
    };

    /** Ask the person before `p` runs. Returns the provider to run (they may have chosen another), or null to stop. */
    const ask = async (p: SearchProvider): Promise<SearchProvider | null> => {
      const reason = errors.length ? `${errors[errors.length - 1].split("\n")[0].slice(0, 200)}.` : undefined;
      const answer = await this.confirm!({
        query,
        engine: p.name,
        engines: providers.filter((x) => !tried.has(x.name)).map((x) => ({ name: x.name, label: x.label ?? x.name })),
        reason,
        offerProfile,
      });
      if (answer === "unavailable") return p; // the engine hands the search box over in the browser instead
      if (answer === "declined") {
        notes.push(`${p.name}: you declined to run this query`);
        return null;
      }
      if (answer === "unanswered") {
        const at = new Date().toISOString().slice(11, 16) + " UTC";
        notes.push(
          `${p.name}: needs your approval in your MCP client and nobody answered within ${Math.round(this.settings.handoffTimeoutMs / 1000)} s (asked at ${at}) — search again when you are at the screen`,
        );
        return null;
      }
      return this.apply(
        answer,
        p,
        providers,
        (i) => (incognito = i),
        (s) => (query = s),
        () => (submittedByPerson = true),
      );
    };

    for (const u of this.unusedEngines()) notes.push(`${u.name}: listed in --engines but not used — ${u.why}`);
    for (let i = 0; i < providers.length; i++) {
      let p = providers[i];
      if (results.length >= q.maxResults) break;
      if (tried.has(p.name)) continue;
      if (this.mustAsk(p) && this.confirm) {
        const chosen = await ask(p);
        if (!chosen) break;
        p = chosen;
      } else if (this.remembered?.engine === p.name && offerProfile) {
        incognito = !this.remembered.useProfile;
        submittedByPerson = true;
      }
      const got = await runOne(p);
      if (!got.length && !results.length) preferredFailed = true;
      results = dedupe([...results, ...got]);
    }

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

  /** Apply the person's form answer: the query they settled on, the engine, the profile, and whether to remember. */
  private apply(
    answer: QueryChoice,
    proposed: SearchProvider,
    providers: SearchProvider[],
    setIncognito: (v: boolean | undefined) => void,
    setQuery: (s: string) => void,
    markSubmitted: () => void,
  ): SearchProvider {
    setQuery(answer.query.trim() || proposed.name);
    markSubmitted();
    const offered = this.browser?.browserChannel === "extension";
    setIncognito(offered ? !answer.useProfile : undefined);
    this.remembered = answer.askAgain ? null : { engine: answer.engine, useProfile: answer.useProfile };
    return providers.find((x) => x.name === answer.engine) ?? proposed;
  }
}
