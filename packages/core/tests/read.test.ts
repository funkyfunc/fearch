import { describe, expect, it } from "vitest";
import type { PageDoc } from "../src/fetch/pipeline.js";
import { readDocument } from "../src/fetch/read.js";

const doc = (markdown: string, source = "fake"): PageDoc => ({
  url: "https://x.test/p",
  finalUrl: "https://x.test/p",
  title: "T",
  source,
  markdown,
  note: "",
  robots: "allowed",
  licence: [],
  cached: false,
});

describe("read", () => {
  it("computes the outline on the same text it windows, so a section on screen is never 'not shown'", () => {
    // Every stripped link shortens the body; sections must be split after stripping.
    const link = (i: number) => `[ref ${i}](https://example.org/a/very/long/path/that/moves/offsets/${i})`;
    const md =
      `# T\n\nIntro ${Array.from({ length: 30 }, (_, i) => link(i)).join(" ")}\n\n` +
      `## Alpha\n\nalpha text ${link(100)}.\n\n## Beta\n\nbeta text.\n\n## Gamma\n\n${"gamma text. ".repeat(80)}\n\n## Delta\n\ndelta text.\n`;
    const out = readDocument(doc(md), { mode: "read", maxChars: 700, includeLinks: false });
    expect(out).toContain("## Alpha");
    expect(out).toContain("## Beta");
    const outline = /Sections not shown: (.*)/.exec(out)![1];
    expect(outline).not.toContain("Alpha");
    expect(outline).not.toContain("Beta");
    expect(outline).toContain("Delta");
  });

  it("keeps the links of an llms.txt index whatever include_links says", () => {
    const md = "# Site\n\n- [Guide](https://x.test/guide): the guide\n- [API](https://x.test/api): the API\n";
    const out = readDocument(doc(md, "llms.txt"), { mode: "read", maxChars: 2000, includeLinks: false });
    expect(out).toContain("[Guide][1]");
    expect(out).toContain("[1]: https://x.test/guide");
    const plain = readDocument(doc(md, "direct (markdown)"), { mode: "read", maxChars: 2000, includeLinks: false });
    expect(plain).not.toContain("https://x.test/guide");
  });
});
