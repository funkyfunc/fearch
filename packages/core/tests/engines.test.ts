/** Engine result pages via the browser tier: parsers, robots-gated eligibility, the human handoff. */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { Cache } from "../src/cache.js";
import { settingsFromArgs, settingsFromEnv, type Settings } from "../src/config.js";
import { waitForHuman, type BrowserRenderer } from "../src/fetch/browser.js";
import { RobotsChecker } from "../src/fetch/robots.js";
import { Politeness } from "../src/politeness.js";
import {
  ENGINE_SPECS,
  EngineProvider,
  engineProviders,
  ddgChallenge,
  parseBing,
  parseGoogle,
  parseGoogleOverview,
  parseLite,
  unwrapBing,
} from "../src/search/engines.js";
import { SearchError } from "../src/search/provider.js";
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

const b64 = (s: string) => Buffer.from(s).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const BING = `<html><body><ol id="b_results">
<li class="b_algo"><h2><a href="https://www.bing.com/ck/a?!&&p=abc&u=a1${b64("https://www.npmjs.com/package/@joplin/turndown-plugin-gfm")}&ntb=1">@joplin/turndown-plugin-gfm - npm</a></h2><div class="b_caption"><p>A Turndown plugin which adds GitHub Flavored Markdown extensions.</p></div></li>
<li class="b_algo"><h2><a href="https://github.com/trutohq/turndown-plugin-gfm">GitHub - trutohq/turndown-plugin-gfm</a></h2><div class="b_caption"><p>Enhanced Turndown plugin.</p></div></li>
<li class="b_algo"><h2><a href="https://www.bing.com/images/search?q=x">Images</a></h2></li>
</ol></body></html>`;
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

function settings(env: Record<string, string> = {}): Settings {
  return settingsFromEnv({ FEARCH_NO_CACHE: "1", FEARCH_AUDIT_LOG: "off", FEARCH_LOG_LEVEL: "error", ...env });
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
    expect(ddgChallenge(202, "")).toBe(true);
    expect(ddgChallenge(200, BOTCHECK)).toBe(true);
  });
  it("Bing: decodes /ck/a?u=a1<base64url> links, skips Bing's own", () => {
    expect(unwrapBing(`https://www.bing.com/ck/a?u=a1${b64("https://example.com/x?y=1")}`)).toBe(
      "https://example.com/x?y=1",
    );
    const r = parseBing(BING, "bing");
    expect(r.map((x) => x.url)).toEqual([
      "https://www.npmjs.com/package/@joplin/turndown-plugin-gfm",
      "https://github.com/trutohq/turndown-plugin-gfm",
    ]);
    expect(r[0].snippet).toContain("GitHub Flavored");
    // a normal results page mentioning "challenge" in a script is not a challenge
    expect(ENGINE_SPECS.bing.isChallenge(200, BING.replace("</body>", "<script>var challenge=1</script></body>"))).toBe(
      false,
    );
    expect(ENGINE_SPECS.bing.isChallenge(200, "<html><body>Please verify you are a human</body></html>")).toBe(true);
    expect(ENGINE_SPECS.bing.isChallenge(403, "")).toBe(true);
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
    expect(ENGINE_SPECS.google.isChallenge(200, GOOGLE_SORRY, "https://www.google.com/sorry/index?continue=x")).toBe(
      true,
    );
    expect(ENGINE_SPECS.google.isChallenge(200, GOOGLE_SORRY)).toBe(true);
    expect(ENGINE_SPECS.google.isChallenge(200, GOOGLE, "https://www.google.com/search?q=x&sei=abc")).toBe(false);
    // a results page whose scripts mention "sorry"/"recaptcha" is still a results page
    expect(
      ENGINE_SPECS.google.isChallenge(
        200,
        GOOGLE + "<script>var u='/sorry/index';var r='recaptcha'</script>",
        "https://www.google.com/search?q=x",
      ),
    ).toBe(false);
  });
});

describe("engine eligibility — the dials play together", () => {
  it("DuckDuckGo is eligible by default; Bing/Google only when robots.txt is off and they are listed", () => {
    const mk = (env: Record<string, string>) =>
      engineProviders(
        settings(env),
        fakeBrowser(async () => ({ html: "", status: 200 })),
        new RobotsChecker(new Cache(null), async () => ({ status: 404, body: "" })),
        new Politeness(1, { count: 1, windowMs: 1 }),
      );
    const names = (ps: EngineProvider[]) => ps.filter((p) => p.available()).map((p) => p.name);
    expect(names(mk({}))).toEqual(["duckduckgo"]);
    expect(names(mk({ FEARCH_ENGINES: "google,duckduckgo" }))).toEqual(["duckduckgo"]);
    expect(names(mk({ FEARCH_ENGINES: "google,duckduckgo", FEARCH_ROBOTS_POLICY: "off" }))).toEqual([
      "google",
      "duckduckgo",
    ]);
    expect(names(mk({ FEARCH_ENGINES: "bing", FEARCH_ROBOTS_POLICY: "strict" }))).toEqual([]);
    expect(names(mk({ FEARCH_ENGINES: "bing,nonsense", FEARCH_ROBOTS_POLICY: "off" }))).toEqual(["bing"]);
    const listedButOff = mk({ FEARCH_ENGINES: "google" }).find((p) => p.name === "google")!;
    expect(listedButOff.ineligibleReason()).toMatch(/--robots off/);
  });

  it("the registry orders eligible engines in FEARCH_ENGINES order and reports the rest in describe()", () => {
    const s = settings({ FEARCH_ENGINES: "bing,duckduckgo,google", FEARCH_ROBOTS_POLICY: "off" });
    const engines = engineProviders(
      s,
      fakeBrowser(async () => ({ html: "", status: 200 })),
      new RobotsChecker(new Cache(null), async () => ({ status: 404, body: "" }), "off"),
      new Politeness(1, { count: 1, windowMs: 1 }),
    );
    const reg = new SearchRegistry(
      s,
      new Cache(null),
      new Audit(s),
      {
        get: async () => {
          throw new Error("no");
        },
      } as never,
      engines,
    );
    expect(reg.web.map((p) => p.name)).toEqual(["bing", "duckduckgo", "google"]);
    const s2 = settings({ FEARCH_ENGINES: "google,duckduckgo" });
    const reg2 = new SearchRegistry(
      s2,
      new Cache(null),
      new Audit(s2),
      {
        get: async () => {
          throw new Error("no");
        },
      } as never,
      engineProviders(
        s2,
        fakeBrowser(async () => ({ html: "", status: 200 })),
        new RobotsChecker(new Cache(null), async () => ({ status: 404, body: "" })),
        new Politeness(1, { count: 1, windowMs: 1 }),
      ),
    );
    expect(reg2.web.map((p) => p.name)).toEqual(["duckduckgo"]);
    expect(reg2.describe()).toMatch(/engines listed but not used: google \(www\.google\.com disallows/);
  });

  it("tells the model inline when a listed engine was skipped by the robots dial", async () => {
    const s = settings({ FEARCH_ENGINES: "google,duckduckgo" });
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
    const reg = new SearchRegistry(
      s,
      new Cache(null),
      new Audit(s),
      {
        get: async () => {
          throw new Error("no");
        },
      } as never,
      engines,
    );
    const out = await reg.search({ query: "turndown", maxResults: 3 });
    expect(out.providers.map((p) => p.name)).toEqual(["duckduckgo"]);
    expect(out.notes.join("\n")).toMatch(
      /google: listed in --engines but not used — www\.google\.com disallows .*--robots off/,
    );
  });

  it("searches through the browser and honours the live robots.txt under the current policy", async () => {
    const seen: string[] = [];
    const p = provider("duckduckgo", async (u) => {
      seen.push(u);
      return { html: LITE, status: 200 };
    });
    const { results: out } = await p.search({ query: "turndown gfm", maxResults: 5 });
    expect(out.length).toBe(2);
    expect(seen[0]).toContain("lite.duckduckgo.com/lite/?q=turndown%20gfm");
    // Google under the default policy: the live robots.txt says no (belt and braces on top of eligibility).
    await expect(
      provider("google", async () => ({ html: GOOGLE, status: 200 })).search({ query: "x", maxResults: 5 }),
    ).rejects.toThrow(/robots\.txt disallows/);
    // …and under robots=off it is opened and parsed.
    const { results: g } = await provider("google", async () => ({ html: GOOGLE, status: 200 }), {
      FEARCH_ROBOTS_POLICY: "off",
    }).search({ query: "x", maxResults: 5 });
    expect(g[0].url).toContain("npmjs.com");
  });

  it("treats a bot-check page as a final 'no' (rate-limited, no retry) and says how a person could pass it", async () => {
    let calls = 0;
    const p = provider("duckduckgo", async () => {
      calls++;
      return { html: BOTCHECK, status: 202 };
    });
    await expect(p.search({ query: "x", maxResults: 5 })).rejects.toThrow(/rate-limited.*--handoff/);
    expect(calls).toBe(1);
    await expect(p.search({ query: "x", maxResults: 5 })).rejects.toThrow(SearchError);
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
    const a = settingsFromArgs(["--robots", "off", "--handoff", "search", "some query", "--n", "3"], base);
    expect([a.settings.robotsPolicy, a.settings.browser, a.settings.handoff, a.settings.engines]).toEqual([
      "off",
      "headed",
      true,
      ["google", "duckduckgo"],
    ]);
    expect(a.rest).toEqual(["search", "some query", "--n", "3"]);
    const b = settingsFromArgs(["--robots=strict", "--browser=off", "--engines", "bing,duckduckgo", "doctor"], {
      ...base,
      FEARCH_ROBOTS_POLICY: "off",
    });
    expect([b.settings.robotsPolicy, b.settings.browser, b.settings.engines, b.rest]).toEqual([
      "strict",
      "off",
      ["bing", "duckduckgo"],
      ["doctor"],
    ]);
    // robots off without a person to pass Google's check: DuckDuckGo only, unless engines are set explicitly
    expect(settingsFromArgs(["--robots", "off"], base).settings.engines).toEqual(["duckduckgo"]);
    expect(settingsFromArgs(["--robots", "off", "--browser", "headed", "--handoff"], base).settings.engines).toEqual([
      "google",
      "duckduckgo",
    ]);
    expect(settingsFromArgs([], base).settings.engines).toEqual(["duckduckgo"]);
    expect(() => settingsFromArgs(["--robots"], base)).toThrow(/needs a value/);
  });
});

describe("config dials", () => {
  it("parses browser/identity/handoff/session/engines/robots and keeps headed-only dials off in headless mode", () => {
    const d = settings();
    expect([d.browser, d.browserIdentity, d.handoff, d.browserSession, d.engines, d.robotsPolicy]).toEqual([
      "headless",
      "header",
      false,
      false,
      ["duckduckgo"],
      "default",
    ]);
    const h = settings({
      FEARCH_BROWSER: "headed",
      FEARCH_HANDOFF: "1",
      FEARCH_BROWSER_SESSION: "on",
      FEARCH_BROWSER_IDENTITY: "none",
      FEARCH_ENGINES: "Google, bing",
      FEARCH_ROBOTS_POLICY: "off",
    });
    expect([h.browser, h.browserIdentity, h.handoff, h.browserSession, h.engines, h.robotsPolicy]).toEqual([
      "headed",
      "none",
      true,
      true,
      ["google", "bing"],
      "off",
    ]);
    expect(h.browserStatePath).toMatch(/browser-state\.json$/);
    const hl = settings({ FEARCH_HANDOFF: "1", FEARCH_BROWSER_SESSION: "1" });
    expect([hl.handoff, hl.browserSession]).toEqual([false, false]);
    expect(settings({ FEARCH_BROWSER: "auto" }).browser).toBe("headless");
    expect(settings({ FEARCH_ENGINES: "" }).engines).toEqual([]);
    // Exa is off unless asked for; --exa turns it on at the default URL.
    expect(settings().exaHostedUrl).toBe("");
    expect(
      settingsFromArgs(["--exa"], { FEARCH_NO_CACHE: "1", FEARCH_AUDIT_LOG: "off", FEARCH_LOG_LEVEL: "error" }).settings
        .exaHostedUrl,
    ).toBe("https://mcp.exa.ai/mcp");
  });
});

describe("google AI overview", () => {
  const fixture = readFileSync(new URL("../../../tests/fixtures/google-ai-overview.html", import.meta.url), "utf8");
  it("extracts the labelled summary and its sources from a real page region", () => {
    const ov = parseGoogleOverview(fixture);
    expect(ov).not.toBeNull();
    expect(ov!.text).toMatch(/^A REST API/);
    expect(ov!.text).not.toContain("not available");
    expect(ov!.text.length).toBeLessThanOrEqual(2500);
    expect(ov!.sources.map((s) => s.url)).toContain("https://www.youtube.com/watch?v=-mN3VyJuCjM");
  });
  it("returns null for stubs and pages without an overview", () => {
    expect(parseGoogleOverview(GOOGLE_2026)).toBeNull();
    // the hidden "not available" fallback spans alone are not a summary
    const stub = `<div id="search"><div id="m-x-content"><span style="display:none"><span>An AI Overview is not available for this search</span></span><div>AI Overview</div></div></div>`;
    expect(parseGoogleOverview(stub)).toBeNull();
  });
  it("flows from the engine through the registry into the rendered output, labelled and cached", async () => {
    const page = `<html><body><div id="search">${fixture}<div class="yuRUbf"><a class="zReHs" href="https://example.com/rest"><h3>REST</h3><cite>https://example.com › rest</cite></a></div></div></body></html>`;
    const s = settings({ FEARCH_ENGINES: "google", FEARCH_ROBOTS_POLICY: "off" });
    const robots = new RobotsChecker(new Cache(null), async () => ({ status: 404, body: "" }), "off");
    const engines = engineProviders(
      s,
      fakeBrowser(async () => ({ html: page, status: 200 })),
      robots,
      new Politeness(1, { count: 100, windowMs: 60_000 }),
    );
    const cache = new Cache(null);
    const reg = new SearchRegistry(
      s,
      cache,
      new Audit(s),
      {
        get: async () => {
          throw new Error("no");
        },
      } as never,
      engines,
    );
    const out = await reg.search({ query: "what is a rest api", maxResults: 3 });
    expect(out.summary?.provider).toBe("google");
    expect(out.summary?.text).toMatch(/^A REST API/);
    const rendered = renderResults("what is a rest api", out);
    expect(rendered).toContain("Google's AI Overview");
    expect(rendered).toContain("unverified");
    expect(rendered).toContain("Sources: [1] https://www.youtube.com/watch");
    // cached outcomes keep the summary
    const again = await reg.search({ query: "what is a rest api", maxResults: 3 });
    expect(again.fromCache).toBe(true);
    expect(again.summary?.text).toMatch(/^A REST API/);
  });
});
