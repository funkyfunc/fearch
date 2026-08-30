/**
 * `fetch_top`: read the top results and attach the passages most relevant to the query, so one search
 * call can replace search-then-fetch. Excerpts are best-effort; a page that cannot be read is skipped.
 */

import type { App } from "../app.js";
import { applyBudget } from "../fetch/budget.js";
import { applyLinkMode } from "../fetch/render.js";
import { focusSections, joinSections, splitSections } from "../fetch/sections.js";
import type { SearchResult } from "./provider.js";

export async function excerptFor(app: App, url: string, query: string): Promise<string | undefined> {
  const budget = app.settings.excerptChars;
  try {
    const doc = await app.fetcher.fetch(url);
    const relevant = focusSections(splitSections(doc.markdown), query, budget);
    const { body } = applyLinkMode(joinSections(relevant), false);
    const window = applyBudget(body, 0, budget);
    const text = window.text.trim();
    if (!text) return undefined;
    return window.truncated ? `${text} …` : text;
  } catch (e) {
    app.audit.log("info", `excerpt skipped for ${url}: ${(e as Error).message}`);
    return undefined;
  }
}

/** Attach excerpts to the first `count` results, in parallel; `onDone` fires as each finishes. */
export async function attachExcerpts(
  app: App,
  results: SearchResult[],
  query: string,
  count: number,
  onDone: (done: number, result: SearchResult) => Promise<void> = async () => {},
): Promise<void> {
  const top = results.slice(0, count);
  let done = 0;
  await Promise.all(
    top.map(async (r) => {
      r.excerpt = await excerptFor(app, r.url, query);
      await onDone(++done, r);
    }),
  );
}
