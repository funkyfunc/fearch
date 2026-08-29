import { describe, expect, it } from "vitest";
import { resolveFastPath, rewriteUrl, wrapFile } from "../src/fetch/resolver.js";
import type { HttpLike } from "../src/fetch/types.js";

function fakeHttp(routes: Record<string, unknown>): HttpLike {
  return async (url) => {
    const key = url.split("?")[0];
    for (const [prefix, payload] of Object.entries(routes)) {
      if (key.startsWith(prefix)) {
        const isJson = typeof payload === "object";
        return {
          status: 200,
          headers: { "content-type": isJson ? "application/json" : "text/plain" },
          text: async () => (isJson ? JSON.stringify(payload) : String(payload)),
          json: async () => payload,
        };
      }
    }
    return { status: 404, headers: {}, text: async () => "", json: async () => ({}) };
  };
}

describe("resolver", () => {
  it("wraps files by extension", () => {
    expect(wrapFile("README.md", "# hi")).toEqual(["markdown", "# hi"]);
    expect(wrapFile("main.py", "print(1)")[1]).toBe("```python\nprint(1)\n```\n");
    expect(wrapFile("x.unknownext", "a```b")[1].startsWith("````\n")).toBe(true);
  });

  it("rewrites arXiv abs only", () => {
    expect(rewriteUrl("https://arxiv.org/abs/2511.16397v2")).toBe("https://arxiv.org/abs/2511.16397");
    expect(rewriteUrl("https://arxiv.org/pdf/2511.16397")).toBe("https://arxiv.org/pdf/2511.16397");
  });

  it("github blob → raw, readme, issue", async () => {
    const http = fakeHttp({
      "https://raw.githubusercontent.com/o/r/main/src/app.py": "x = 1",
      "https://api.github.com/repos/o/r/readme": "# R",
      "https://api.github.com/repos/o/r/issues/7/comments": [{ user: { login: "u2" }, created_at: "2026-01-02T", body: "me too" }],
      "https://api.github.com/repos/o/r/issues/7": { title: "Bug", state: "open", user: { login: "u1" }, created_at: "2026-01-01T", comments: 1, body: "It broke" },
      "https://api.github.com/repos/o/r": { full_name: "o/r", description: "d", stargazers_count: 5, language: "Go", default_branch: "main", pushed_at: "2026-01-01T" },
    });
    let f = await resolveFastPath("https://github.com/o/r/blob/main/src/app.py", http);
    expect(f?.source).toBe("github-raw");
    expect(f?.body).toBe("```python\nx = 1\n```\n");
    f = await resolveFastPath("https://github.com/o/r", http);
    expect(f?.source).toBe("github-readme");
    expect(f?.body).toContain("# o/r");
    expect(f?.body).toContain("# R");
    f = await resolveFastPath("https://github.com/o/r/issues/7", http);
    expect(f?.source).toBe("github-issue");
    expect(f?.body).toContain("# Bug (#7)");
    expect(f?.body).toContain("**u2**");
  });

  it("pypi, npm, stackoverflow", async () => {
    const http = fakeHttp({
      "https://pypi.org/pypi/pkg/json": { info: { name: "pkg", version: "1.0", summary: "S", description: "# Readme", project_urls: { Home: "h" } } },
      "https://registry.npmjs.org/left-pad": { name: "left-pad", "dist-tags": { latest: "1.3.0" }, description: "pad", readme: "# LP" },
      "https://api.stackexchange.com/2.3/questions/1/answers": { items: [{ is_accepted: true, score: 9, answer_id: 77, owner: { display_name: "Ann" }, body: "<p>Use <code>x</code></p>" }] },
      "https://api.stackexchange.com/2.3/questions/1": { items: [{ title: "How?", score: 3, answer_count: 1, tags: ["python"], owner: { display_name: "Bob" }, body: "<p>Q body</p>" }] },
    });
    let f = await resolveFastPath("https://pypi.org/project/pkg/", http);
    expect(f?.source).toBe("pypi");
    expect(String(f?.body).startsWith("# pkg 1.0")).toBe(true);
    f = await resolveFastPath("https://www.npmjs.com/package/left-pad", http);
    expect(f?.source).toBe("npm");
    expect(f?.body).toContain("# left-pad 1.3.0");
    f = await resolveFastPath("https://stackoverflow.com/questions/1/how", http);
    expect(f?.source).toBe("stackoverflow");
    expect(f?.body).toContain("Asked by Bob");
    expect(f?.body).toContain("## Accepted answer by Ann (score 9) — https://stackoverflow.com/a/77");
    expect(f?.body).toContain("Use `x`");
    expect(f?.body).toContain("CC BY-SA 4.0");
  });

  it("github tree listings and releases via the API", async () => {
    const http = fakeHttp({
      "https://api.github.com/repos/o/r/contents/src/tool": [
        { name: "webfetch.ts", type: "file", size: 1200 },
        { name: "helpers", type: "dir" },
      ],
      "https://api.github.com/repos/o/r/releases/tags/v2.0.0": { name: "v2.0.0", tag_name: "v2.0.0", published_at: "2026-08-01T", body: "Notes here" },
      "https://api.github.com/repos/o/r/releases": [{ name: "v2.0.0", tag_name: "v2.0.0", published_at: "2026-08-01T", body: "Notes" }, { tag_name: "v1.9.0", published_at: "2026-06-01T", body: "", prerelease: true }],
    });
    const tree = await resolveFastPath("https://github.com/o/r/tree/dev/src/tool", http);
    expect(tree?.source).toBe("github-tree");
    expect(tree?.body).toContain("- helpers/");
    expect(tree?.body).toContain("- webfetch.ts (1200 B)");
    expect(tree?.body).toContain("blob/dev/src/tool/<name>");
    const rel = await resolveFastPath("https://github.com/o/r/releases/tag/v2.0.0", http);
    expect(rel?.source).toBe("github-releases");
    expect(rel?.body).toContain("## v2.0.0 (v2.0.0, 2026-08-01)");
    expect(rel?.body).toContain("Notes here");
    const list = await resolveFastPath("https://github.com/o/r/releases", http);
    expect(list?.body).toContain("v1.9.0, 2026-06-01, pre-release");
  });

  it("falls through for unknown hosts", async () => {
    expect(await resolveFastPath("https://example.com/", fakeHttp({}))).toBeNull();
    expect(await resolveFastPath("https://github.com/o/r/tree/main/dir", fakeHttp({}))).toBeNull();
  });
});
