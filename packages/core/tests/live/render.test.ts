/** Live rendering check: the audit's numbers on stable pages must not slide. FEARCH_LIVE=1 npm run test:live */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { settingsFromEnv } from "../../src/config.js";
import { createApp, type App } from "../../src/app.js";
import { DEFAULT_AUDIT_PAGES, measureRendering } from "../../src/fetch/audit.js";

const live = !!process.env.FEARCH_LIVE;
const d = live ? describe : describe.skip;

let app: App;

d("rendering retention", () => {
  beforeAll(() => {
    app = createApp(
      settingsFromEnv({ ...process.env, FEARCH_NO_CACHE: "1", FEARCH_AUDIT_LOG: "off", FEARCH_LOG_LEVEL: "error" }),
    );
  });
  afterAll(() => app?.close());

  for (const url of DEFAULT_AUDIT_PAGES) {
    it(`keeps the content of ${new URL(url).hostname}${new URL(url).pathname}`, async () => {
      const m = await measureRendering(app, url);
      if ("error" in m) {
        // A refusal or an outage is the site's answer, not a rendering regression; it is reported, not failed.
        console.warn(`${url}: ${m.error}`);
        return;
      }
      expect(m.paragraphs.pct, `paragraphs lost: ${m.paragraphs.lost.slice(0, 3).join(" | ")}`).toBeGreaterThanOrEqual(
        90,
      );
      expect(m.headings.pct).toBeGreaterThanOrEqual(80);
      expect(m.code.pct).toBe(100);
      expect(m.tables.pct).toBeGreaterThanOrEqual(50);
    }, 120_000);
  }
});
