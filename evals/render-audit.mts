/**
 * Rendering audit (live network): what a page's main content holds versus what fearch's markdown
 * keeps, per page — paragraphs, headings, code blocks, data tables, image alt text — with the
 * paragraphs that went missing, so a loss is a line to read, not a feeling.
 *
 *   npm run audit:render                       # the default set below
 *   npm run audit:render -- https://a https://b
 *
 * The same measurement gates the live suite (packages/core/tests/live/render.test.ts).
 */
import { createApp } from "../packages/core/src/app.ts";
import { measureRendering, DEFAULT_AUDIT_PAGES } from "../packages/core/src/fetch/audit.ts";

const urls = process.argv.slice(2).length ? process.argv.slice(2) : DEFAULT_AUDIT_PAGES;
const app = createApp();
try {
  for (const url of urls) {
    const m = await measureRendering(app, url);
    console.log(`\n== ${url}`);
    if ("error" in m) {
      console.log(`   ${m.error}`);
      continue;
    }
    console.log(`   ${m.source} · ${m.title.slice(0, 70)}`);
    console.log(
      `   paragraphs ${m.paragraphs.kept}/${m.paragraphs.total} (${m.paragraphs.pct}%) · headings ${m.headings.kept}/${m.headings.total} · code ${m.code.kept}/${m.code.total} · tables ${m.tables.kept}/${m.tables.total} · images ${m.images.kept}/${m.images.total} · text ${m.textPct}% of the container`,
    );
    for (const t of m.paragraphs.lost.slice(0, 5)) console.log(`   lost: ${t.slice(0, 110)}`);
  }
} finally {
  await app.close();
}
