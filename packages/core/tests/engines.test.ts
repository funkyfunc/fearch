/** Engine result pages via the browser tier: parsers, robots-gated eligibility, the human handoff. */
import { mkdtempSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { Cache } from "../src/cache.js";
import { acceptLanguage, settingsFromArgs, settingsFromEnv, type Settings } from "../src/config.js";
import { waitForHuman, type BrowserRenderer } from "../src/fetch/browser.js";
import { RobotsChecker } from "../src/fetch/robots.js";
import { Politeness } from "../src/politeness.js";
import {
  ENGINE_SPECS,
  EngineProvider,
  engineProviders,
  ddgChallenge,
  parseGoogle,
  parseLite,
  scopedQuery,
  redactAccount,
} from "../src/search/engines.js";
import { RateLimited, SearchError } from "../src/search/provider.js";
import { renderResults } from "../src/search/render.js";
import { SearchRegistry } from "../src/search/registry.js";
import { Audit } from "../src/audit.js";

const LITE = `<html><body><table>
<tr><td><a class="result-link" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fgithub.com%2Fmixmark-io%2Fturndown-plugin-gfm&rut=x">mixmark-io/turndown-plugin-gfm</a></td></tr>
<tr><td class="result-snippet">A Turndown plugin which adds GitHub Flavored Markdown extensions.</td></tr>
<tr><td><a class="result-link" href="https://www.npmjs.com/package/turndown-plugin-gfm">turndown-plugin-gfm - npm</a></td></tr>
<tr><td class="result-snippet">Turndown plugin to add GFM extensions.</td></tr>
<tr><td><a class="result-link" href="https://duckduckgo.com/">DuckDuckGo</a></td></tr>
</table></body></html>`;
const BOTCHECK = `<html><head><title>DuckDuckGo</title></head><body><div id="challenge">anomaly detected</div></body></html>`;

const GOOGLE = `<html><body><div id="search">
<div class="g" data-hveid="1"><a href="https://www.npmjs.com/package/@joplin/turndown-plugin-gfm"><h3>@joplin/turndown-plugin-gfm - npm</h3></a><div class="VwiC3b">A Turndown plugin which adds GitHub Flavored Markdown extensions.</div></div>
<div class="g" data-hveid="2"><a href="/url?q=https://github.com/trutohq/turndown-plugin-gfm&sa=U"><h3>GitHub - trutohq/turndown-plugin-gfm</h3></a><div class="VwiC3b">Enhanced Turndown plugin.</div></div>
<div class="g" data-hveid="3"><a href="https://www.google.com/search?q=more"><h3>More results</h3></a></div>
</div></body></html>`;
const GOOGLE_2026 = `<html><head><title>x - Google Search</title></head><body><div id="search">
<div class="kb0PBd" data-snf="x"><div class="yuRUbf"><div class="b8lM7"><span class="V9tjod"><a class="zReHs" href="/goto?url=CAESbAHrOzAV" data-ved="2ah" ping="/url?sa=t&amp;url=CAESbAHrOzAV"><h3 class="LC20lb">Authentication</h3><br><div><span><cite>https://playwright.dev › docs › auth</cite></span></div></a></span></div></div></div>
<div class="kb0PBd" data-sncf="1"><div class="VwiC3b">DOM snippet for auth.</div></div>
<div class="kb0PBd" data-snf="x"><div class="yuRUbf"><a class="zReHs" href="/goto?url=CAESfAHrOzAVB5"><h3 class="LC20lb">Managing Cookies With Playwright: A 2026 Guide</h3><cite>https://www.browserstack.com › guide › playwright-cookies</cite></a></div></div>
<div class="kb0PBd" data-snf="x"><div class="yuRUbf"><a class="zReHs" href="/goto?url=CAESzz"><h3 class="LC20lb">Only a cite, no JSON</h3><cite>https://example.org › a › b</cite></a></div></div>
<div><a href="https://www.google.com/search?q=more"><h3>More results</h3></a></div>
</div>
<script>AF_initDataCallback({data:[[["https://playwright.dev/docs/auth","Authentication","The browser state file may contain sensitive cookies.",1,"en","US",null,"/s?tbm"],["https://www.browserstack.com/guide/playwright-cookies","Managing Cookies With Playwright: A 2026 Guide","Learn how to manage cookies \\u0026 sessions.",1,"en","US",null]]]});</script>
</body></html>`;
const GOOGLE_SORRY = `<html><body>Our systems have detected unusual traffic from your computer network. This page checks to see if it's really you sending the requests, and not a robot.</body></html>`;

// Platform pinned to "linux" (no display) so defaults are deterministic across dev machines and CI;
// a display is simulated with DISPLAY=":0", a Mac desktop with platform "darwin".
const CACHE_DIR = mkdtempSync(join(tmpdir(), "fearch-engines-"));
function settings(env: Record<string, string> = {}, platform = "linux"): Settings {
  return settingsFromEnv(
    { FEARCH_NO_CACHE: "1", FEARCH_AUDIT_LOG: "off", FEARCH_LOG_LEVEL: "error", FEARCH_CACHE_DIR: CACHE_DIR, ...env },
    platform,
  );
}
function fakeBrowser(render: (url: string) => Promise<{ html: string; status: number }>, headed = false) {
  return {
    enabled: () => true,
    headed,
    render: async (u: string) => ({
      ...(await render(u)),
      finalUrl: u,
      salvaged: false,
      usedSession: false,
      handedOff: false,
    }),
  } as unknown as BrowserRenderer;
}
function provider(
  name: string,
  render: (url: string) => Promise<{ html: string; status: number }>,
  env: Record<string, string> = {},
  robotsBody = "User-agent: *\nDisallow: /search\nDisallow: /html/\nAllow: /lite/\n",
) {
  const robots = new RobotsChecker(
    new Cache(null),
    async () => ({ status: 200, body: robotsBody }),
    settings(env).robotsPolicy,
  );
  return new EngineProvider(
    ENGINE_SPECS[name],
    settings(env),
    fakeBrowser(render),
    robots,
    new Politeness(1, { count: 100, windowMs: 60_000 }),
    1,
  );
}

describe("engine parsers", () => {
  it("DDG lite: unwraps redirects, drops DDG's own links", () => {
    const r = parseLite(LITE, "duckduckgo");
    expect(r.map((x) => x.url)).toEqual([
      "https://github.com/mixmark-io/turndown-plugin-gfm",
      "https://www.npmjs.com/package/turndown-plugin-gfm",
    ]);
    expect(r[0].snippet).toContain("GitHub Flavored");
    expect(ddgChallenge("", 202)).toBe(true);
    expect(ddgChallenge(BOTCHECK, 200)).toBe(true);
  });
  it("Google: a:has(h3) results, /url?q= unwrapped, Google's own links skipped, challenge recognised", () => {
    const r = parseGoogle(GOOGLE, "google");
    expect(r.map((x) => x.url)).toEqual([
      "https://www.npmjs.com/package/@joplin/turndown-plugin-gfm",
      "https://github.com/trutohq/turndown-plugin-gfm",
    ]);
    expect(r[1].snippet).toBe("Enhanced Turndown plugin.");
    // 2026 layout: /goto?url= tokens in hrefs, real URLs in the embedded JSON, <cite> as fallback
    const g = parseGoogle(GOOGLE_2026, "google");
    expect(g.map((x) => x.url)).toEqual([
      "https://playwright.dev/docs/auth",
      "https://www.browserstack.com/guide/playwright-cookies",
      "https://example.org/a/b",
    ]);
    expect(g[0].snippet).toBe("The browser state file may contain sensitive cookies.");
    expect(g[1].snippet).toBe("Learn how to manage cookies & sessions.");
    expect(ENGINE_SPECS.google.isChallenge(GOOGLE_SORRY, 200, "https://www.google.com/sorry/index?continue=x")).toBe(
      true,
    );
    expect(ENGINE_SPECS.google.isChallenge(GOOGLE_SORRY, 200)).toBe(true);
    expect(ENGINE_SPECS.google.isChallenge(GOOGLE, 200, "https://www.google.com/search?q=x&sei=abc")).toBe(false);
    // a results page whose scripts mention "sorry"/"recaptcha" is still a results page
    expect(
      ENGINE_SPECS.google.isChallenge(
        GOOGLE + "<script>var u='/sorry/index';var r='recaptcha'</script>",
        200,
        "https://www.google.com/search?q=x",
      ),
    ).toBe(false);
  });
});

describe("engine eligibility — the dials play together", () => {
  it("DuckDuckGo is eligible by default; Google needs a person present and a listing", () => {
    const mk = (env: Record<string, string>) =>
      engineProviders(
        settings(env),
        fakeBrowser(async () => ({ html: "", status: 200 })),
        new RobotsChecker(new Cache(null), async () => ({ status: 404, body: "" })),
        new Politeness(1, { count: 1, windowMs: 1 }),
      );
    const names = (ps: EngineProvider[]) => ps.filter((p) => p.available()).map((p) => p.name);
    // No display (CI, servers): engine pages need a real browser window and none can be shown, so no
    // engine at all — the tool never opens a result page headless.
    expect(names(mk({}))).toEqual([]);
    expect(names(mk({ FEARCH_ENGINES: "google,duckduckgo" }))).toEqual([]);
    expect(
      mk({})
        .find((p) => p.name === "duckduckgo")!
        .ineligibleReason(),
    ).toMatch(/no browser window can be shown/);
    // A display or a visible browser does not put Google in by itself: DuckDuckGo is the default everywhere.
    expect(names(mk({ DISPLAY: ":0" }))).toEqual(["duckduckgo"]);
    // Listed, with a person on call for any check, Google is their own browsing.
    const G = { FEARCH_ENGINES: "google,duckduckgo" };
    expect(names(mk({ ...G, DISPLAY: ":0" }))).toEqual(["google", "duckduckgo"]);
    expect(names(mk({ ...G, FEARCH_BROWSER: "extension" }))).toEqual(["google", "duckduckgo"]);
    // …but not with handoff explicitly off (nobody would ever see a check).
    expect(names(mk({ ...G, DISPLAY: ":0", FEARCH_HANDOFF: "0" }))).toEqual(["duckduckgo"]);
    // …and never in explicit headless, display or not: no window, no engine page.
    expect(names(mk({ ...G, DISPLAY: ":0", FEARCH_BROWSER: "headless" }))).toEqual([]);
    expect(names(mk({ FEARCH_ENGINES: "google,nonsense", DISPLAY: ":0" }))).toEqual(["google"]);
    const listedButOff = mk({ FEARCH_ENGINES: "google", DISPLAY: ":0", FEARCH_HANDOFF: "0" }).find(
      (p) => p.name === "google",
    )!;
    expect(listedButOff.ineligibleReason()).toMatch(/person is on call/);
  });

  it("the registry orders eligible engines in FEARCH_ENGINES order and reports the rest in describe()", () => {
    const s = settings({ FEARCH_ENGINES: "google,duckduckgo", DISPLAY: ":0" });
    const engines = engineProviders(
      s,
      fakeBrowser(async () => ({ html: "", status: 200 })),
      new RobotsChecker(new Cache(null), async () => ({ status: 404, body: "" })),
      new Politeness(1, { count: 1, windowMs: 1 }),
    );
    const reg = new SearchRegistry(s, new Cache(null), new Audit(s), engines);
    expect(reg.web.map((p) => p.name)).toEqual(["google", "duckduckgo"]);
    const s2 = settings({ FEARCH_ENGINES: "google,duckduckgo", DISPLAY: ":0", FEARCH_HANDOFF: "0" });
    const reg2 = new SearchRegistry(
      s2,
      new Cache(null),
      new Audit(s2),
      engineProviders(
        s2,
        fakeBrowser(async () => ({ html: "", status: 200 })),
        new RobotsChecker(new Cache(null), async () => ({ status: 404, body: "" })),
        new Politeness(1, { count: 1, windowMs: 1 }),
      ),
    );
    expect(reg2.web.map((p) => p.name)).toEqual(["duckduckgo"]);
    expect(reg2.describe()).toMatch(/listed but not used: google \(www\.google\.com disallows/);
  });

  it("tells the model inline when a listed engine was skipped by the robots dial", async () => {
    const s = settings({ FEARCH_ENGINES: "google,duckduckgo", DISPLAY: ":0", FEARCH_HANDOFF: "0" });
    const robots = new RobotsChecker(new Cache(null), async () => ({
      status: 200,
      body: "User-agent: *\nAllow: /lite/\nDisallow: /search\n",
    }));
    const engines = engineProviders(
      s,
      fakeBrowser(async () => ({ html: LITE, status: 200 })),
      robots,
      new Politeness(1, { count: 100, windowMs: 60_000 }),
    );
    const reg = new SearchRegistry(s, new Cache(null), new Audit(s), engines);
    const out = await reg.search({ query: "turndown", maxResults: 3 });
    expect(out.providers.map((p) => p.name)).toEqual(["duckduckgo"]);
    expect(out.notes.join("\n")).toMatch(
      /google: listed in --engines but not used — www\.google\.com disallows .*person is on call/,
    );
  });

  it("verifies the live robots.txt for robots-permitted engines; person-present engines are the person's browsing", async () => {
    const seen: string[] = [];
    const p = provider("duckduckgo", async (u) => {
      seen.push(u);
      return { html: LITE, status: 200 };
    });
    const { results: out } = await p.search({ query: "turndown gfm", maxResults: 5 });
    expect(out.length).toBe(2);
    expect(seen[0]).toContain("lite.duckduckgo.com/lite/?q=turndown%20gfm");
    // DuckDuckGo's permission is verified live: were it withdrawn, the provider stops.
    await expect(
      provider("duckduckgo", async () => ({ html: LITE, status: 200 }), {}, "User-agent: *\nDisallow: /\n").search({
        query: "x",
        maxResults: 5,
      }),
    ).rejects.toThrow(/robots\.txt disallows/);
    // Google with a person present is the person's own browsing: the query they approved is opened
    // without consulting robots.txt.
    const { results: g } = await provider("google", async () => ({ html: GOOGLE, status: 200 }), {
      DISPLAY: ":0",
    }).search({ query: "x", maxResults: 5 }, { submittedByPerson: true });
    expect(g[0].url).toContain("npmjs.com");
  });

  it("treats a bot-check page as the engine's 'no' (no retry) and says how a person could pass it", async () => {
    let calls = 0;
    const p = provider("duckduckgo", async () => {
      calls++;
      return { html: BOTCHECK, status: 202 };
    });
    await expect(p.search({ query: "x", maxResults: 5 })).rejects.toThrow(
      /bot-check page.*no browser window can be shown/,
    );
    expect(calls).toBe(1);
    await expect(p.search({ query: "x", maxResults: 5 })).rejects.toThrow(RateLimited);
  });

  it("tells an empty results page from a parser failure, and keeps the redacted page either way", async () => {
    const approved = { submittedByPerson: true };
    const empty = provider("google", async () => ({
      html: `<html><body><div id="search"><p>Your search - xqzv - did not match any documents.</p></div></body></html>`,
      status: 200,
    }));
    await expect(empty.search({ query: "xqzv", maxResults: 5 }, approved)).rejects.toThrow(
      /no results for this query \(page saved to/,
    );
    // A page with prose but nothing that reads as a result is the page rung, and it was kept on disk.
    const odd = provider("google", async () => ({
      html: `<html><body><div id="search">${"<p>x</p>".repeat(40)}</div></body></html>`,
      status: 200,
    }));
    const page = await odd.search({ query: "x", maxResults: 5 }, approved);
    expect(page.parsed).toBe("page");
    expect(page.note).toMatch(/page saved to/);
    // A page that says "did not match" but still carries result headings is not an empty answer
    // (an interstitial or consent page must never pass as "no results"): it is read as a page.
    const mixed = provider("google", async () => ({
      html: `<html><body><div id="search"><p>did not match any documents</p><h3>Still a result</h3></div></body></html>`,
      status: 200,
    }));
    expect((await mixed.search({ query: "x", maxResults: 5 }, approved)).parsed).toBe("page");
    const dumps = readdirSync(join(CACHE_DIR, "debug")).filter((f) => f.startsWith("google-"));
    expect(dumps.length).toBeGreaterThan(0);
    expect(dumps.length).toBeLessThanOrEqual(2); // only the last two are kept
  });

  it("sends site and up to three allowed domains to the engine as its own operator", () => {
    expect(scopedQuery({ query: "q", maxResults: 5 })).toBe("q");
    expect(scopedQuery({ query: "q", maxResults: 5, site: "docs.python.org" })).toBe("q site:docs.python.org");
    expect(scopedQuery({ query: "q", maxResults: 5, allowedDomains: ["a.org"] })).toBe("q site:a.org");
    expect(scopedQuery({ query: "q", maxResults: 5, allowedDomains: ["a.org", "b.org"] })).toBe(
      "q (site:a.org OR site:b.org)",
    );
    expect(scopedQuery({ query: "q", maxResults: 5, allowedDomains: ["a", "b", "c", "d"] })).toBe("q");
  });

  it("redacts the signed-in account chrome and e-mail addresses from debug dumps", () => {
    const page = `<html><body><header><a href="https://accounts.google.com">Google Account: Pat (pat@example.com)</a></header><div id="search">results</div><span>pat.smith+tag@example.co.uk</span></body></html>`;
    const out = redactAccount(page);
    expect(out).not.toContain("pat@example.com");
    expect(out).not.toContain("pat.smith");
    expect(out).not.toContain("Google Account");
    expect(out).toContain("results");
  });
});

describe("you press search (FEARCH_HUMAN_SEARCH)", () => {
  const RESULTS_URL = "https://www.google.com/search?q=x&sei=abc";
  function humanProvider(
    render: (
      url: string,
      opts: import("../src/fetch/browser.js").RenderOptions,
    ) => Promise<{ html: string; url?: string; handedOff?: boolean; handoffWhere?: string }>,
  ) {
    const s = settings({ FEARCH_HUMAN_SEARCH: "1", FEARCH_ENGINES: "google,duckduckgo", DISPLAY: ":0" });
    const browser = {
      enabled: () => true,
      headed: true,
      browserUserAgent: "ua",
      browserChannel: "chrome",
      render: async (u: string, o: import("../src/fetch/browser.js").RenderOptions = {}) => {
        const r = await render(u, o);
        return {
          html: r.html,
          finalUrl: r.url ?? u,
          status: 200,
          salvaged: false,
          usedSession: false,
          handedOff: r.handedOff ?? false,
          handoffWhere: r.handoffWhere,
        };
      },
      close: async () => {},
    } as unknown as BrowserRenderer;
    return new EngineProvider(
      ENGINE_SPECS.google,
      s,
      browser,
      new RobotsChecker(new Cache(null), async () => ({ status: 404, body: "" })),
      new Politeness(1, { count: 100, windowMs: 60_000 }),
      1,
    );
  }

  it("opens the engine's home page with the query prefilled, hands it to the person, and parses the page they land on", async () => {
    const seen: { url: string; opts: import("../src/fetch/browser.js").RenderOptions }[] = [];
    const p = humanProvider(async (url, opts) => {
      seen.push({ url, opts });
      // the person presses Enter: the tab is now a results page
      const home = `<html><body><textarea name="q">turndown gfm</textarea></body></html>`;
      expect(opts.handToPerson!.ready(home, "https://www.google.com/?q=turndown+gfm")).toBe(false);
      expect(opts.handToPerson!.ready(GOOGLE, RESULTS_URL)).toBe(true);
      expect(opts.handToPerson!.ready(GOOGLE_SORRY, "https://www.google.com/sorry/index")).toBe(false);
      return { html: GOOGLE, url: RESULTS_URL, handedOff: true, handoffWhere: "a browser window on your screen" };
    });
    const { results } = await p.search({ query: "turndown gfm", maxResults: 5 });
    expect(seen[0].url).toBe("https://www.google.com/?q=turndown%20gfm");
    expect(seen[0].opts.handToPerson?.message).toMatch(/press Enter/);
    expect(seen[0].opts.settleSelector).toBeUndefined();
    expect(results.map((r) => r.url)).toContain("https://www.npmjs.com/package/@joplin/turndown-plugin-gfm");
    expect(p.disclosure).toContain("approved or submitted by you");
  });

  it("says where the query is waiting when the person did not press search in time, without cooling the engine down", async () => {
    const p = humanProvider(async () => ({
      html: "<html><body>home</body></html>",
      handedOff: false,
      handoffWhere: "a tab in your Chrome",
    }));
    // The tab is closed when the render returns, so the note must not send the person to it.
    await expect(p.search({ query: "x", maxResults: 5 })).rejects.toThrow(
      /opened in a tab in your Chrome but not submitted within \d+ s, so that tab was closed — search again/,
    );
    // An unsubmitted query is not the engine's "no": no cooldown.
    await expect(p.search({ query: "x", maxResults: 5 })).rejects.toSatisfy(
      (e: unknown) => e instanceof SearchError && !(e instanceof RateLimited),
    );
  });

  it("a query the person approved in their client runs as their submission: no browser handoff", async () => {
    const seen: { url: string; opts: import("../src/fetch/browser.js").RenderOptions }[] = [];
    const p = humanProvider(async (url, opts) => {
      seen.push({ url, opts });
      return { html: GOOGLE, url: RESULTS_URL };
    });
    const { results } = await p.search(
      { query: "turndown gfm plugin", maxResults: 5 },
      { submittedByPerson: true, incognito: true },
    );
    expect(seen[0].url).toContain("google.com/search?q=turndown%20gfm%20plugin");
    expect(seen[0].opts.handToPerson).toBeUndefined(); // the client asked instead
    expect(seen[0].opts.incognito).toBe(true); // the person's profile choice travels with the query
    expect(results.length).toBeGreaterThan(0);
    expect(p.disclosure).toContain("approved or submitted by you");
  });

  it("Google always needs the person's act, --human-search or not: without a client that can ask, the search box is handed over", async () => {
    const s = settings({ FEARCH_ENGINES: "google,duckduckgo", DISPLAY: ":0" });
    const seen: import("../src/fetch/browser.js").RenderOptions[] = [];
    const browser = {
      enabled: () => true,
      headed: true,
      browserUserAgent: "ua",
      browserChannel: "chrome",
      render: async (u: string, o: import("../src/fetch/browser.js").RenderOptions = {}) => {
        seen.push(o);
        return {
          html: GOOGLE,
          finalUrl: RESULTS_URL,
          status: 200,
          salvaged: false,
          usedSession: false,
          handedOff: true,
        };
      },
      close: async () => {},
    } as unknown as BrowserRenderer;
    const p = new EngineProvider(
      ENGINE_SPECS.google,
      s,
      browser,
      new RobotsChecker(new Cache(null), async () => ({ status: 404, body: "" })),
      new Politeness(1, { count: 100, windowMs: 60_000 }),
      1,
    );
    expect(p.needsPerson).toBe(true);
    await p.search({ query: "x", maxResults: 5 });
    expect(seen[0].handToPerson?.message).toMatch(/press Enter/);
  });

  it("does not apply to DuckDuckGo lite, whose result pages robots.txt permits", async () => {
    const seen: string[] = [];
    const p = provider(
      "duckduckgo",
      async (u) => {
        seen.push(u);
        return { html: LITE, status: 200 };
      },
      { FEARCH_HUMAN_SEARCH: "1" },
    );
    await p.search({ query: "x", maxResults: 5 });
    expect(seen[0]).toContain("lite.duckduckgo.com/lite/?q=x");
  });
});

describe("human handoff loop", () => {
  it("waits until the page stops being a challenge, or gives up at the deadline", async () => {
    let n = 0;
    const pages = ["<b>captcha</b>", "<b>captcha</b>", "<main>results</main>"];
    const r = await waitForHuman(
      async () => ({ html: pages[Math.min(n++, 2)], status: 200, url: "https://x.test/" }),
      (h) => /captcha/.test(h),
      10_000,
      1,
      async () => {},
    );
    expect(r.passed).toBe(true);
    expect(r.html).toBe("<main>results</main>");
    expect(n).toBe(3);
    const gaveUp = await waitForHuman(
      async () => ({ html: "<b>captcha</b>", status: 200, url: "https://x.test/" }),
      (h) => /captcha/.test(h),
      0,
      1,
      async () => {},
    );
    expect(gaveUp.passed).toBe(false);
  });
});

describe("server flags", () => {
  it("maps flags onto settings, wins over env, derives engines, and passes the rest through", () => {
    const base = { FEARCH_NO_CACHE: "1", FEARCH_AUDIT_LOG: "off", FEARCH_LOG_LEVEL: "error" };
    const a = settingsFromArgs(["--browser", "extension", "search", "some query", "--n", "3"], base, "linux");
    // A visible browser means handoff on; Google is still a choice, not a consequence.
    expect([a.settings.robotsPolicy, a.settings.browser, a.settings.handoff, a.settings.engines]).toEqual([
      "default",
      "extension",
      true,
      ["duckduckgo"],
    ]);
    expect(a.rest).toEqual(["search", "some query", "--n", "3"]);
    const b = settingsFromArgs(
      ["--robots=strict", "--browser=off", "--engines", "google,duckduckgo", "doctor"],
      { ...base, FEARCH_ROBOTS_POLICY: "default" },
      "linux",
    );
    expect([b.settings.robotsPolicy, b.settings.browser, b.settings.engines, b.rest]).toEqual([
      "strict",
      "off",
      ["google", "duckduckgo"],
      ["doctor"],
    ]);
    // an unknown robots policy is refused
    expect(() => settingsFromArgs(["--robots", "off"], base, "linux")).toThrow(/must be one of/);
    expect(settingsFromArgs(["--browser", "extension"], base, "linux").settings.engines).toEqual(["duckduckgo"]);
    // a desktop platform can surface a window, and the default is still DuckDuckGo alone
    expect(settingsFromArgs([], base, "darwin").settings.engines).toEqual(["duckduckgo"]);
    expect(settingsFromArgs(["--engines", "google,duckduckgo"], base, "darwin").settings.engines).toEqual([
      "google",
      "duckduckgo",
    ]);
    // handoff opted out (env escape hatch): nobody would see a check, so back to DuckDuckGo only
    expect(
      settingsFromArgs(["--browser", "extension"], { ...base, FEARCH_HANDOFF: "0" }, "linux").settings.engines,
    ).toEqual(["duckduckgo"]);
    // The old headed mode says where it went, rather than just "must be one of".
    expect(() => settingsFromArgs(["--browser", "headed"], base, "linux")).toThrow(/headed was removed/);
    expect(settingsFromArgs([], base, "linux").settings.engines).toEqual(["duckduckgo"]);
    expect(() => settingsFromArgs(["--robots"], base, "linux")).toThrow(/needs a value/);
    expect(() => settingsFromArgs(["--robots", "sometimes"], base, "linux")).toThrow(/must be one of/);
  });

  it("every setting is a flag: booleans, negation, tuning knobs, and the env twin losing to the flag", () => {
    const base = { FEARCH_NO_CACHE: "1", FEARCH_AUDIT_LOG: "off", FEARCH_LOG_LEVEL: "error" };
    const s = settingsFromArgs(
      [
        "--incognito",
        "--human-search=false",
        "--no-handoff",
        "--search",
        "off",
        "--handoff-timeout-ms=1000",
        "search",
        "q",
      ],
      { ...base, FEARCH_INCOGNITO: "0", FEARCH_SEARCH_MODE: "all" },
      "darwin",
    );
    expect([
      s.settings.incognito,
      s.settings.humanSearch,
      s.settings.handoff,
      s.settings.searchMode,
      s.settings.handoffTimeoutMs,
    ]).toEqual([true, false, false, "off", 1000]);
    expect(s.rest).toEqual(["search", "q"]);
    expect(s.overrides).toEqual({
      FEARCH_INCOGNITO: "1",
      FEARCH_HUMAN_SEARCH: "false",
      FEARCH_HANDOFF: "0",
      FEARCH_SEARCH_MODE: "off",
      FEARCH_HANDOFF_TIMEOUT_MS: "1000",
    });
    expect(() => settingsFromArgs(["--no-engines"], base, "linux")).toThrow(/not a boolean/);
    // `--no-cache` is its own flag, not the negation of a `cache` flag
    expect(settingsFromArgs(["--no-cache"], {}, "linux").settings.noCache).toBe(true);
    // subcommand flags that share nothing with server flags pass through untouched
    expect(settingsFromArgs(["fetch", "https://x.test/", "--mode", "raw", "--links"], base, "linux").rest).toEqual([
      "fetch",
      "https://x.test/",
      "--mode",
      "raw",
      "--links",
    ]);
  });
});

describe("config dials", () => {
  it("parses browser/identity/handoff/session/engines/robots and derives surfacing from mode + display", () => {
    const d = settings();
    // Default is auto with handoff armed; with no display it cannot surface, so engines stay DuckDuckGo.
    expect([d.browser, d.handoff, d.canSurface, d.engines, d.robotsPolicy]).toEqual([
      "auto",
      true,
      false,
      ["duckduckgo"],
      "default",
    ]);
    const mac = settings({}, "darwin");
    expect([mac.canSurface, mac.engines, mac.humanSearch, mac.incognito]).toEqual([true, ["duckduckgo"], false, false]);
    // incognito is a switch for the person's-Chrome tier, whether pinned (extension) or preferred (auto)
    expect(settings({ FEARCH_INCOGNITO: "1" }).incognito).toBe(true);
    expect(settings({ FEARCH_BROWSER: "extension", FEARCH_INCOGNITO: "1" }).incognito).toBe(true);
    expect(settings({ FEARCH_BROWSER: "headless", FEARCH_INCOGNITO: "1" }).incognito).toBe(false);
    expect(settings({ FEARCH_HUMAN_SEARCH: "1" }).humanSearch).toBe(true);
    const h = settings({
      FEARCH_BROWSER: "extension",
      FEARCH_HANDOFF: "1",
      FEARCH_ENGINES: "Google, duckduckgo",
      FEARCH_ROBOTS_POLICY: "strict",
    });
    expect([h.browser, h.handoff, h.engines, h.robotsPolicy]).toEqual([
      "extension",
      true,
      ["google", "duckduckgo"],
      "strict",
    ]);
    expect(h.browserStatePath).toMatch(/browser-state\.json$/);
    const hl = settings({ FEARCH_BROWSER: "headless", FEARCH_HANDOFF: "1" });
    expect([hl.handoff, hl.canSurface]).toEqual([false, false]);
    // Handoff defaults on wherever a person could be reached; FEARCH_HANDOFF=0 opts out.
    expect(settings({ FEARCH_BROWSER: "extension" }).handoff).toBe(true);
    expect(settings({ FEARCH_BROWSER: "extension", FEARCH_HANDOFF: "0" }).handoff).toBe(false);
    // A display via env works for auto on linux too; unknown modes fall back to auto.
    expect(settings({ DISPLAY: ":0" }).canSurface).toBe(true);
    expect(settings({ FEARCH_BROWSER: "nonsense" }).browser).toBe("auto");
    expect(settings({ FEARCH_ENGINES: "" }).engines).toEqual([]);
  });
});

describe("google layouts", () => {
  const fixture = (name: string) =>
    readFileSync(new URL(`../../../tests/fixtures/google/${name}.html`, import.meta.url), "utf8");
  it("reads results from the classic page and from Web Guide, which has no h3 at all", () => {
    const classic = parseGoogle(fixture("classic-results-vitest"), "google");
    expect(classic.length).toBeGreaterThanOrEqual(8);
    expect(classic[0].url).toBe("https://github.com/vitest-dev/vitest/issues/6011");
    expect(classic[0].snippet).toMatch(/^Describe the bug/); // joined to the embedded row by URL
    const guide = parseGoogle(fixture("web-guide-vitest"), "google");
    expect(guide.length).toBeGreaterThanOrEqual(10);
    expect(guide.map((r) => r.url)).toContain("https://github.com/nuxt/test-utils/issues/897");
    expect(guide.find((r) => r.url.includes("qaskills.sh"))!.snippet.length).toBeGreaterThan(20);
    expect(guide.every((r) => !/google\./.test(new URL(r.url).hostname))).toBe(true);
  });

  it("carries the generated answer through the registry into the rendered output, labelled and cached", async () => {
    const page = fixture("ai-overview-vitest");
    const s = settings({ FEARCH_ENGINES: "google", DISPLAY: ":0" });
    const robots = new RobotsChecker(new Cache(null), async () => ({ status: 404, body: "" }));
    const engines = engineProviders(
      s,
      fakeBrowser(async () => ({
        html: page + `<div class="g"><a href="https://example.com/rest"><h3>REST</h3></a></div>`,
        status: 200,
      })),
      robots,
      new Politeness(1, { count: 100, windowMs: 60_000 }),
    );
    const cache = new Cache(null);
    const reg = new SearchRegistry(s, cache, new Audit(s), engines);
    reg.onConfirmQuery(async (a) => ({ query: a.query, engine: a.engine, incognito: true, askAgain: true }));
    const out = await reg.search({ query: "vitest useFakeTimers setInterval not advancing", maxResults: 3 });
    expect(out.summary?.provider).toBe("google");
    expect(out.summary?.label).toBe("AI Overview");
    const rendered = renderResults("vitest useFakeTimers setInterval not advancing", out);
    expect(rendered).toContain(
      "> **Google's AI Overview** (the engine's model wrote this — unverified; check the sources):",
    );
    expect(rendered).toContain("> When **`vi.useFakeTimers()`** is enabled");
    expect(rendered).toContain("> ### 1. You forgot to manually advance the clock");
    expect(rendered).toMatch(/> Sources: \[1\] https:\/\//);
    const again = await reg.search({ query: "vitest useFakeTimers setInterval not advancing", maxResults: 3 });
    expect(again.fromCache).toBe(true);
    expect(again.summary?.text).toMatch(/^When/);
  });
});

describe("the ladder", () => {
  const UNKNOWN = `<html><body><div id="search"><div class="zz"><a href="https://a.test/one"><span>A result title long enough</span></a><span>a.test › one</span><p>A snippet long enough to count as a snippet for the reader.</p></div><div class="zz"><a href="https://b.test/two"><span>Another result title here</span></a><span>b.test › two</span><p>Another snippet long enough to count as a snippet for the reader.</p></div><div class="zz"><a href="https://c.test/three"><span>A third result title here</span></a><span>c.test › three</span><p>A third snippet long enough to count as a snippet for the reader.</p></div></div></body></html>`;
  const NOTHING = `<html><body><div id="search"><h2>Everything moved</h2><p>Some prose about the query with no links in it at all, only words, so that no rung below the page can read a result out of it.</p></div></body></html>`;
  const approved = { submittedByPerson: true };
  function google(pages: Record<string, string>, seen: string[] = []) {
    const s = settings({ FEARCH_ENGINES: "google", DISPLAY: ":0" });
    const robots = new RobotsChecker(new Cache(null), async () => ({ status: 404, body: "" }));
    const browser = fakeBrowser(async (url) => {
      seen.push(url);
      return { html: pages.default ?? "<html></html>", status: 200 };
    });
    return {
      provider: new EngineProvider(
        ENGINE_SPECS.google,
        s,
        browser,
        robots,
        new Politeness(1, { count: 100, windowMs: 60_000 }),
      ),
      seen,
    };
  }

  it("reads an unrecognised layout by shape and says so", async () => {
    const { provider } = google({ default: UNKNOWN });
    const r = await provider.search({ query: "q", maxResults: 5 }, approved);
    expect(r.parsed).toBe("shape");
    expect(r.results.map((x) => x.url)).toEqual(["https://a.test/one", "https://b.test/two", "https://c.test/three"]);
    expect(r.note).toMatch(/read by page shape/);
  });

  it("hands the page over as markdown when nothing on it reads as a result", async () => {
    const seen: string[] = [];
    const { provider } = google({ default: NOTHING }, seen);
    const r = await provider.search({ query: "q", maxResults: 5 }, approved);
    expect(seen.length).toBe(1); // one page view per query, never a second
    expect(r.parsed).toBe("page");
    expect(r.results).toEqual([]);
    expect(r.page).toContain("Everything moved");
    expect(r.note).toMatch(/results column follows as markdown/);
  });

  it("carries the rung through the registry: a shape read is reported, a page read is returned, neither is cached", async () => {
    const s = settings({ FEARCH_ENGINES: "google", DISPLAY: ":0" });
    const robots = new RobotsChecker(new Cache(null), async () => ({ status: 404, body: "" }));
    let html = UNKNOWN;
    const engines = engineProviders(
      s,
      fakeBrowser(async () => ({ html, status: 200 })),
      robots,
      new Politeness(1, { count: 100, windowMs: 60_000 }),
    );
    const cache = new Cache(null);
    const reg = new SearchRegistry(s, cache, new Audit(s), engines);
    reg.onConfirmQuery(async (a) => ({ query: a.query, engine: a.engine, incognito: true, askAgain: true }));
    const shaped = await reg.search({ query: "shape q", maxResults: 5 });
    expect(shaped.parsed).toBe("shape");
    expect(shaped.results.length).toBe(3);
    expect(renderResults("shape q", shaped)).toContain("read by page shape, approximate");
    html = NOTHING;
    const again = await reg.search({ query: "shape q", maxResults: 5 }); // not cached: rung 1 gets another chance
    expect(again.fromCache).toBe(false);
    expect(again.parsed).toBe("page");
    expect(again.page?.markdown).toContain("Everything moved");
    const text = renderResults("shape q", again);
    expect(text).toContain("the page follows");
    expect(text).toContain("No result could be parsed from google's page");
    expect(text).toContain("Everything moved");
  });
});

describe("google AI Mode as an engine", () => {
  const fixture = (name: string) =>
    readFileSync(new URL(`../../../tests/fixtures/google/${name}.html`, import.meta.url), "utf8");
  const approved = { submittedByPerson: true };
  const make = (html: string, env: Record<string, string> = {}) => {
    const s = settings({ FEARCH_ENGINES: "google-ai,duckduckgo", DISPLAY: ":0", ...env });
    const robots = new RobotsChecker(new Cache(null), async () => ({ status: 404, body: "" }));
    const politeness = new Politeness(1, { count: 100, windowMs: 60_000 });
    const browser = fakeBrowser(async () => ({ html, status: 200 }));
    return {
      s,
      provider: new EngineProvider(ENGINE_SPECS["google-ai"], s, browser, robots, politeness),
      browser,
      robots,
      politeness,
    };
  };

  it("is listed, needs a person, and asks udm=50 for the query", () => {
    expect(ENGINE_SPECS["google-ai"].url("capital of australia", undefined, "en-US")).toContain("udm=50");
    const { provider } = make("<html></html>");
    expect(provider.needsPerson).toBe(true);
    expect(provider.available()).toBe(true);
  });

  it("returns the reply as the answer and its citations as the results", async () => {
    const { provider } = make(fixture("ai-mode-capital"));
    const r = await provider.search({ query: "what is the capital of australia and why", maxResults: 5 }, approved);
    expect(r.summary?.label).toBe("AI Mode");
    expect(r.summary?.text).toMatch(/^The capital of Australia/);
    expect(r.parsed).toBe("first-class");
    expect(r.results.length).toBeGreaterThanOrEqual(5);
    expect(r.results.map((x) => x.url)).toContain("https://en.wikipedia.org/wiki/Canberra");
  });

  it("never runs unapproved: a client that cannot show the form gets an honest refusal, not a search", async () => {
    const { provider } = make(fixture("ai-mode-capital"));
    await expect(provider.search({ query: "q", maxResults: 5 })).rejects.toThrow(
      /needs your approval in your MCP client/,
    );
  });

  it("an answer whose citations have not loaded is still an answer; the chain goes on for result links", async () => {
    const { s, robots, politeness } = make("");
    const replyOnly = fixture("ai-mode-capital").replace(/<a [^>]*href="https?:[^"]*"[^>]*>/g, "<span>");
    const engines = engineProviders(
      s,
      fakeBrowser(async (url) => ({ html: /udm=50/.test(url) ? replyOnly : LITE, status: 200 })),
      robots,
      politeness,
    );
    const reg = new SearchRegistry(s, new Cache(null), new Audit(s), engines);
    reg.onConfirmQuery(async (a) => ({ query: a.query, engine: a.engine, incognito: true, askAgain: true }));
    const out = await reg.search({ query: "what is the capital of australia and why", maxResults: 3 });
    expect(out.summary?.label).toBe("AI Mode");
    expect(out.providers.map((p) => p.name)).toEqual(["google-ai", "duckduckgo"]);
    expect(out.results.length).toBeGreaterThan(0); // DuckDuckGo lite's links
    const text = renderResults("what is the capital of australia and why", out);
    expect(text).toContain("> **Google's AI Mode**");
    expect(text).toContain("via google-ai + duckduckgo");
  });
});

describe("AI Mode's ladder and the raw rung", () => {
  const fixture = (name: string) =>
    readFileSync(new URL(`../../../tests/fixtures/google/${name}.html`, import.meta.url), "utf8");
  const approved = { submittedByPerson: true };
  const make = (html: string) => {
    const s = settings({ FEARCH_ENGINES: "google-ai", DISPLAY: ":0" });
    const robots = new RobotsChecker(new Cache(null), async () => ({ status: 404, body: "" }));
    return new EngineProvider(
      ENGINE_SPECS["google-ai"],
      s,
      fakeBrowser(async () => ({ html, status: 200 })),
      robots,
      new Politeness(1, { count: 100, windowMs: 60_000 }),
    );
  };

  it("hands the page over as markdown when the reply cannot be read, instead of guessing at links", async () => {
    const unreadable = `<html><body><div id="search"><h3>Something else entirely</h3><p>Google changed the reply's shape; there is prose here and a <a href="https://x.test/a">link with a long enough title</a> but no reply block.</p></div></body></html>`;
    const r = await make(unreadable).search({ query: "q", maxResults: 5 }, approved);
    expect(r.parsed).toBe("page");
    expect(r.summary).toBeUndefined();
    expect(r.results).toEqual([]);
    expect(r.page).toContain("Google changed the reply");
    expect(r.note).toMatch(/reply could not be read/);
  });

  it("a reply whose sources have not loaded is first class with no links, not a page; a streaming reply is not a bot check", async () => {
    const replyOnly = fixture("ai-mode-capital").replace(/<a [^>]*href="https?:[^"]*"[^>]*>/g, "<span>");
    const r = await make(replyOnly).search(
      { query: "what is the capital of australia and why", maxResults: 5 },
      approved,
    );
    expect(r.parsed).toBe("first-class");
    expect(r.summary?.label).toBe("AI Mode");
    expect(r.results).toEqual([]);
    expect(r.note).toMatch(/sources had not loaded/);
    // Every Google page carries reCAPTCHA scripts; a page with a reply, or with results, is not a check.
    const streaming = `<html><head><script src="https://www.google.com/recaptcha/api.js"></script></head><body><div>Thinking…</div><div>${"words ".repeat(700)}</div></body></html>`;
    expect(ENGINE_SPECS.google.isChallenge(streaming, 200, "https://www.google.com/search?q=x&udm=50")).toBe(false);
    expect(
      ENGINE_SPECS.google.isChallenge(
        `<html><body><p>Our systems have detected unusual traffic from your computer network.</p><p>not a robot</p></body></html>`,
        200,
        "https://www.google.com/search?q=x",
      ),
    ).toBe(true);
    expect(ENGINE_SPECS.google.isChallenge("<html></html>", 200, "https://www.google.com/sorry/index")).toBe(true);
  });

  it("returns the rendered page, redacted, only when asked, and never caches it", async () => {
    const page = fixture("ai-mode-capital").replace(
      "<body>",
      "<body><header>Google Account: Pat (pat@example.com)</header>",
    );
    const plain = await make(page).search(
      { query: "what is the capital of australia and why", maxResults: 3 },
      approved,
    );
    expect(plain.html).toBeUndefined();
    const raw = await make(page).search(
      { query: "what is the capital of australia and why", maxResults: 3, raw: true },
      approved,
    );
    expect(raw.html).toBeDefined();
    expect(raw.html).not.toContain("pat@example.com");
    expect(raw.html).toContain("<!-- header removed -->");
    expect(raw.summary?.label).toBe("AI Mode"); // the first-class read still comes with it

    const s = settings({ FEARCH_ENGINES: "google-ai", DISPLAY: ":0" });
    const robots = new RobotsChecker(new Cache(null), async () => ({ status: 404, body: "" }));
    const engines = engineProviders(
      s,
      fakeBrowser(async () => ({ html: page, status: 200 })),
      robots,
      new Politeness(1, { count: 100, windowMs: 60_000 }),
    );
    const reg = new SearchRegistry(s, new Cache(null), new Audit(s), engines);
    reg.onConfirmQuery(async (a) => ({ query: a.query, engine: a.engine, incognito: true, askAgain: true }));
    const out = await reg.search({ query: "what is the capital of australia and why", maxResults: 3, raw: true });
    expect(out.raw?.provider).toBe("google-ai");
    const text = renderResults("what is the capital of australia and why", out);
    expect(text).toContain("Raw rendered page from google-ai");
    expect(text).toContain("<!-- header removed -->");
    const again = await reg.search({ query: "what is the capital of australia and why", maxResults: 3, raw: true });
    expect(again.fromCache).toBe(false);
  });
});

describe("locale", () => {
  it("derives the machine locale from the environment; FEARCH_LOCALE wins; C/POSIX means en-US", () => {
    expect(settings().locale).toBe("en-US");
    expect(settings({ LANG: "de_DE.UTF-8" }).locale).toBe("de-DE");
    expect(settings({ LANG: "fr" }).locale).toBe("fr");
    expect(settings({ LANG: "C.UTF-8" }).locale).toBe("en-US");
    expect(settings({ LANG: "de_DE.UTF-8", FEARCH_LOCALE: "ja-JP" }).locale).toBe("ja-JP");
  });

  it("engines speak the machine's locale in their own dialects", () => {
    expect(ENGINE_SPECS.duckduckgo.url("q", undefined, "de-DE")).toContain("kl=de-de");
    expect(ENGINE_SPECS.duckduckgo.url("q", undefined, "en-GB")).toContain("kl=uk-en");
    expect(ENGINE_SPECS.duckduckgo.url("q", undefined, "fr")).toContain("kl=wt-wt");
    expect(ENGINE_SPECS.duckduckgo.url("q", "w", "en-US")).toContain("kl=us-en&df=w");
    // Google gets the URL a person's address bar would carry: the query and Google's own date filter,
    // no language or region parameters (Accept-Language and the network carry the locale).
    expect(ENGINE_SPECS.google.url("q", "m", "de-DE")).toBe("https://www.google.com/search?q=q&udm=14&tbs=qdr:m");
    expect(ENGINE_SPECS.google.url("q", undefined, "en-US")).not.toMatch(/num=|hl=|gl=/);
    expect(ENGINE_SPECS["google-ai"].url("q", undefined, "de-DE")).toBe("https://www.google.com/search?q=q&udm=50");
    expect(acceptLanguage("de-DE")).toBe("de-DE,de;q=0.9,en;q=0.5");
    expect(acceptLanguage("en-US")).toBe("en-US,en;q=0.8");
  });
});
