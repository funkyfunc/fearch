import { describe, expect, it } from "vitest";
import { footer } from "../src/fetch/budget.js";
import { BadRequest } from "../src/fetch/errors.js";
import { describeAge, freshness } from "../src/fetch/freshness.js";
import { findPattern, renderPattern } from "../src/fetch/pattern.js";

const MD =
  "# Guide\n\nIntro line.\n\n## Retries\n\nSet retries=3 in config.\nRetries default to 0.\n\n## Timeouts\n\nTimeout is 30s.\n";

describe("pattern", () => {
  it("finds matches with context and merges overlapping windows", () => {
    const res = findPattern(MD, "retries", 20);
    expect(res.total).toBe(3);
    expect(res.windows.length).toBeLessThan(3); // adjacent hits merged
    expect(res.windows[0].text).toContain("Retries");
    const text = renderPattern("retries", res, MD.length);
    expect(text).toContain("3 matches");
    expect(text).toMatch(/\[Position: \d+-\d+\]/);
  });
  it("reports no matches and rejects bad regexes as the caller's error", () => {
    expect(renderPattern("zzz", findPattern(MD, "zzz"), MD.length)).toContain("no matches");
    expect(() => findPattern(MD, "(")).toThrow(BadRequest);
    expect(() => findPattern(MD, "(")).toThrow(/Invalid pattern/);
    expect(() => findPattern(MD, "x".repeat(600))).toThrow(/under 500/);
  });

  it("stops a catastrophically backtracking pattern instead of hanging the call", () => {
    const md = "a".repeat(40) + "!";
    const started = Date.now();
    expect(() => findPattern(md, "^(a+)+$")).toThrow(/took more than/);
    expect(Date.now() - started).toBeLessThan(10_000);
  });
});

describe("freshness", () => {
  const now = Date.parse("2026-08-28T00:00:00Z");
  it("prefers page metadata over headers and flags stale pages", () => {
    const html =
      '<html><head><meta property="article:modified_time" content="2026-04-23T10:00:00Z"></head><body></body></html>';
    const f = freshness({ "last-modified": "Mon, 01 Jan 2018 00:00:00 GMT" }, html, now);
    expect(f.date).toBe("2026-04-23");
    expect(f.source).toBe("article:modified_time");
    expect(f.stale).toBe(false);
    expect(describeAge(f)).toBe("updated 2026-04-23 (4mo ago)");
    const old = freshness({ "last-modified": "Mon, 01 Jan 2018 00:00:00 GMT" }, undefined, now);
    expect(old.stale).toBe(true);
    expect(describeAge(old)).toContain("may be stale");
  });
  it("counts age in the UTC calendar the printed date uses", () => {
    // 2026-08-27T22:00Z is 2 hours before `now`, but a different UTC day: "1d ago", never "today".
    const f = freshness({ "last-modified": "Thu, 27 Aug 2026 22:00:00 GMT" }, undefined, now);
    expect(f.date).toBe("2026-08-27");
    expect(describeAge(f)).toBe("updated 2026-08-27 (1d ago)");
    const same = freshness({ "last-modified": "Fri, 28 Aug 2026 00:00:00 GMT" }, undefined, now + 3600_000);
    expect(describeAge(same)).toBe("updated 2026-08-28 (today, UTC)");
    // a date "in the future" relative to the injected clock is ignored, not relative to the real one
    const future = freshness({ "last-modified": "Sun, 30 Aug 2026 00:00:00 GMT" }, undefined, now);
    expect(future.date).toBeUndefined();
  });
  it("reads JSON-LD and ignores garbage", () => {
    const html = '<script type="application/ld+json">{"@type":"Article","dateModified":"2026-08-01"}</script>';
    expect(freshness({}, html, now).date).toBe("2026-08-01");
    expect(freshness({ "last-modified": "not a date" }, "<html></html>", now).date).toBeUndefined();
  });
});

describe("footer", () => {
  it("includes percent and section counts", () => {
    const f = footer(
      { text: "", start: 0, end: 250, total: 1000, truncated: true },
      { sections: { shown: 3, total: 14 }, nextCursor: "250@read" },
    );
    expect(f).toContain("(25%)");
    expect(f).toContain("3 of 14 sections");
    expect(f).toContain('cursor="250@read"');
  });
});

describe("pattern mode — grep ergonomics", () => {
  it("anchors ^ and $ to lines, and explains inline flags instead of a bare regex error", () => {
    const md = "alpha\nDisallow: /search\nomega";
    const r = findPattern(md, "^disallow.*$", 10);
    expect(r.total).toBe(1);
    expect(r.windows[0].text).toContain("Disallow: /search");
    expect(() => findPattern(md, "(?i)x", 10)).toThrow(/inline flags/);
  });
});
