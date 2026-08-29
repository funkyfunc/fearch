/**
 * Keyless, first-party search APIs a coding agent actually needs: GitHub, StackExchange, npm,
 * crates.io, MDN, Wikipedia. Each is a documented public API used under its own terms
 * (docs/SPECTRUM.md rung 0). Used for `kind`-scoped searches and as the fallback when no general
 * web provider is available.
 */

import * as cheerio from "cheerio";
import type { HttpLike } from "../fetch/types.js";
import { dedupe, filterDomains, isoDate, SearchError, type SearchKind, type SearchProvider, type SearchQuery, type SearchResult } from "./provider.js";

type J = Record<string, any>;

async function getJson(http: HttpLike, url: string, headers: Record<string, string> = {}): Promise<J> {
  const r = await http(url, { headers: { accept: "application/json", ...headers } });
  if (r.status !== 200) throw new SearchError(`HTTP ${r.status} from ${new URL(url).host}`);
  return (await r.json()) as J;
}

/** Strip tags and decode entities (StackExchange excerpts contain both, e.g. `&hellip;`). */
const strip = (html: string) => cheerio.load(`<x>${html}</x>`)("x").text().replace(/\s+/g, " ").trim();

abstract class Base implements SearchProvider {
  abstract name: string;
  abstract disclosure: string;
  abstract kinds: SearchKind[];
  posture: SearchProvider["posture"] = "official";
  constructor(protected readonly http: HttpLike) {}
  available(): boolean {
    return true;
  }
  abstract search(q: SearchQuery): Promise<SearchResult[]>;
}

export class GitHubProvider extends Base {
  name = "github";
  disclosure = "GitHub search API (repositories, issues; code search when GITHUB_TOKEN is set)";
  kinds: SearchKind[] = ["code"];

  async search(q: SearchQuery): Promise<SearchResult[]> {
    const n = Math.min(q.maxResults, 10);
    const headers: Record<string, string> = { accept: "application/vnd.github+json" };
    const tok = process.env.GITHUB_TOKEN;
    if (tok) headers.authorization = `Bearer ${tok}`;
    const qs = encodeURIComponent(q.query);
    const out: SearchResult[] = [];
    const repos = await getJson(this.http, `https://api.github.com/search/repositories?q=${qs}&per_page=${n}`, headers).catch(() => null);
    for (const it of (repos?.items ?? []) as J[]) {
      out.push({ title: `${it.full_name} (★${it.stargazers_count})`, url: it.html_url, snippet: `${it.description ?? ""} · ${it.language ?? ""}`.trim(), provider: this.name, date: isoDate(it.pushed_at) });
    }
    // Issue search is noisy for general questions; include it only for explicit code searches.
    if (q.kind === "code") {
      const issues = await getJson(this.http, `https://api.github.com/search/issues?q=${qs}&per_page=${n}`, headers).catch(() => null);
      for (const it of (issues?.items ?? []) as J[]) {
        const kind = it.pull_request ? "PR" : "issue";
        out.push({ title: `${it.title} (${kind} ${it.state})`, url: it.html_url, snippet: String(it.body ?? "").replace(/\s+/g, " ").slice(0, 240), provider: this.name, date: isoDate(it.updated_at) });
      }
    }
    if (tok) {
      const code = await getJson(this.http, `https://api.github.com/search/code?q=${qs}&per_page=${n}`, headers).catch(() => null);
      for (const it of (code?.items ?? []) as J[]) {
        out.push({ title: `${it.repository?.full_name}/${it.path}`, url: it.html_url, snippet: "code match", provider: this.name });
      }
    }
    if (!out.length) throw new SearchError("github: no results");
    return filterDomains(dedupe(out), q).slice(0, q.maxResults);
  }
}

export class StackExchangeProvider extends Base {
  name = "stackexchange";
  disclosure = "StackExchange API (StackOverflow; content is CC BY-SA 4.0 — attribute authors when reusing)";
  kinds: SearchKind[] = ["qa"];

  async search(q: SearchQuery): Promise<SearchResult[]> {
    const url = `https://api.stackexchange.com/2.3/search/excerpts?order=desc&sort=relevance&q=${encodeURIComponent(q.query)}&site=stackoverflow&pagesize=${Math.min(q.maxResults, 15)}`;
    const data = await getJson(this.http, url);
    const items = ((data.items ?? []) as J[]).filter((i) => i.item_type === "question");
    const out = items.map((i) => ({
      title: `${strip(String(i.title))} (score ${i.score}${i.is_answered ? ", answered" : ""})`,
      url: `https://stackoverflow.com/questions/${i.question_id}`,
      snippet: strip(String(i.excerpt ?? "")).slice(0, 300),
      provider: this.name,
      date: isoDate(i.last_activity_date ?? i.creation_date),
    }));
    if (!out.length) throw new SearchError("stackexchange: no results");
    return filterDomains(dedupe(out), q).slice(0, q.maxResults);
  }
}

export class NpmProvider extends Base {
  name = "npm";
  disclosure = "npm registry search API";
  kinds: SearchKind[] = ["packages"];

  async search(q: SearchQuery): Promise<SearchResult[]> {
    const data = await getJson(this.http, `https://registry.npmjs.org/-/v1/search?text=${encodeURIComponent(q.query)}&size=${Math.min(q.maxResults, 10)}`);
    const out = ((data.objects ?? []) as J[]).map((o) => {
      const p = o.package as J;
      return { title: `${p.name} ${p.version}`, url: `https://www.npmjs.com/package/${p.name}`, snippet: String(p.description ?? "").slice(0, 300), provider: this.name, date: isoDate(p.date) };
    });
    if (!out.length) throw new SearchError("npm: no results");
    return filterDomains(dedupe(out), q).slice(0, q.maxResults);
  }
}

export class CratesProvider extends Base {
  name = "crates";
  disclosure = "crates.io API";
  kinds: SearchKind[] = ["packages"];

  async search(q: SearchQuery): Promise<SearchResult[]> {
    const data = await getJson(this.http, `https://crates.io/api/v1/crates?q=${encodeURIComponent(q.query)}&per_page=${Math.min(q.maxResults, 10)}`);
    const out = ((data.crates ?? []) as J[]).map((c) => ({
      title: `${c.name} ${c.max_version}`,
      url: `https://crates.io/crates/${c.name}`,
      snippet: String(c.description ?? "").slice(0, 300),
      provider: this.name,
      date: isoDate(c.updated_at),
    }));
    if (!out.length) throw new SearchError("crates: no results");
    return filterDomains(dedupe(out), q).slice(0, q.maxResults);
  }
}

export class MdnProvider extends Base {
  name = "mdn";
  disclosure = "MDN Web Docs site search API";
  kinds: SearchKind[] = ["docs"];

  async search(q: SearchQuery): Promise<SearchResult[]> {
    const data = await getJson(this.http, `https://developer.mozilla.org/api/v1/search?q=${encodeURIComponent(q.query)}&locale=en-US`);
    const out = ((data.documents ?? []) as J[]).slice(0, q.maxResults).map((d) => ({
      title: String(d.title),
      url: `https://developer.mozilla.org${d.mdn_url}`,
      snippet: String(d.summary ?? "").slice(0, 300),
      provider: this.name,
    }));
    if (!out.length) throw new SearchError("mdn: no results");
    return filterDomains(dedupe(out), q).slice(0, q.maxResults);
  }
}

export class WikipediaProvider extends Base {
  name = "wikipedia";
  disclosure = "Wikipedia search API (articles are CC BY-SA 4.0)";
  kinds: SearchKind[] = ["docs"];

  async search(q: SearchQuery): Promise<SearchResult[]> {
    const url = `https://en.wikipedia.org/w/api.php?action=query&list=search&format=json&srlimit=${Math.min(q.maxResults, 10)}&srsearch=${encodeURIComponent(q.query)}`;
    const data = await getJson(this.http, url);
    const out = ((data.query?.search ?? []) as J[]).map((s) => ({
      title: String(s.title),
      url: `https://en.wikipedia.org/wiki/${encodeURIComponent(String(s.title).replace(/ /g, "_"))}`,
      snippet: strip(String(s.snippet ?? "")).slice(0, 300),
      provider: this.name,
    }));
    if (!out.length) throw new SearchError("wikipedia: no results");
    return filterDomains(dedupe(out), q).slice(0, q.maxResults);
  }
}

export class HackerNewsProvider extends Base {
  name = "hackernews";
  disclosure = "Hacker News search (Algolia public API)";
  kinds: SearchKind[] = ["community"];

  async search(q: SearchQuery): Promise<SearchResult[]> {
    const run = (query: string) => getJson(this.http, `https://hn.algolia.com/api/v1/search?query=${encodeURIComponent(query)}&tags=story&hitsPerPage=${Math.min(q.maxResults, 15)}`);
    let data = await run(q.query);
    if (!(data.hits ?? []).length) {
      // Algolia ANDs every term; retry with the three most specific words of a long query.
      const words = q.query.split(/\s+/).filter((w) => w.length > 3 && !/^(what|which|when|where|does|with|from|that|this|about|into|your|have)$/i.test(w));
      if (words.length > 3) data = await run(words.sort((a, b) => b.length - a.length).slice(0, 3).join(" "));
    }
    const out = ((data.hits ?? []) as J[]).map((h) => ({
      title: `${h.title ?? "(untitled)"} (${h.points ?? 0} points, ${h.num_comments ?? 0} comments)`,
      url: String(h.url || `https://news.ycombinator.com/item?id=${h.objectID}`),
      snippet: `HN discussion: https://news.ycombinator.com/item?id=${h.objectID}`,
      provider: this.name,
      date: isoDate(h.created_at),
    }));
    if (!out.length) throw new SearchError("hackernews: no results");
    return filterDomains(dedupe(out), q).slice(0, q.maxResults);
  }
}

export class ArxivProvider extends Base {
  name = "arxiv";
  disclosure = "arXiv export API (Atom; ≤1 request / 3 s)";
  kinds: SearchKind[] = ["papers"];

  async search(q: SearchQuery): Promise<SearchResult[]> {
    const url = `https://export.arxiv.org/api/query?search_query=all:${encodeURIComponent(q.query)}&max_results=${Math.min(q.maxResults, 10)}&sortBy=relevance`;
    const r = await this.http(url, { headers: { accept: "application/atom+xml" } });
    if (r.status !== 200) throw new SearchError(`arxiv: HTTP ${r.status}`);
    const $ = cheerio.load(await r.text(), { xml: true });
    const out: SearchResult[] = [];
    $("entry").each((_, e) => {
      const id = $(e).children("id").text().trim();
      const abs = $(e).children("summary").text().replace(/\s+/g, " ").trim();
      out.push({
        title: $(e).children("title").text().replace(/\s+/g, " ").trim(),
        url: id.replace(/^http:/, "https:"),
        snippet: abs.slice(0, 300),
        provider: this.name,
        date: isoDate($(e).children("published").text().trim()),
      });
    });
    if (!out.length) throw new SearchError("arxiv: no results");
    return filterDomains(dedupe(out), q).slice(0, q.maxResults);
  }
}

export class OpenAlexProvider extends Base {
  name = "openalex";
  disclosure = "OpenAlex API (scholarly index, CC0 metadata)";
  kinds: SearchKind[] = ["papers"];

  async search(q: SearchQuery): Promise<SearchResult[]> {
    const mailto = process.env.OPENALEX_MAILTO ? `&mailto=${encodeURIComponent(process.env.OPENALEX_MAILTO)}` : "";
    const data = await getJson(this.http, `https://api.openalex.org/works?search=${encodeURIComponent(q.query)}&per-page=${Math.min(q.maxResults, 10)}${mailto}`);
    const out = ((data.results ?? []) as J[]).map((w) => {
      const loc = (w.primary_location ?? {}) as J;
      const venue = (loc.source ?? {}) as J;
      return {
        title: String(w.display_name ?? w.title ?? ""),
        url: String(loc.landing_page_url || w.doi || w.id),
        snippet: `${venue.display_name ? venue.display_name + " · " : ""}${w.cited_by_count ?? 0} citations`,
        provider: this.name,
        date: isoDate(w.publication_date),
      };
    });
    if (!out.length) throw new SearchError("openalex: no results");
    return filterDomains(dedupe(out), q).slice(0, q.maxResults);
  }
}

export class SemanticScholarProvider extends Base {
  name = "semanticscholar";
  disclosure = "Semantic Scholar Graph API (keyless shared pool)";
  kinds: SearchKind[] = ["papers"];

  async search(q: SearchQuery): Promise<SearchResult[]> {
    const data = await getJson(this.http, `https://api.semanticscholar.org/graph/v1/paper/search?query=${encodeURIComponent(q.query)}&limit=${Math.min(q.maxResults, 10)}&fields=title,url,abstract,year,citationCount,publicationDate`);
    const out = ((data.data ?? []) as J[]).map((p) => ({
      title: String(p.title ?? ""),
      url: String(p.url),
      snippet: `${p.year ?? ""} · ${p.citationCount ?? 0} citations · ${String(p.abstract ?? "").replace(/\s+/g, " ").slice(0, 200)}`.trim(),
      provider: this.name,
      date: isoDate(p.publicationDate ?? (p.year ? `${p.year}-01-01` : undefined)),
    }));
    if (!out.length) throw new SearchError("semanticscholar: no results");
    return filterDomains(dedupe(out), q).slice(0, q.maxResults);
  }
}

export class MarginaliaProvider extends Base {
  name = "marginalia";
  disclosure = "Marginalia Search (independent index; public shared key, CC BY-NC-SA 4.0 results)";
  kinds: SearchKind[] = ["web"];

  async search(q: SearchQuery): Promise<SearchResult[]> {
    const r = await this.http(`https://api2.marginalia-search.com/search?query=${encodeURIComponent(q.query)}&count=${Math.min(q.maxResults, 20)}`, { headers: { accept: "application/json", "api-key": "public" } });
    if (r.status === 503) throw new SearchError("marginalia: shared public key rate-limited");
    if (r.status !== 200) throw new SearchError(`marginalia: HTTP ${r.status}`);
    const data = (await r.json()) as J;
    const out = ((data.results ?? []) as J[]).map((x) => ({ title: String(x.title ?? ""), url: String(x.url), snippet: String(x.description ?? "").slice(0, 300), provider: this.name }));
    if (!out.length) throw new SearchError("marginalia: no results");
    return filterDomains(dedupe(out), q).slice(0, q.maxResults);
  }
}

/** Order matters for the interleaved fallbacks: Q&A/docs/community first, code, then package and paper indexes. */
export function federationProviders(http: HttpLike): SearchProvider[] {
  return [
    new StackExchangeProvider(http),
    new MdnProvider(http),
    new HackerNewsProvider(http),
    new WikipediaProvider(http),
    new GitHubProvider(http),
    new MarginaliaProvider(http),
    new NpmProvider(http),
    new CratesProvider(http),
    new ArxivProvider(http),
    new OpenAlexProvider(http),
    new SemanticScholarProvider(http),
  ];
}
