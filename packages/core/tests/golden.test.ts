/**
 * Golden files: the converter's full output for every fixture page, snapshotted. The converter's
 * product *is* this markdown, so any change to extraction shows up here as a reviewable diff.
 * Update deliberately with `npx vitest run -u` after checking the diff is an improvement.
 */
import { readdirSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { htmlToMarkdown } from "../src/fetch/extract.js";

const FIXTURES = new URL("../../../tests/fixtures/html/", import.meta.url);

describe("golden conversions", () => {
  for (const file of readdirSync(FIXTURES)
    .filter((f) => f.endsWith(".html"))
    .sort()) {
    it(file, async () => {
      const { title, markdown, method } = htmlToMarkdown(readFileSync(new URL(file, FIXTURES), "utf8"));
      const golden = `title: ${title}\nmethod: ${method}\n---\n${markdown}`;
      await expect(golden).toMatchFileSnapshot(`__golden__/${file.replace(/\.html$/, ".md")}`);
    });
  }
});
