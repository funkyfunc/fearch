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

  it("does not split fenced code", () => {
    const w = applyBudget(TEXT, 0, 45);
    expect((w.text.match(/```/g) ?? []).length % 2).toBe(0);
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
    const joined = pieces.map((p) => p.replace(/\n+$/, "") + "\n").join("");
    expect(joined.replace(/\n/g, "")).toBe(TEXT.replace(/\n/g, ""));
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
