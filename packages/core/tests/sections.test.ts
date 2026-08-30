import { describe, expect, it } from "vitest";
import {
  cleanTitle,
  findSection,
  focusSections,
  joinSections,
  renderOutline,
  splitSections,
} from "../src/fetch/sections.js";

const DOC = `Preamble text about the library.

# Guide

Intro to the guide.

## Installation

pip install thing

\`\`\`bash
# this is a comment, not a heading
## neither is this
\`\`\`

## Configuration

Set retries and timeouts in the config file.

### Retries

client = Client(retries=3)

### Timeouts

Timeouts are separate from retries.

## Deployment

Deploy with docker.
`;

describe("sections", () => {
  it("splits fence-aware with exact offsets", () => {
    const secs = splitSections(DOC);
    expect(secs.map((s) => s.title)).toEqual([
      "(intro)",
      "Guide",
      "Installation",
      "Configuration",
      "Retries",
      "Timeouts",
      "Deployment",
    ]);
    expect(secs.map((s) => s.level)).toEqual([0, 1, 2, 2, 3, 3, 2]);
    for (const s of secs)
      expect(DOC.slice(s.start, s.end).replace(/^\n+|\n+$/g, "")).toBe(s.text.replace(/^\n+|\n+$/g, ""));
  });

  it("finds sections fuzzily and returns subtrees", () => {
    const secs = splitSections(DOC);
    expect(findSection(secs, "configuration")!.map((s) => s.title)).toEqual(["Configuration", "Retries", "Timeouts"]);
    expect(findSection(secs, "Deploy")!.map((s) => s.title)).toEqual(["Deployment"]);
    expect(findSection(secs, "instalation")!.map((s) => s.title)).toEqual(["Installation"]);
    expect(findSection(secs, "nonexistent zzz")).toBeNull();
  });

  it("focus ranks relevant sections in document order, ignores stop-words, keeps the lead", () => {
    const secs = splitSections(DOC);
    const chosen = focusSections(secs, "how do I set retries", 200);
    const titles = chosen.map((s) => s.title);
    expect(titles).toContain("Retries");
    expect(titles).not.toContain("Deployment");
    expect(chosen.map((s) => s.index)).toEqual([...chosen.map((s) => s.index)].sort((a, b) => a - b));

    const lead =
      "Lead paragraph explaining what the Widget protocol is: an open standard, written by Acme, that lets tools talk to each other. This sentence exists to make the lead long enough to count as substantive text for the lead-section rule to apply here.\n\n# Widget\n\n## References\n\nWidget protocol Widget protocol Widget protocol Widget protocol Widget protocol.\n\n## Usage\n\nCall widget().\n";
    const s2 = splitSections(lead);
    const picked = focusSections(s2, "What is the Widget protocol?", 2000).map((s) => s.title);
    expect(picked[0]).toBe("(intro)");
    expect(picked).not.toContain("References");

    // dotted identifiers match their parts
    const dotted =
      "# API\n\n## Timeouts\n\nUse asyncio.timeout(10) to bound a wait.\n\n## Sleeping\n\nasyncio.sleep(1) pauses.\n";
    const s3 = splitSections(dotted);
    expect(focusSections(s3, "set a timeout", 120).map((s) => s.title)).toEqual(["Timeouts"]);
  });

  it("renders outline and joins", () => {
    const secs = splitSections(DOC);
    const shown = new Set(secs.filter((s) => s.title === "Retries").map((s) => s.index));
    const out = renderOutline(secs, shown);
    expect(out.startsWith("Sections not shown: ")).toBe(true);
    expect(out).not.toContain("Retries");
    expect(out).toContain("Deployment");
    expect(joinSections(secs.slice(0, 2)).startsWith("Preamble")).toBe(true);
  });

  it("cleans titles", () => {
    expect(cleanTitle("[Running tasks](#id8)")).toBe("Running tasks");
    expect(cleanTitle("**Bold** `code` ¶")).toBe("Bold code");
  });
});
