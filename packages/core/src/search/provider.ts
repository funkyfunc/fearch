/** Search provider contract shared by every backend, plus result normalization. */

export type Recency = "d" | "w" | "m" | "y";

export interface SearchQuery {
  query: string;
  maxResults: number;
  recency?: Recency;
  site?: string;
  allowedDomains?: string[];
  blockedDomains?: string[];
}

export interface SearchResult {
  title: string;
  url: string;
  snippet: string;
  provider: string;
  /** ISO date (YYYY-MM-DD) when the provider knows it: published/updated/last activity. */
  date?: string;
  excerpt?: string;
}

/** Normalize a provider's date-ish value (ISO string, RFC date, or epoch seconds) to YYYY-MM-DD. */
export function isoDate(v: unknown): string | undefined {
  if (v === undefined || v === null || v === "") return undefined;
  const t = typeof v === "number" ? (v < 1e12 ? v * 1000 : v) : Date.parse(String(v));
  if (!Number.isFinite(t)) return undefined;
  const d = new Date(t);
  return d.getFullYear() > 1995 ? d.toISOString().slice(0, 10) : undefined;
}

/**
 * An answer box the engine itself generated (Google's AI Overview). It is that engine's model's
 * claim, not a fact: always shown labelled, with the sources it cited, never merged into results.
 */
export interface EngineSummary {
  text: string;
  sources: Array<{ title: string; url: string }>;
  provider: string;
}

export interface SearchResponse {
  results: SearchResult[];
  summary?: EngineSummary;
}

export interface SearchProvider {
  /** Short id shown in output, e.g. "google", "duckduckgo". */
  name: string;
  /** Human description of where queries go, shown in the result header. */
  disclosure: string;
  /** Posture per docs/SPECTRUM.md: official API, or a result page opened in the browser tier. */
  posture: "official" | "browser";
  available(): boolean;
  search(q: SearchQuery): Promise<SearchResponse>;
}

export class SearchError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SearchError";
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
  return h === d || h.endsWith("." + d) || h === "www." + d;
}

/** Apply site / allowed / blocked domain filters client-side (providers may not support them). */
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
    if (q.blockedDomains?.length && q.blockedDomains.some((d) => hostMatches(host, d))) return false;
    return true;
  });
}

export function recencyToDays(r?: Recency): number | undefined {
  return r ? { d: 1, w: 7, m: 31, y: 365 }[r] : undefined;
}
