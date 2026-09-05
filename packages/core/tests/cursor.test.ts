import { describe, expect, it } from "vitest";
import { makeCursor, parseCursor, resolveCursor, viewId } from "../src/fetch/cursor.js";

describe("cursor", () => {
  it("round-trips and scopes offsets to a view", () => {
    const view = viewId("focus", "Retries");
    expect(view).toMatch(/^focus:[0-9a-f]{6}$/);
    expect(viewId("focus", "retries ")).toBe(view); // case/space-insensitive
    expect(viewId("read")).toBe("read");
    const c = makeCursor(1200, view);
    expect(parseCursor(c)).toEqual({ offset: 1200, view });
    expect(resolveCursor(c, view)).toEqual({ offset: 1200 });
  });

  it("ignores cursors from another view with a note, accepts bare numbers, and names junk", () => {
    const r = resolveCursor("1200@focus:abcdef", "read");
    expect(r.offset).toBe(0);
    expect(r.note).toContain("different view");
    expect(resolveCursor("450", "read")).toEqual({ offset: 450 });
    expect(resolveCursor(450, "read")).toEqual({ offset: 450 });
    // A typo'd cursor must never silently re-serve page one as if it were the continuation.
    const junk = resolveCursor("garbage", "read");
    expect(junk.offset).toBe(0);
    expect(junk.note).toMatch(/"garbage" is not a cursor/);
    expect(parseCursor("garbage")).toBeNull();
    expect(resolveCursor(undefined, "read")).toEqual({ offset: 0 });
  });
});
