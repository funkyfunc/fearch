/**
 * Browser-tier ladder tests. Unit tests use a fake renderer; the integration test spins up a local
 * HTTP server and drives the real headless Chromium (skipped if Chromium is not installed).
 */
import { createServer, type Server } from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Audit } from "../src/audit.js";
import { Cache } from "../src/cache.js";
import { settingsFromEnv } from "../src/config.js";
import { BrowserRenderer, BrowserUnavailable } from "../src/fetch/browser.js";
import { DiagnosedError, Fetcher } from "../src/fetch/pipeline.js";
import { RobotsChecker } from "../src/fetch/robots.js";
import { Transport } from "../src/fetch/transport.js";
import { Politeness } from "../src/politeness.js";

const JS_PAGE = `<html><head><title>SPA Docs</title></head><body><div id="app"></div>
<script>document.getElementById('app').innerHTML = '<main><h1>Rendered Guide</h1>' +
  '<p>' + 'This content only exists after JavaScript runs. '.repeat(12) + '</p>' +
  '<h2>Install</h2><pre><code class="language-bash">npm install rendered-guide</code></pre></main>';</script>
</body></html>`;
const CHALLENGE = `<html><head><title>Just a moment...</title></head><body><div id="challenge-platform">Checking your browser before accessing the site.</div></body></html>`;
const REAL = `<html><head><title>Plain</title></head><body><main><h1>Plain page</h1><p>${"Served to browsers only. ".repeat(20)}</p><pre><code>ok</code></pre></main></body></html>`;

function makeFetcher(opts: {
  renderer?:
    | BrowserRenderer
    | {
        render: (u: string) => Promise<{ html: string; finalUrl: string; status: number; salvaged: boolean }>;
        enabled: () => boolean;
      };
  env?: Record<string, string>;
}) {
  const settings = settingsFromEnv({
    FEARCH_NO_CACHE: "1",
    FEARCH_AUDIT_LOG: "off",
    FEARCH_LOG_LEVEL: "error",
    FEARCH_ALLOW_PRIVATE: "1",
    FEARCH_PER_HOST_DELAY_MS: "1",
    ...(opts.env ?? {}),
  });
  const audit = new Audit(settings);
  const cache = new Cache(null);
  const transport = new Transport(settings, audit);
  const politeness = new Politeness(1, { count: 100, windowMs: 60_000 });
  const robots = new RobotsChecker(cache, async () => ({ status: 404, body: "" }));
  const renderer = (opts.renderer ?? new BrowserRenderer(settings, audit)) as BrowserRenderer;
  return { fetcher: new Fetcher(settings, cache, transport, robots, politeness, audit, renderer), renderer };
}

describe("browser ladder (fake renderer)", () => {
  let server: Server;
  let base = "";
  beforeAll(async () => {
    server = createServer((req, res) => {
      const ua = String(req.headers["user-agent"] ?? "");
      if (req.url === "/shell") return res.writeHead(200, { "content-type": "text/html" }).end(JS_PAGE);
      if (req.url === "/browsers-only") {
        if (/Mozilla/.test(ua)) return res.writeHead(200, { "content-type": "text/html" }).end(REAL);
        return res.writeHead(403, { "content-type": "text/html" }).end("<html><body>Forbidden</body></html>");
      }
      if (req.url === "/challenge") return res.writeHead(403, { "content-type": "text/html" }).end(CHALLENGE);
      if (req.url === "/robots.txt") return res.writeHead(404).end();
      res.writeHead(404).end("nope");
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  });
  afterAll(() => server.close());

  it("uses the renderer for JS shells and 403s, exactly once, and stops when the browser is refused too", async () => {
    const calls: string[] = [];
    const fake = {
      enabled: () => true,
      async render(u: string) {
        calls.push(u);
        if (u.endsWith("/challenge")) return { html: CHALLENGE, finalUrl: u, status: 403, salvaged: false };
        if (u.endsWith("/shell"))
          return {
            html: JS_PAGE.replace(
              '<div id="app"></div>',
              "<main><h1>Rendered Guide</h1><p>" +
                "Rendered. ".repeat(40) +
                "</p><pre><code>npm install x</code></pre></main>",
            ),
            finalUrl: u,
            status: 200,
            salvaged: false,
          };
        return { html: REAL, finalUrl: u, status: 200, salvaged: false };
      },
    };
    const { fetcher } = makeFetcher({ renderer: fake });

    const shell = await fetcher.fetch(`${base}/shell`);
    expect(shell.source).toBe("browser");
    expect(shell.markdown).toContain("# Rendered Guide");
    expect(calls.filter((c) => c.endsWith("/shell")).length).toBe(1);

    const gated = await fetcher.fetch(`${base}/browsers-only`);
    expect(gated.source).toBe("browser");
    expect(gated.markdown).toContain("Served to browsers only");

    // The host is now remembered as needing a browser: the plain attempt is skipped next time.
    const again = await fetcher.fetch(`${base}/browsers-only?x=1`);
    expect(again.source).toBe("browser");

    // Fresh fetcher (no host memory) for the refusal ladder.
    const { fetcher: fresh } = makeFetcher({ renderer: fake });
    await expect(fresh.fetch(`${base}/challenge`)).rejects.toThrow(DiagnosedError);
    const { fetcher: fresh2 } = makeFetcher({ renderer: fake });
    try {
      await fresh2.fetch(`${base}/challenge`);
    } catch (e) {
      const d = (e as DiagnosedError).diagnosis;
      expect(d.kind).toBe("captcha_or_challenge");
      expect(d.retryable).toBe(false);
      expect(d.attempts).toEqual(["direct: captcha_or_challenge", "browser: captcha_or_challenge"]);
      expect(d.message).toContain("browser was also tried");
    }
    // renderer called once per fetch of /challenge, never a second time within a fetch
    expect(calls.filter((c) => c.endsWith("/challenge")).length).toBe(2);
  });

  it("raw mode returns the rendered DOM when the page needs a browser, and the plain body when it doesn't", async () => {
    const fake = {
      enabled: () => true,
      async render(u: string) {
        return {
          html: "<html><body><main>DOM after JavaScript ran</main></body></html>",
          finalUrl: u,
          status: 200,
          salvaged: false,
          usedSession: false,
          handedOff: false,
        };
      },
    };
    const { fetcher } = makeFetcher({ renderer: fake });
    const shell = await fetcher.fetch(`${base}/shell`, { raw: true });
    expect(shell.source).toContain("raw (browser DOM)");
    expect(shell.markdown).toContain("DOM after JavaScript ran");
    // a page that renders fine over plain HTTP costs no browser and returns its bytes as-is
    const plain = await fetcher.fetch(`${base}/browsers-only`, { raw: true });
    expect(plain.source).toContain("raw (browser DOM)"); // 403 to the plain client → browser DOM
    const { fetcher: f2 } = makeFetcher({ renderer: fake });
    const target = await f2.fetch(`${base}/robots.txt`, { raw: true });
    expect(target.source).toContain("raw (");
    expect(target.source).not.toContain("browser DOM");
  });

  it("a bot check the browser still shows is a refusal, not content — with 'call again' when it was handed to the person", async () => {
    // A Cloudflare interstitial has text and no empty mount point: the shell heuristic alone waves it through.
    const interstitial = `<html><head><title>Just a moment...</title></head><body><div class="main-content"><h1>www.example.test</h1><p>We must verify your session before you can proceed</p><p>Verification successful. Waiting for www.example.test to respond</p></div><script src="/cdn-cgi/challenge-platform/h/b/orchestrate/chl_page/v1"></script></body></html>`;
    const unattended = {
      enabled: () => true,
      async render(u: string) {
        return { html: interstitial, finalUrl: u, status: 200, salvaged: false, usedSession: false, handedOff: false };
      },
    };
    const { fetcher } = makeFetcher({ renderer: unattended });
    await expect(fetcher.fetch(`${base}/challenge`)).rejects.toMatchObject({
      diagnosis: { kind: "captcha_or_challenge", retryable: false },
    });
    const handed = {
      enabled: () => true,
      async render(u: string) {
        return {
          html: interstitial,
          finalUrl: u,
          status: 200,
          salvaged: false,
          usedSession: true,
          handedOff: false,
          handoffWhere: "a tab in your Chrome",
        };
      },
    };
    const { fetcher: f2 } = makeFetcher({ renderer: handed });
    try {
      await f2.fetch(`${base}/challenge`);
      expect.unreachable();
    } catch (e) {
      const d = (e as DiagnosedError).diagnosis;
      expect(d.kind).toBe("captcha_or_challenge");
      expect(d.retryable).toBe(true);
      expect(d.message).toContain("a tab in your Chrome");
      expect(d.nextAction).toMatch(/call fetch again on this same URL/);
    }
    // raw mode is no exception: the interstitial DOM is not "the page's raw HTML"
    const { fetcher: f3 } = makeFetcher({ renderer: unattended });
    await expect(f3.fetch(`${base}/challenge`, { raw: true })).rejects.toThrow(DiagnosedError);
  });

  it("never re-classifies a page the person unlocked as a refusal — their pass is the final word", async () => {
    // Behind the gate is an almost-empty demo page; without the handoff this would be js_required.
    const tiny = `<html><head><title>Demo</title></head><body><h1>Success!</h1></body></html>`;
    const fake = {
      enabled: () => true,
      async render(u: string) {
        return { html: tiny, finalUrl: u, status: 200, salvaged: false, handedOff: true, usedSession: false };
      },
    };
    const { fetcher } = makeFetcher({ renderer: fake });
    const doc = await fetcher.fetch(`${base}/challenge`);
    expect(doc.source).toContain("challenge passed by you");
    expect(doc.markdown).toContain("Success!");
  });

  it("never renders when robots disallows, and reports when the browser is unavailable", async () => {
    const calls: string[] = [];
    const fake = {
      enabled: () => true,
      async render(u: string) {
        calls.push(u);
        throw new BrowserUnavailable("no chromium");
      },
    };
    const { fetcher } = makeFetcher({ renderer: fake });
    try {
      await fetcher.fetch(`${base}/browsers-only`);
    } catch (e) {
      const d = (e as DiagnosedError).diagnosis;
      expect(d.kind).toBe("blocked_or_waf");
      expect(d.attempts?.[1]).toContain("browser: unavailable");
    }

    const settings = settingsFromEnv({
      FEARCH_NO_CACHE: "1",
      FEARCH_AUDIT_LOG: "off",
      FEARCH_ALLOW_PRIVATE: "1",
      FEARCH_PER_HOST_DELAY_MS: "1",
    });
    const audit = new Audit(settings);
    const cache = new Cache(null);
    const robots = new RobotsChecker(cache, async () => ({ status: 200, body: "User-agent: *\nDisallow: /\n" }));
    const f = new Fetcher(
      settings,
      cache,
      new Transport(settings, audit),
      robots,
      new Politeness(1, { count: 100, windowMs: 60_000 }),
      audit,
      fake as unknown as BrowserRenderer,
    );
    const before = calls.length;
    await expect(f.fetch(`${base}/browsers-only`)).rejects.toMatchObject({ diagnosis: { kind: "robots_disallowed" } });
    expect(calls.length).toBe(before);
  });

  it("is skipped entirely when FEARCH_BROWSER=off", async () => {
    const calls: string[] = [];
    const fake = {
      enabled: () => false,
      async render(u: string) {
        calls.push(u);
        return { html: REAL, finalUrl: u, status: 200, salvaged: false };
      },
    };
    const { fetcher } = makeFetcher({ renderer: fake, env: { FEARCH_BROWSER: "off" } });
    await expect(fetcher.fetch(`${base}/browsers-only`)).rejects.toMatchObject({
      diagnosis: { kind: "blocked_or_waf" },
    });
    expect(calls.length).toBe(0);
  });
});

describe("browser tier (real Chromium)", () => {
  let server: Server;
  let base = "";
  let renderer: BrowserRenderer;
  let available = true;
  beforeAll(async () => {
    server = createServer((req, res) => {
      if (req.url === "/shell") return res.writeHead(200, { "content-type": "text/html" }).end(JS_PAGE);
      if (req.url === "/ua")
        return res
          .writeHead(200, { "content-type": "text/html" })
          .end(
            `<html><body><main><p>UA: ${req.headers["user-agent"]}</p><p>From: ${req.headers["from"]}</p><p>X-Agent: ${req.headers["x-agent"]}</p><p>${"x ".repeat(150)}</p></main></body></html>`,
          );
      res.writeHead(404).end();
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    const settings = settingsFromEnv({
      FEARCH_NO_CACHE: "1",
      FEARCH_AUDIT_LOG: "off",
      FEARCH_LOG_LEVEL: "error",
      FEARCH_ALLOW_PRIVATE: "1",
    });
    renderer = new BrowserRenderer(settings, new Audit(settings));
    try {
      await renderer.render(`${base}/ua`, { httpFallback: true });
    } catch (e) {
      if (!(e instanceof BrowserUnavailable)) throw e;
      available = false;
      // CI installs Chromium: unavailability there is broken setup, and silence would shed this coverage.
      if (process.env.CI) throw e;
    }
  }, 60_000);
  afterAll(async () => {
    await renderer?.close();
    server.close();
  });

  it("renders a JS-only page and identifies itself honestly", async (t) => {
    if (!available) return t.skip(); // Chromium not installed on this machine
    const r = await renderer.render(`${base}/shell`, { httpFallback: true });
    expect(r.html).toContain("Rendered Guide");
    expect(r.html).toContain("npm install rendered-guide");
    const ua = await renderer.render(`${base}/ua`, { httpFallback: true });
    // default identity=header: stock Chrome UA, tool named in From / X-Agent on every request
    expect(renderer.browserUserAgent).toMatch(/Chrome\//);
    expect(renderer.browserUserAgent).not.toContain("HeadlessChrome");
    expect(renderer.browserUserAgent).not.toContain("fearch/");
    expect(ua.html).toMatch(/X-Agent: fearch\//);
    expect(ua.html).toMatch(/From: https?:\/\//);

    // identity=none: plain Chrome, no identifying headers, and still no automation hiding.
    const none = new BrowserRenderer(
      settingsFromEnv({
        FEARCH_NO_CACHE: "1",
        FEARCH_AUDIT_LOG: "off",
        FEARCH_LOG_LEVEL: "error",
        FEARCH_ALLOW_PRIVATE: "1",
        FEARCH_BROWSER_IDENTITY: "none",
      }),
      new Audit({ auditLog: "off", logLevel: "error" }),
    );
    try {
      const r3 = await none.render(`${base}/ua`, { httpFallback: true });
      expect(r3.html).toMatch(/From: undefined/);
      expect(r3.html).toMatch(/X-Agent: undefined/);
      expect(r3.html).not.toContain("fearch/");
      expect(r3.usedSession).toBe(false);
    } finally {
      await none.close();
    }
  }, 90_000);

  it("blocks private subresources and non-http schemes at the request gate", async (t) => {
    if (!available) return t.skip();
    // With allowPrivate the gate lets 127.0.0.1 through; verify a metadata-style host is still refused when not allowed.
    const strict = new BrowserRenderer(
      settingsFromEnv({ FEARCH_NO_CACHE: "1", FEARCH_AUDIT_LOG: "off", FEARCH_LOG_LEVEL: "error" }),
      new Audit({ auditLog: "off", logLevel: "error" }),
    );
    try {
      await expect(strict.render("http://169.254.169.254/latest/meta-data/")).rejects.toThrow();
    } finally {
      await strict.close();
    }
  }, 60_000);
});
