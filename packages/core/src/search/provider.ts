/** Search provider contract shared by every backend, plus result normalization. */

import type { Rendered } from "../fetch/browser.js";

export type Recency = "d" | "w" | "m" | "y";

export interface SearchQuery {
  query: string;
  maxResults: number;
  recency?: Recency;
  site?: string;
  /** Only these domains; up to three are sent to the engine as `site:` operators, all are enforced on the results. */
  allowedDomains?: string[];
}

export interface SearchResult {
  title: string;
  url: string;
  snippet: string;
  provider: string;
  excerpt?: string;
}

export interface SearchResponse {
  results: SearchResult[];
}

/**
 * The form shown to the person before a query runs on an engine that needs their say-so (Google
 * always; every engine with `--human-search`): the query, editable; the engine, with the one about
 * to be used preselected; incognito or not (the alternative being their signed-in Chrome, or fearch's
 * own Chrome profile in a window); and whether to ask again next time.
 */
export interface QueryAsk {
  query: string;
  /** The engine that is about to run — the form's default. */
  engine: string;
  engines: Array<{ name: string; label: string }>;
  /** Why the person is being asked now, when an earlier engine already failed ("DuckDuckGo showed its bot check…"). */
  reason?: string;
  offerProfile: boolean;
  /** Whose profile "use my profile" means: the person's signed-in Chrome, or the tool-owned profile of the installed Chrome. */
  profileKind?: "own-chrome" | "tool-profile";
  /** Chrome's "Allow in Incognito" for the extension: false means an incognito window cannot open, so the profile is the working default. */
  incognitoAllowed?: boolean;
}

export interface QueryChoice {
  query: string;
  engine: string;
  /** Open the engine page in an incognito window/context (no logins, nothing kept). */
  incognito: boolean;
  askAgain: boolean;
}

/**
 * Resolves to the person's choice, `"declined"`, or `"unavailable"` when nobody can be asked this
 * way — then the engine hands the search box over in the browser instead and the person presses
 * Enter. A question that must travel as the tool's result throws `QueryFormRequired` instead.
 */
export type ConfirmQuery = (ask: QueryAsk) => Promise<QueryChoice | "declined" | "unavailable">;

/**
 * Thrown by a `ConfirmQuery` whose question travels as an `input_required` result: the search stops
 * here, the tool returns the form, and the client's next call brings the answer. `tried`, `errors` and
 * `notes` let the next round skip the engines already run and keep what they said.
 */
export class QueryFormRequired extends Error {
  tried: string[] = [];
  errors: string[] = [];
  notes: string[] = [];
  constructor(readonly ask: QueryAsk) {
    super(`the query needs the person's approval (${ask.engine})`);
    this.name = "QueryFormRequired";
  }
}

/**
 * Thrown by an engine whose result page hit a bot check while the question to the person travels as
 * the tool's result: the render is suspended under `id` (see `PendingChecks`); when the answer comes
 * back, `complete` finishes the search from the resumed render. Like `QueryFormRequired`, it carries
 * what this round established so the next one can pick up where it stopped.
 */
export class SearchCheckRequired extends Error {
  tried: string[] = [];
  errors: string[] = [];
  notes: string[] = [];
  /** The form answer applied in this round, re-applied when the search resumes. */
  answer?: QueryChoice;
  constructor(
    readonly id: string,
    readonly url: string,
    readonly where: string,
    readonly engine: string,
    readonly complete: (rendered: Rendered) => Promise<SearchResponse>,
  ) {
    super(`${engine}: bot check on ${url} is waiting for the person (${id})`);
    this.name = "SearchCheckRequired";
  }
}

/** What the registry tells a provider about the person's part in this query. */
export interface SearchOptions {
  /** The person approved (and may have edited) this query in their client: it runs as their submission. */
  submittedByPerson?: boolean;
  /** Per-query override of `--incognito` for the person's own Chrome (the form's profile choice). */
  incognito?: boolean;
}

export interface SearchProvider {
  /** Short id shown in output, e.g. "google", "duckduckgo". */
  name: string;
  /** Display name for the person ("DuckDuckGo lite", "Google"); defaults to `name`. */
  label?: string;
  /** Human description of where queries go, shown in the result header. */
  disclosure: string;
  /** The engine's result pages are not robots-permitted: only a person's own act may open them. */
  needsPerson?: boolean;
  available(): boolean;
  search(q: SearchQuery, opts?: SearchOptions): Promise<SearchResponse>;
}

export class SearchError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SearchError";
  }
}

/** The engine said "slow down" or showed its bot check: the registry cools that engine down. */
export class RateLimited extends SearchError {
  constructor(message: string) {
    super(message);
    this.name = "RateLimited";
  }
}

const TRACKING = /^(utm_\w+|fbclid|gclid|msclkid|mc_cid|mc_eid|ref|ref_src|_hsenc|_hsmi|yclid)$/i;

export function canonicalize(url: string): string {
  try {
    const u = new URL(url.trim());
    const params = [...u.searchParams.entries()].filter(([k]) => !TRACKING.test(k));
    u.search = params.length ? "?" + new URLSearchParams(params).toString() : "";
    u.hash = "";
    u.hostname = u.hostname.toLowerCase().replace(/^www\./, "");
    return u.toString().replace(/\/$/, "");
  } catch {
    return url;
  }
}

export function dedupe(results: SearchResult[]): SearchResult[] {
  const seen = new Set<string>();
  const out: SearchResult[] = [];
  for (const r of results) {
    if (!r.url) continue;
    const key = canonicalize(r.url);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(r);
  }
  return out;
}

function hostMatches(host: string, domain: string): boolean {
  const h = host.toLowerCase();
  const d = domain.toLowerCase().replace(/^www\./, "");
  return h === d || h.endsWith("." + d);
}

/** Enforce `site` / `allowed_domains` on the results (the engine's own operator is a request, not a guarantee). */
export function filterDomains(results: SearchResult[], q: SearchQuery): SearchResult[] {
  return results.filter((r) => {
    let host: string;
    try {
      host = new URL(r.url).hostname;
    } catch {
      return false;
    }
    if (q.site && !hostMatches(host, q.site)) return false;
    if (q.allowedDomains?.length && !q.allowedDomains.some((d) => hostMatches(host, d))) return false;
    return true;
  });
}
