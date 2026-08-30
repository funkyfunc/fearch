import { describe, expect, it } from "vitest";
import { Audit } from "../src/audit.js";
import { Cache } from "../src/cache.js";
import { settingsFromEnv } from "../src/config.js";
import type { HttpLike } from "../src/fetch/types.js";
import { parseExaToolText } from "../src/search/exa-hosted.js";
import {
  ArxivProvider,
  GitHubProvider,
  HackerNewsProvider,
  MarginaliaProvider,
  MdnProvider,
  OpenAlexProvider,
  StackExchangeProvider,
} from "../src/search/federation.js";
import {
  canonicalize,
  dedupe,
  filterDomains,
  SearchError,
  type SearchProvider,
  type SearchResult,
} from "../src/search/provider.js";
import { SearchRegistry } from "../src/search/registry.js";
import { renderResults } from "../src/search/render.js";

function fakeHttp(routes: Record<string, unknown>, seen: Array<{ url: string; init?: unknown }> = []): HttpLike {
  return async (url, init) => {
    seen.push({ url, init });
    const key = url.split("?")[0];
    for (const [prefix, payload] of Object.entries(routes)) {
      if (key.startsWith(prefix)) {
        return {
          status: 200,
          headers: { "content-type": "application/json" },
          text: async () => JSON.stringify(payload),
          json: async () => payload,
        };
      }
    }
    return { status: 404, headers: {}, text: async () => "", json: async () => ({}) };
  };
}

const r = (url: string, title = "t"): SearchResult => ({ title, url, snippet: "s", provider: "p" });

describe("provider helpers", () => {
  it("canonicalizes and dedupes", () => {
    expect(canonicalize("https://WWW.Example.com/p?utm_source=x&a=1&fbclid=2#frag")).toBe("https://example.com/p?a=1");
    expect(
      dedupe([r("https://example.com/p?utm_source=x"), r("https://www.example.com/p/"), r("https://example.com/q")])
        .length,
    ).toBe(2);
  });
  it("filters domains", () => {
    const rs = [r("https://docs.python.org/3/x"), r("https://example.com/y")];
    expect(filterDomains(rs, { query: "", maxResults: 5, site: "docs.python.org" }).length).toBe(1);
    expect(filterDomains(rs, { query: "", maxResults: 5, blockedDomains: ["example.com"] }).length).toBe(1);
    expect(filterDomains(rs, { query: "", maxResults: 5, allowedDomains: ["python.org"] }).length).toBe(1);
  });
});

describe("exa hosted parsing", () => {
  it("parses JSON and text shapes", () => {
    const json = parseExaToolText(
      JSON.stringify({ results: [{ title: "A", url: "https://a.test/", highlights: ["h1", "h2"] }] }),
      "exa-hosted",
    );
    expect(json).toEqual([{ title: "A", url: "https://a.test/", snippet: "h1 h2", provider: "exa-hosted" }]);
    const text = parseExaToolText(
      "Title: B\nURL: https://b.test/x\nPublished: 2026\nSome summary here.\n\nTitle: C\nURL: https://c.test/\nMore.",
      "exa-hosted",
    );
    expect(text.map((x) => x.url)).toEqual(["https://b.test/x", "https://c.test/"]);
    expect(text[0].snippet).toBe("Some summary here.");
  });
});

describe("federation providers", () => {
  it("github merges repos and issues for code searches, repos only otherwise", async () => {
    const http = fakeHttp({
      "https://api.github.com/search/repositories": {
        items: [
          {
            full_name: "o/r",
            stargazers_count: 5,
            html_url: "https://github.com/o/r",
            description: "d",
            language: "Go",
            pushed_at: "2026-01-01T12:00:00Z",
          },
        ],
      },
      "https://api.github.com/search/issues": {
        items: [{ title: "Bug", state: "open", html_url: "https://github.com/o/r/issues/1", body: "b" }],
      },
    });
    const code = (await new GitHubProvider(http).search({ query: "q", maxResults: 5, kind: "code" })).results;
    expect(code.map((x) => x.url)).toEqual(["https://github.com/o/r", "https://github.com/o/r/issues/1"]);
    expect(code[0].date).toBe("2026-01-01");
    const web = (await new GitHubProvider(http).search({ query: "q", maxResults: 5 })).results;
    expect(web.map((x) => x.url)).toEqual(["https://github.com/o/r"]);
  });
  it("stackexchange and mdn", async () => {
    const http = fakeHttp({
      "https://api.stackexchange.com/2.3/search/excerpts": {
        items: [
          {
            item_type: "question",
            title: "How &amp; why?",
            score: 3,
            is_answered: true,
            question_id: 42,
            excerpt: "<b>x</b> y",
          },
        ],
      },
      "https://developer.mozilla.org/api/v1/search": {
        documents: [{ title: "Array.prototype.map()", mdn_url: "/en-US/docs/x", summary: "s" }],
      },
    });
    const so = (await new StackExchangeProvider(http).search({ query: "q", maxResults: 5 })).results;
    expect(so[0]).toMatchObject({
      title: "How & why? (score 3, answered)",
      url: "https://stackoverflow.com/questions/42",
      snippet: "x y",
    });
    const mdn = (await new MdnProvider(http).search({ query: "q", maxResults: 5 })).results;
    expect(mdn[0].url).toBe("https://developer.mozilla.org/en-US/docs/x");
  });
});

describe("new keyless providers", () => {
  it("hacker news, openalex, marginalia parse their shapes", async () => {
    const http = fakeHttp({
      "https://hn.algolia.com/api/v1/search": {
        hits: [
          {
            title: "Show HN: Thing",
            url: "https://thing.test/",
            objectID: "123",
            points: 42,
            num_comments: 7,
            created_at: "2026-05-01T10:00:00.000Z",
          },
          { title: "Ask HN", url: null, objectID: "124", points: 3 },
        ],
      },
      "https://api.openalex.org/works": {
        results: [
          {
            display_name: "Paper A",
            id: "https://openalex.org/W1",
            doi: "https://doi.org/10.1/x",
            primary_location: { landing_page_url: "https://journal.test/a", source: { display_name: "JOSS" } },
            cited_by_count: 12,
            publication_date: "2025-03-04",
          },
        ],
      },
      "https://api2.marginalia-search.com/search": {
        results: [{ url: "https://blog.test/post", title: "A post", description: "d" }],
        license: "CC-BY-NC-SA",
      },
    });
    const hn = (await new HackerNewsProvider(http).search({ query: "q", maxResults: 5 })).results;
    expect(hn[0]).toMatchObject({
      title: "Show HN: Thing (42 points, 7 comments)",
      url: "https://thing.test/",
      date: "2026-05-01",
    });
    expect(hn[1].url).toBe("https://news.ycombinator.com/item?id=124");
    const oa = (await new OpenAlexProvider(http).search({ query: "q", maxResults: 5 })).results;
    expect(oa[0]).toMatchObject({ title: "Paper A", url: "https://journal.test/a", date: "2025-03-04" });
    expect(oa[0].snippet).toContain("JOSS");
    const mg = (await new MarginaliaProvider(http).search({ query: "q", maxResults: 5 })).results;
    expect(mg[0].url).toBe("https://blog.test/post");
  });

  it("arxiv parses Atom", async () => {
    const atom = `<?xml version="1.0"?><feed xmlns="http://www.w3.org/2005/Atom"><entry><id>http://arxiv.org/abs/2511.16397v2</id><title>AICC: Parse HTML\n Finer</title><summary> An abstract. </summary><published>2025-11-20T00:00:00Z</published></entry></feed>`;
    const http: HttpLike = async () => ({ status: 200, headers: {}, text: async () => atom, json: async () => ({}) });
    const out = (await new ArxivProvider(http).search({ query: "q", maxResults: 5 })).results;
    expect(out[0]).toMatchObject({
      title: "AICC: Parse HTML Finer",
      url: "https://arxiv.org/abs/2511.16397v2",
      snippet: "An abstract.",
      date: "2025-11-20",
    });
  });
});

describe("search modes", () => {
  it("first-party mode has no web providers; off mode refuses with guidance", async () => {
    const fp = new SearchRegistry(
      settingsFromEnv({ FEARCH_SEARCH_MODE: "first-party" } as NodeJS.ProcessEnv),
      new Cache(null),
      new Audit({ auditLog: "off", logLevel: "error" }),
      fakeHttp({}),
    );
    expect(fp.web.length).toBe(0);
    expect(fp.federation.length).toBeGreaterThan(5);
    expect(fp.describe()).toContain("mode=first-party");
    const off = new SearchRegistry(
      settingsFromEnv({ FEARCH_SEARCH_MODE: "off" } as NodeJS.ProcessEnv),
      new Cache(null),
      new Audit({ auditLog: "off", logLevel: "error" }),
      fakeHttp({}),
    );
    await expect(off.search({ query: "q", maxResults: 3 })).rejects.toThrow(/disabled/);
  });
});

describe("registry", () => {
  const stub = (
    name: string,
    results: SearchResult[] = [],
    error?: string,
    kinds: SearchProvider["kinds"] = ["web"],
  ): SearchProvider & { calls: number } => ({
    name,
    disclosure: `${name} disclosure`,
    kinds,
    posture: "official",
    calls: 0,
    available: () => true,
    async search() {
      this.calls++;
      if (error) throw new SearchError(error);
      return { results };
    },
  });

  function registry(web: SearchProvider[], federation: SearchProvider[]) {
    const settings = settingsFromEnv({ FEARCH_EXA_HOSTED_URL: "" } as NodeJS.ProcessEnv);
    const reg = new SearchRegistry(
      settings,
      new Cache(null),
      new Audit({ auditLog: "off", logLevel: "error" }),
      fakeHttp({}),
    );
    (reg as unknown as { web: SearchProvider[] }).web = web;
    (reg as unknown as { federation: SearchProvider[] }).federation = federation;
    return reg;
  }

  it("runs the web chain in order, dedupes, caches, and falls back to federation", async () => {
    const a = stub("a", [r("https://x.com/1"), r("https://x.com/2")]);
    const b = stub("b", [], "b down");
    const c = stub("c", [r("https://x.com/2?utm_source=z"), r("https://x.com/3")]);
    const gh = stub("github", [r("https://github.com/o/r")], undefined, ["code"]);
    const reg = registry([a, b, c], [gh]);
    const o = await reg.search({ query: "q", maxResults: 3 });
    expect(o.results.map((x) => x.url)).toEqual(["https://x.com/1", "https://x.com/2", "https://x.com/3"]);
    expect(o.providers.map((p) => p.name)).toEqual(["a", "c"]);
    const again = await reg.search({ query: "q", maxResults: 3 });
    expect(again.fromCache).toBe(true);
    expect(a.calls).toBe(1);

    const allDown = registry([stub("a", [], "down")], [gh]);
    const fb = await allDown.search({ query: "q2", maxResults: 3 });
    expect(fb.fellBackToFederation).toBe(true);
    expect(fb.results[0].url).toBe("https://github.com/o/r");
    // a fallback answer is not cached: the preferred provider gets another chance next call
    expect((await allDown.search({ query: "q2", maxResults: 3 })).fromCache).toBe(false);
    const partial = registry([stub("a", [], "a down"), c], [gh]);
    await partial.search({ query: "q4", maxResults: 3 });
    expect((await partial.search({ query: "q4", maxResults: 3 })).fromCache).toBe(false);
    expect(c.calls).toBe(3);

    const kind = await registry([a], [gh]).search({ query: "q3", maxResults: 3, kind: "code" });
    expect(kind.providers.map((p) => p.name)).toEqual(["github"]);
    expect(a.calls).toBe(1);
  });

  it("interleaves peer providers for kind searches and cools down a rate-limited provider", async () => {
    const mdn = stub("mdn", [r("https://mdn.test/1"), r("https://mdn.test/2"), r("https://mdn.test/3")], undefined, [
      "docs",
    ]);
    const wiki = stub("wikipedia", [r("https://wiki.test/1")], undefined, ["docs"]);
    const o = await registry([], [mdn, wiki]).search({ query: "q", maxResults: 3, kind: "docs" });
    expect(o.results.map((x) => x.url)).toEqual(["https://mdn.test/1", "https://wiki.test/1", "https://mdn.test/2"]);

    const limited = stub(
      "exa-hosted",
      [],
      "exa-hosted: rate-limited (keyless casual-use tier); waiting a few minutes lifts it.",
    );
    const gh = stub("github", [r("https://github.com/o/r")], undefined, ["code"]);
    const reg = registry([limited], [gh]);
    const first = await reg.search({ query: "q1", maxResults: 2 });
    expect(first.fellBackToFederation).toBe(true);
    expect(first.notes.join(" ")).toContain("rate-limited");
    const second = await reg.search({ query: "q2", maxResults: 2 });
    expect(limited.calls).toBe(1); // on cooldown: not called again
    expect(second.notes.join(" ")).toContain("skipped");
    expect(renderResults("q2", second)).toContain("Note: exa-hosted: skipped");
  });

  it("errors when nothing works", async () => {
    await expect(
      registry([stub("a", [], "a down")], [stub("stackexchange", [], "so down", ["qa"])]).search({
        query: "q",
        maxResults: 2,
      }),
    ).rejects.toThrow(/a down; so down/);
  });

  it("renders with disclosure", () => {
    const a = stub("a", [r("https://x.com/1", "One")]);
    const text = renderResults("q", {
      results: [{ ...r("https://x.com/1", "One"), excerpt: "e1\ne2", date: "2026-04-23" }],
      providers: [a],
      fromCache: false,
      fellBackToFederation: false,
      notes: [],
    });
    expect(text).toContain("https://x.com/1 · 2026-04-23");
    expect(text).toContain('Results for "q" (1, via a):');
    expect(text).toContain("Provider: a disclosure");
    expect(text).toContain("1. **One** — https://x.com/1");
    expect(text).toContain("   > e1\n   > e2");
  });
});
