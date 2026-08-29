import { describe, expect, it } from "vitest";
import { Cache } from "../src/cache.js";

describe("cache", () => {
  it("stores and reads pages, searches, robots", () => {
    const c = new Cache(null);
    c.setPage({ url: "https://a.test/", finalUrl: "https://a.test/", title: "T", source: "direct", markdown: "# T\n", etag: '"e"', lastModified: null, licence: "X-Robots-Tag: noai", updated: { date: "2026-01-01", source: "Last-Modified", ageDays: 10, stale: false } });
    const p = c.getPage("https://a.test/");
    expect(p?.title).toBe("T");
    expect(p?.etag).toBe('"e"');
    expect(p?.licence).toBe("X-Robots-Tag: noai");
    expect(p?.updated?.date).toBe("2026-01-01");
    expect(c.getPage("https://none.test/")).toBeNull();

    c.setSearch("k", [{ url: "u" }]);
    expect(c.getSearch<Array<{ url: string }>>("k")).toEqual([{ url: "u" }]);

    c.setRobots("a.test", 200, "User-agent: *\nAllow: /");
    expect(c.getRobots("a.test")?.body).toContain("Allow");
    c.close();
  });
});
