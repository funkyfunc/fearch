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

  function registry(web: SearchProvider[], env: Record<string, string> = {}) {
    const settings = settingsFromEnv(env as NodeJS.ProcessEnv, "linux");
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

  it("never cools an engine down when a person is on call: the check is put to them again next time", async () => {
    const limited = stub(
      "duckduckgo",
      [],
      "duckduckgo: DuckDuckGo lite showed its bot-check page; nobody answered",
      true,
    );
    const google = stub("google", [r("https://x.com/1")]);
    const reg = registry([limited, google], { DISPLAY: ":0" });
    await reg.search({ query: "q1", maxResults: 2 });
    const second = await reg.search({ query: "q2", maxResults: 2 });
    expect(limited.calls).toBe(2); // asked again, not skipped
    expect(second.notes.join(" ")).not.toContain("skipped");
    expect(second.notes.join(" ")).toContain("nobody answered");
  });

  describe("the query form", () => {
    const person = (
      name: string,
      results: SearchResult[],
      opts: { needsPerson?: boolean; error?: string; limited?: boolean } = {},
    ) => {
      const p = stub(name, results, opts.error, opts.limited) as SearchProvider & {
        calls: number;
        seen: Array<{ query: string; submitted?: boolean; incognito?: boolean }>;
      };
      p.needsPerson = opts.needsPerson ?? false;
      p.label = name === "google" ? "Google" : "DuckDuckGo lite";
      p.seen = [];
      const inner = p.search.bind(p);
      p.search = async (q, o) => {
        p.seen.push({ query: q.query, submitted: o?.submittedByPerson, incognito: o?.incognito });
        return inner(q, o);
      };
      return p;
    };

    it("asks before a query reaches Google, with Google preselected; DuckDuckGo runs without asking", async () => {
      const ddg = person("duckduckgo", [r("https://x.com/d")]);
      const google = person("google", [r("https://x.com/g")], { needsPerson: true });
      const asked: unknown[] = [];
      const reg = registry([ddg, google], { DISPLAY: ":0" });
      reg.onConfirmQuery(async (a) => {
        asked.push(a);
        return { query: `${a.query} edited`, engine: a.engine, incognito: true, askAgain: true };
      });
      // DuckDuckGo answers first: nobody is asked
      await reg.search({ query: "q", maxResults: 1 });
      expect(asked).toEqual([]);
      expect(ddg.seen[0]).toEqual({ query: "q", submitted: false, incognito: undefined });
      // Google first in the chain: the form appears, Google preselected, and the edited query runs as theirs
      const reg2 = registry([google, ddg], { DISPLAY: ":0" });
      reg2.onConfirmQuery(async (a) => {
        asked.push(a);
        return { query: `${a.query} edited`, engine: a.engine, incognito: true, askAgain: true };
      });
      const out = await reg2.search({ query: "q2", maxResults: 1 });
      expect(asked.length).toBe(1);
      expect(asked[0]).toMatchObject({ engine: "google", query: "q2", offerProfile: false });
      expect((asked[0] as { engines: unknown[] }).engines).toEqual([
        { name: "google", label: "Google" },
        { name: "duckduckgo", label: "DuckDuckGo lite" },
      ]);
      expect(google.seen[0]).toMatchObject({ query: "q2 edited", submitted: true });
      expect(out.providers.map((p) => p.name)).toEqual(["google"]);
      // the output names the query that ran, and says the person edited it
      expect(out.query).toBe("q2 edited");
      expect(renderResults("q2", out)).toContain(
        'Results for "q2 edited" (1, via google) — the user edited your query "q2"',
      );
    });

    it("offers the profile choice when the tier says the person's own Chrome is in play", async () => {
      const google = person("google", [r("https://x.com/g")], { needsPerson: true });
      const settings = settingsFromEnv({ DISPLAY: ":0" } as NodeJS.ProcessEnv, "linux");
      const tier = { profileChoice: () => "own-chrome" } as unknown as import("../src/fetch/browser.js").BrowserTier;
      const reg = new SearchRegistry(
        settings,
        new Cache(null),
        new Audit({ auditLog: "off", logLevel: "error" }),
        [],
        tier,
      );
      (reg as unknown as { web: SearchProvider[] }).web = [google];
      const asked: Array<{ offerProfile: boolean }> = [];
      reg.onConfirmQuery(async (a) => {
        asked.push({ offerProfile: a.offerProfile });
        return { query: a.query, engine: a.engine, incognito: true, askAgain: true };
      });
      await reg.search({ query: "q", maxResults: 1 });
      expect(asked).toEqual([{ offerProfile: true }]);
      // and the window path offers the tool profile the same way
      const win = { profileChoice: () => "tool-profile" } as unknown as import("../src/fetch/browser.js").BrowserTier;
      const reg2 = new SearchRegistry(
        settings,
        new Cache(null),
        new Audit({ auditLog: "off", logLevel: "error" }),
        [],
        win,
      );
      (reg2 as unknown as { web: SearchProvider[] }).web = [google];
      const kinds: unknown[] = [];
      reg2.onConfirmQuery(async (a) => {
        kinds.push(a.profileKind);
        return { query: a.query, engine: a.engine, incognito: false, askAgain: true };
      });
      await reg2.search({ query: "q", maxResults: 1 });
      expect(kinds).toEqual(["tool-profile"]);
      expect(google.seen[1]).toMatchObject({ incognito: false });
      expect(google.seen[0]).toMatchObject({ incognito: true }); // incognito ticked
    });

    it("lets the person switch the engine in the form, and remembers the choice when they say so", async () => {
      const ddg = person("duckduckgo", [r("https://x.com/d")]);
      const google = person("google", [r("https://x.com/g")], { needsPerson: true });
      const reg = registry([google, ddg], { DISPLAY: ":0" });
      let asks = 0;
      reg.onConfirmQuery(async (a) => {
        asks++;
        return { query: a.query, engine: "duckduckgo", incognito: true, askAgain: false };
      });
      const first = await reg.search({ query: "q1", maxResults: 1 });
      expect(first.providers.map((p) => p.name)).toEqual(["duckduckgo"]);
      expect(google.calls).toBe(0);
      // remembered: DuckDuckGo leads and nobody is asked again
      const second = await reg.search({ query: "q2", maxResults: 1 });
      expect(second.providers.map((p) => p.name)).toEqual(["duckduckgo"]);
      expect(asks).toBe(1);
      expect(google.calls).toBe(0);
    });

    it("asks again — with the reason — when the remembered engine fails and Google is next", async () => {
      const ddg = person("duckduckgo", [], {
        error: "duckduckgo: DuckDuckGo lite showed its bot-check page",
        limited: true,
      });
      const google = person("google", [r("https://x.com/g")], { needsPerson: true });
      const reg = registry([ddg, google], { DISPLAY: ":0" });
      const asked: Array<{ engine: string; reason?: string }> = [];
      reg.onConfirmQuery(async (a) => {
        asked.push({ engine: a.engine, reason: a.reason });
        return { query: a.query, engine: "google", incognito: true, askAgain: false };
      });
      const out = await reg.search({ query: "q", maxResults: 1 });
      expect(asked).toEqual([{ engine: "google", reason: "duckduckgo: DuckDuckGo lite showed its bot-check page." }]);
      expect(out.providers.map((p) => p.name)).toEqual(["google"]);
      expect(out.notes.join(" ")).toContain("bot-check page");
    });

    it("stops at a decline or an unanswered prompt, and says which", async () => {
      const google = person("google", [r("https://x.com/g")], { needsPerson: true });
      const declined = registry([google], { DISPLAY: ":0" });
      declined.onConfirmQuery(async () => "declined");
      await expect(declined.search({ query: "q", maxResults: 1 })).rejects.toThrow(/you declined to run this query/);
      const away = registry([google], { DISPLAY: ":0" });
      away.onConfirmQuery(async () => "unanswered");
      await expect(away.search({ query: "q", maxResults: 1 })).rejects.toThrow(
        /nobody answered within \d+ s \(asked at \d\d:\d\d UTC\)/,
      );
      expect(google.calls).toBe(0);
      // a client that cannot ask: the engine gets the query un-submitted and hands the box over itself
      const cli = registry([google], { DISPLAY: ":0" });
      cli.onConfirmQuery(async () => "unavailable");
      await cli.search({ query: "q", maxResults: 1 });
      expect(google.seen[0]).toMatchObject({ submitted: false });
    });

    it("--human-search asks for every engine, DuckDuckGo included", async () => {
      const ddg = person("duckduckgo", [r("https://x.com/d")]);
      const reg = registry([ddg], { DISPLAY: ":0", FEARCH_HUMAN_SEARCH: "1" });
      let asks = 0;
      reg.onConfirmQuery(async (a) => {
        asks++;
        return { query: a.query, engine: a.engine, incognito: true, askAgain: true };
      });
      await reg.search({ query: "q", maxResults: 1 });
      expect(asks).toBe(1);
      expect(ddg.seen[0]).toMatchObject({ submitted: true });
      // "ask me again: off" holds even here — the checkbox must mean what it says
      const quiet = registry([ddg], { DISPLAY: ":0", FEARCH_HUMAN_SEARCH: "1" });
      let quietAsks = 0;
      quiet.onConfirmQuery(async (a) => {
        quietAsks++;
        return { query: a.query, engine: a.engine, incognito: true, askAgain: false };
      });
      await quiet.search({ query: "q1", maxResults: 1 });
      await quiet.search({ query: "q2", maxResults: 1 });
      expect(quietAsks).toBe(1);
    });
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
