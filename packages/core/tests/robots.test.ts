import { describe, expect, it } from "vitest";
import { Cache } from "../src/cache.js";
import { RobotsChecker } from "../src/fetch/robots.js";

function checker(body: string | number, opts: { calls?: string[]; policy?: "default" | "strict" } = {}) {
  const fetcher = async (url: string) => {
    opts.calls?.push(url);
    if (typeof body === "number") return { status: body, body: "" };
    return { status: 200, body };
  };
  return new RobotsChecker(new Cache(null), fetcher, opts.policy);
}

describe("robots", () => {
  it("allows when no rules block us, and caches per host", async () => {
    const calls: string[] = [];
    const c = checker("User-agent: *\nDisallow: /private/\n", { calls });
    expect((await c.check("https://example.com/docs")).allowed).toBe(true);
    expect((await c.check("https://example.com/private/x")).allowed).toBe(false);
    expect(calls).toEqual(["https://example.com/robots.txt"]);
  });

  it("honours our own token", async () => {
    const c = checker("User-agent: fearch\nDisallow: /\n\nUser-agent: *\nAllow: /\n");
    const d = await c.check("https://example.com/");
    expect(d.allowed).toBe(false);
    expect(d.reason).toContain("disallowed for this agent");
  });

  it("honours user-initiated agent opt-outs but not training-crawler opt-outs (default policy)", async () => {
    // Substack-style: training crawlers blocked, agents not mentioned → we may read.
    const training =
      "User-agent: GPTBot\nDisallow: /\n\nUser-agent: ClaudeBot\nDisallow: /\n\nUser-agent: CCBot\nDisallow: /\n\nUser-agent: Google-Extended\nDisallow: /\n\nUser-agent: *\nAllow: /\n";
    expect((await checker(training).check("https://example.com/article")).allowed).toBe(true);
    // Figma-style: the user-initiated agent token itself is blocked → we stop.
    const agent = "User-agent: Claude-User\nDisallow: /\n\nUser-agent: *\nAllow: /\n";
    const d = await checker(agent).check("https://example.com/article");
    expect(d.allowed).toBe(false);
    expect(d.reason).toContain("Claude-User");
    // strict: training opt-outs count too.
    expect((await checker(training, { policy: "strict" }).check("https://example.com/a")).reason).toContain("GPTBot");
  });

  it("reads Crawl-delay", async () => {
    const c = checker("User-agent: *\nCrawl-delay: 5\n");
    expect((await c.check("https://example.com/")).crawlDelayMs).toBe(5000);
  });

  it("fails closed on 401/403 (a choice), on 5xx/network (RFC 9309 §2.3.1.4), and open on 404", async () => {
    const forbidden = await checker(403).check("https://a.test/");
    expect(forbidden.allowed).toBe(false);
    // The RFC would permit access on a 4xx; the message must say the closed door is our choice.
    expect(forbidden.reason).toMatch(/fails closed on 4xx.*§2\.3\.1\.3 would permit/);
    expect((await checker(401).check("https://a.test/")).allowed).toBe(false);
    const down = await checker(503).check("https://a.test/");
    expect(down.status).toBe("unavailable");
    expect(down.reason).toContain("§2.3.1.4");
    expect((await checker(404).check("https://a.test/")).allowed).toBe(true);
    const failing = new RobotsChecker(new Cache(null), async () => {
      throw new Error("ECONNRESET");
    });
    expect((await failing.check("https://a.test/")).allowed).toBe(false);
  });

  it("passes the page's http fallback to the probe and does not cache a network failure", async () => {
    const seen: Array<{ url: string; httpFallback: boolean }> = [];
    let attempts = 0;
    const c = new RobotsChecker(new Cache(null), async (url, opts) => {
      seen.push({ url, httpFallback: opts.httpFallback });
      if (++attempts === 1) throw new Error("ECONNREFUSED");
      return { status: 200, body: "User-agent: *\nAllow: /\n" };
    });
    expect((await c.check("https://plain.test/page", { httpFallback: true })).allowed).toBe(false);
    // The failure was not remembered for an hour: the next check asks again and gets the real answer.
    expect((await c.check("https://plain.test/page", { httpFallback: true })).allowed).toBe(true);
    expect(seen).toEqual([
      { url: "https://plain.test/robots.txt", httpFallback: true },
      { url: "https://plain.test/robots.txt", httpFallback: true },
    ]);
  });

  it("exempts documented API hosts", async () => {
    const c = checker("User-agent: *\nDisallow: /\n");
    expect((await c.check("https://api.github.com/repos/o/r")).status).toBe("api");
  });
});
