/** The lower rungs: results by page shape, and the page itself, on real layouts and on one nobody has seen. */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parseByShape, resultUrl, resultsPageMarkdown } from "../src/search/shape.js";

const fixture = (name: string) =>
  readFileSync(new URL(`../../../tests/fixtures/google/${name}.html`, import.meta.url), "utf8");

/** A layout no parser has a rule for: cards of title-link, display URL, snippet, plus chrome to ignore. */
const UNKNOWN = `<html><body><header><a href="https://example.com/login">Sign in to Example Search</a></header>
<div class="q9x"><div class="r7"><a href="https://a.test/one"><span>First result about fake timers in tests</span></a><span>a.test › docs › one</span><p>Fake timers freeze time until you advance it with the clock API provided by the test runner.</p></div>
<div class="r7"><a href="/l/?uddg=https%3A%2F%2Fb.test%2Ftwo"><span>Second result: intervals and promises</span></a><span>b.test › two</span><p>Intervals that depend on promises need the asynchronous advance helpers to flush microtasks first.</p></div>
<div class="r7"><a href="https://c.test/three"><span>Third result with only a display url</span></a><span>c.test › three</span></div>
<div class="side"><a href="https://d.test/">Read more</a><a href="https://e.test/x">E</a></div></div>
<footer><a href="https://example.com/privacy">Privacy policy for this site</a></footer></body></html>`;

describe("results by page shape", () => {
  it("reads a layout it has never seen: title links with a display URL or a snippet, not the chrome", () => {
    const r = parseByShape(UNKNOWN, "example.com", "example");
    expect(r.map((x) => x.url)).toEqual(["https://a.test/one", "https://b.test/two", "https://c.test/three"]);
    expect(r[0].title).toBe("First result about fake timers in tests");
    expect(r[0].snippet).toMatch(/^Fake timers freeze time/);
    expect(r[1].url).toBe("https://b.test/two"); // unwrapped from the engine's redirector
    expect(r[2].snippet).toBe("");
  });

  it("agrees with the first-class parser on the real Google layouts", () => {
    const classic = parseByShape(fixture("classic-results-vitest"), "www.google.com", "google");
    expect(classic.length).toBeGreaterThanOrEqual(6);
    expect(classic[0].url).toBe("https://github.com/vitest-dev/vitest/issues/6011");
    expect(classic[0].snippet).not.toMatch(/›/);
    const guide = parseByShape(fixture("web-guide-vitest"), "www.google.com", "google");
    expect(guide.length).toBeGreaterThanOrEqual(10);
    expect(guide.some((x) => x.url === "https://github.com/nuxt/test-utils/issues/897")).toBe(true);
    expect(guide.every((x) => !/google\./.test(new URL(x.url).hostname))).toBe(true);
  });

  it("unwraps redirectors and refuses the engine's own pages", () => {
    expect(resultUrl("//duckduckgo.com/l/?uddg=https%3A%2F%2Fx.test%2Fp&rut=1", "lite.duckduckgo.com")).toBe(
      "https://x.test/p",
    );
    expect(resultUrl("/url?q=https://y.test/&sa=U", "www.google.com")).toBe("https://y.test/");
    expect(resultUrl("https://www.google.com/search?q=more", "www.google.com")).toBeNull();
    expect(resultUrl("/search?q=more", "www.google.com")).toBeNull();
    expect(resultUrl("mailto:a@b.c", "www.google.com")).toBeNull();
  });

  it("renders the results column as bounded markdown with its links", () => {
    const md = resultsPageMarkdown(fixture("web-guide-vitest"));
    expect(md.length).toBeLessThan(9000);
    expect(md).toContain("[1]: https://");
    expect(md).toMatch(/Manual Timer Advancement Required/);
  });
});
