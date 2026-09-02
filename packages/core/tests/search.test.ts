import { describe, expect, it } from "vitest";
import { Audit } from "../src/audit.js";
import { Cache } from "../src/cache.js";
import { settingsFromEnv } from "../src/config.js";
import {
  canonicalize,
  dedupe,
  filterDomains,
  RateLimited,
  SearchError,
  type SearchProvider,
  type SearchResult,
} from "../src/search/provider.js";
import { SearchRegistry } from "../src/search/registry.js";
import { renderResults } from "../src/search/render.js";

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

describe("registry", () => {
  const stub = (
    name: string,
    results: SearchResult[] = [],
    error?: string,
    limited = false,
  ): SearchProvider & { calls: number } => ({
    name,
    disclosure: `${name} disclosure`,
    posture: "official",
    calls: 0,
    available: () => true,
    async search() {
      this.calls++;
      if (error) throw limited ? new RateLimited(error) : new SearchError(error);
      return { results };
    },
  });

  function registry(web: SearchProvider[]) {
    const settings = settingsFromEnv({} as NodeJS.ProcessEnv, "linux");
    const reg = new SearchRegistry(settings, new Cache(null), new Audit({ auditLog: "off", logLevel: "error" }));
    (reg as unknown as { web: SearchProvider[] }).web = web;
    return reg;
  }

  it("runs the engine chain in order, dedupes, caches clean outcomes, and retries a failed leader", async () => {
    const a = stub("a", [r("https://x.com/1"), r("https://x.com/2")]);
    const b = stub("b", [], "b down");
    const c = stub("c", [r("https://x.com/2?utm_source=z"), r("https://x.com/3")]);
    const reg = registry([a, b, c]);
    const o = await reg.search({ query: "q", maxResults: 3 });
    expect(o.results.map((x) => x.url)).toEqual(["https://x.com/1", "https://x.com/2", "https://x.com/3"]);
    expect(o.providers.map((p) => p.name)).toEqual(["a", "c"]);
    const again = await reg.search({ query: "q", maxResults: 3 });
    expect(again.fromCache).toBe(true);
    expect(a.calls).toBe(1);

    // a leader that failed is retried on the next call: the partial outcome is not cached
    const partial = registry([stub("a", [], "a down"), c]);
    await partial.search({ query: "q4", maxResults: 3 });
    expect((await partial.search({ query: "q4", maxResults: 3 })).fromCache).toBe(false);
    expect(c.calls).toBe(3);
  });

  it("cools down a rate-limited engine and says so; other failures are surfaced as notes", async () => {
    const limited = stub("slowpoke", [], "slowpoke: rate-limited (HTTP 429); waiting a few minutes lifts it.", true);
    const ddg = stub("duckduckgo", [r("https://x.com/1")]);
    const reg = registry([limited, ddg]);
    const first = await reg.search({ query: "q1", maxResults: 2 });
    expect(first.results.length).toBe(1);
    expect(first.notes.join(" ")).toContain("rate-limited");
    const second = await reg.search({ query: "q2", maxResults: 2 });
    expect(limited.calls).toBe(1); // on cooldown: not called again
    expect(second.notes.join(" ")).toContain("skipped");
    expect(renderResults("q2", second)).toContain("Note: slowpoke: skipped");

    // a non-rate-limit failure (robots timeout, parse error) is named, not buried
    const broken = stub("duckduckgo", [], "duckduckgo: robots.txt unavailable (connection timed out)");
    const ok = stub("google", [r("https://x.com/2")]);
    const out = await registry([broken, ok]).search({ query: "q3", maxResults: 2 });
    expect(out.notes.join(" ")).toContain("robots.txt unavailable");
  });

  it("fails honestly when no engine answers — no silent substitution", async () => {
    await expect(registry([stub("a", [], "a down")]).search({ query: "q", maxResults: 2 })).rejects.toThrow(
      /No results \(a down.*Fetch a URL you already know/s,
    );
  });

  it("renders with disclosure", () => {
    const a = stub("a", [r("https://x.com/1", "One")]);
    const text = renderResults("q", {
      results: [{ ...r("https://x.com/1", "One"), excerpt: "e1\ne2", date: "2026-04-23" }],
      providers: [a],
      fromCache: false,
      notes: [],
    });
    expect(text).toContain("https://x.com/1 · 2026-04-23");
    expect(text).toContain('Results for "q" (1, via a):');
    expect(text).toContain("Provider: a disclosure");
    expect(text).toContain("1. **One** — https://x.com/1");
    expect(text).toContain("   > e1\n   > e2");
  });
});
