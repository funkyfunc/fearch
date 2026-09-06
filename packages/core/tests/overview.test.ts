/** Google's generated answer (AI Overview / Web Guide), read from real pages captured 2026-09-05. */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { overviewPending, parseGoogleOverview } from "../src/search/overview.js";

const fixture = (name: string) =>
  readFileSync(new URL(`../../../tests/fixtures/google/${name}.html`, import.meta.url), "utf8");

describe("google generated answer", () => {
  it("reads a classic AI Overview as structured markdown, with the collapsed half and the citations as sources", () => {
    const ov = parseGoogleOverview(fixture("ai-overview-vitest"), "vitest useFakeTimers setInterval not advancing")!;
    expect(ov.label).toBe("AI Overview");
    expect(ov.text).toMatch(/^When \*\*`vi\.useFakeTimers\(\)`\*\* is enabled/);
    expect(ov.text).toContain("### 1. You forgot to manually advance the clock");
    expect(ov.text).toContain("```"); // code blocks survive
    expect(ov.text).not.toContain("useFakeTimers setInterval not advancing"); // the query echo is gone
    expect(ov.text).not.toMatch(/Use code with caution|Show more|AI can make mistakes|\+1$/m);
    expect(ov.text).not.toMatch(/^typescript$/m); // the language label above a code block
    expect(ov.text.length).toBeLessThanOrEqual(3010);
    expect(ov.sources.map((s) => s.url)).toContain("https://github.com/vitest-dev/vitest/issues/1772");
    expect(ov.sources.find((s) => s.url.includes("issues/1772"))!.title).toMatch(/useFakeTimers not working/);
  });

  it("keeps cited phrases inline and answer bullets in place; only citation cards become sources", () => {
    const ov = parseGoogleOverview(fixture("ai-overview-egg"), "how long to boil an egg for a runny yolk")!;
    expect(ov.text).toContain("To get a runny yolk with firm whites");
    expect(ov.text).toContain("**Set a timer:**");
    expect(ov.text).toContain("### Cooling and Peeling");
    expect(ov.text).not.toMatch(/^(Facebook·|recipetineats\.com$)/m); // source chips are not prose
    expect(ov.text).not.toMatch(/\n\s*\.\n/); // no orphaned punctuation
    expect(ov.sources.some((s) => s.url.includes("seriouseats.com"))).toBe(true);
  });

  it("keeps tables and picks the finished block over a streaming placeholder", () => {
    const ov = parseGoogleOverview(fixture("ai-overview-rest-api"), "what is a rest api")!;
    expect(ov.text).toMatch(/^The core difference is that \*\*API\*\*/);
    expect(ov.text).toContain("| Feature | API (General) | REST API |");
    expect(ov.text).not.toContain("Thinking");
    // a page carrying only a placeholder is still pending
    const placeholder = `<div><div role="heading" aria-level="2">AI Overview</div><div>Thinking a little longer…</div><div>AI can make mistakes, so double-check responses</div></div>`;
    expect(overviewPending(placeholder)).toBe(true);
    expect(parseGoogleOverview(placeholder)).toBeNull();
    expect(overviewPending(fixture("ai-overview-rest-api"))).toBe(false);
    expect(overviewPending("<div><h3>Plain results</h3></div>")).toBe(false);
  });

  it("reads Web Guide's own summary: the intro with its inline citations, before the first result card", () => {
    const ov = parseGoogleOverview(fixture("web-guide-vitest"), "vitest useFakeTimers setInterval not advancing")!;
    expect(ov.label).toBe("Web Guide");
    expect(ov.text).toMatch(
      /^When using `vi\.useFakeTimers\(\)` in Vitest, \[time is frozen\]\(https:\/\/stevekinney\.com/,
    );
    expect(ov.text).not.toMatch(/^Web Guide$/m);
    expect(ov.text).not.toContain("Classic Search");
    expect(ov.text).not.toContain("](/search"); // Google-internal links are unwrapped
    expect(ov.text).not.toContain("Official Guides and Examples"); // the result cards are results, not summary
    expect(ov.text.length).toBeLessThanOrEqual(3010); // the intro plus Web Guide's own expanded sections
    expect(ov.sources.map((s) => s.url)).toContain("https://github.com/vitest-dev/vitest/issues/6011");
  });

  it("returns null for stubs, the bare AI Mode tab, and pages without an answer", () => {
    const stub = `<div id="search"><div id="m-x-content"><span style="display:none"><span>An AI Overview is not available for this search</span></span><div role="heading">AI Overview</div><div>AI can make mistakes</div></div></div>`;
    expect(parseGoogleOverview(stub)).toBeNull();
    const nav = `<div id="search"><div role="navigation"><div><span>AI Mode</span></div><div><span>All</span></div></div><div class="g"><a href="https://example.com/x"><h3>A result</h3></a></div></div>`;
    expect(parseGoogleOverview(nav)).toBeNull();
    expect(parseGoogleOverview(fixture("classic-results-vitest"))).toBeNull(); // #rso alone has no answer block
  });
});
