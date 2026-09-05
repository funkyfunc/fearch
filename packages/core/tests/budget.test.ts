import { describe, expect, it } from "vitest";
import { applyBudget, footer } from "../src/fetch/budget.js";

const TEXT = "para one\n\npara two\n\n```py\ncode line 1\ncode line 2\n```\n\npara three\n\npara four";

describe("budget", () => {
  it("cuts at a paragraph boundary", () => {
    const w = applyBudget(TEXT, 0, 30);
    expect(w.text).toBe("para one\n\npara two\n");
    expect(w.end).toBe(20);
    expect(w.total).toBe(TEXT.length);
    expect(w.truncated).toBe(true);
    expect(footer(w)).toContain('cursor="20"');
    expect(footer(w, { nextCursor: "20@read" })).toContain('cursor="20@read"');
  });

  it("does not split fenced code that fits on the next page", () => {
    const w = applyBudget(TEXT, 0, 45);
    expect((w.text.match(/```/g) ?? []).length % 2).toBe(0);
    expect(w.text).not.toContain("code line");
  });

  it("closes and re-opens a fenced block that is longer than one page", () => {
    const block =
      "intro\n\n```python\n" + Array.from({ length: 30 }, (_, i) => `line ${i}`).join("\n") + "\n```\n\nafter";
    const pages: string[] = [];
    let start = 0;
    for (;;) {
      const w = applyBudget(block, start, 80);
      pages.push(w.text);
      // Every page on its own is balanced markdown.
      expect((w.text.match(/```/g) ?? []).length % 2, w.text).toBe(0);
      if (!w.truncated) break;
      start = w.end;
    }
    expect(pages.length).toBeGreaterThan(2);
    // A continuation page re-opens the fence with the same info string.
    expect(pages[1].startsWith("```python\n")).toBe(true);
    // Nothing from the source was lost or duplicated: the code lines survive exactly once.
    const lines = pages.join("\n").match(/^line \d+$/gm) ?? [];
    expect(lines.length).toBe(30);
    expect(new Set(lines).size).toBe(30);
  });

  it("continues deterministically to completion", () => {
    const pieces: string[] = [];
    let start = 0;
    for (;;) {
      const w = applyBudget(TEXT, start, 25);
      pieces.push(w.text);
      if (!w.truncated) break;
      start = w.end;
    }
    // Fence lines may be re-emitted at a page boundary; everything else must appear exactly once.
    const strip = (s: string) => s.replace(/^```.*$/gm, "").replace(/\n/g, "");
    expect(strip(pieces.join(""))).toBe(strip(TEXT));
  });

  it("handles start past end and short text", () => {
    const w = applyBudget(TEXT, 10_000, 100);
    expect(w.text).toBe("");
    expect(w.truncated).toBe(false);
    expect(footer(w)).toBe("");
    const s = applyBudget("short", 0, 100);
    expect(s.text).toBe("short");
    expect(s.truncated).toBe(false);
  });
});
