import { describe, expect, it } from "vitest";
import { applyBudget } from "../src/fetch/budget.js";
import { applyLinkMode, renderPage } from "../src/fetch/render.js";

const MD = `[![Build](https://img.shields.io/x.svg)](https://ci.example.com) ![logo](https://x/logo.png) ![Diagram of flow](https://x/d.png)

See [the docs](https://example.com/docs "Docs") and [this](#anchor).

\`\`\`python
print("[not a link](http://x)")
\`\`\`
`;

describe("render", () => {
  it("strips links by default and handles images", () => {
    const { body, footer } = applyLinkMode(MD, false);
    expect(footer).toBe("");
    expect(body).toContain("See the docs and this.");
    expect(body).not.toContain("shields.io");
    expect(body).not.toContain("logo.png");
    expect(body).toContain("[image: Diagram of flow]");
    expect(body).toContain('print("[not a link](http://x)")');
  });

  it("renders reference links", () => {
    const { body, footer } = applyLinkMode(MD, true);
    expect(body).toContain("[the docs][1]");
    expect(body).toContain("this.");
    expect(body).not.toContain("[this][");
    expect(footer).toBe("Links:\n[1]: https://example.com/docs");
  });

  it("renders the page layout with header lines", () => {
    const w = applyBudget("body text\n\nmore", 0, 12);
    const out = renderPage({ title: "T", url: "https://e.com", source: "direct", window: w, facts: ["robots: allowed"], outline: "Sections not shown: A · B", nextCursor: "12@read" });
    expect(out.startsWith("# T\nURL: https://e.com\nsource: direct · robots: allowed · chars 0–")).toBe(true);
    expect(out).toContain("Untrusted page content");
    expect(out).toContain("Sections not shown: A · B");
    expect(out).toContain('Continue with cursor="12@read"');
  });
});
