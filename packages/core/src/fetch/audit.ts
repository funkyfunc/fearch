/**
 * Rendering audit: what a page's main content holds versus what fearch's markdown keeps. Used by
 * `npm run audit:render` (a table per page) and the live suite (thresholds on stable pages).
 *
 * The comparison is on what the agent sees — links stripped — and is markup-insensitive: a
 * paragraph counts as kept when its first forty letters and digits appear in the markdown's.
 */

import * as cheerio from "cheerio";
import type { AnyNode } from "domhandler";
import type { App } from "../app.js";
import { applyLinkMode } from "./render.js";

export interface Retention {
  kept: number;
  total: number;
  pct: number;
}

export interface RenderingMeasure {
  url: string;
  title: string;
  source: string;
  paragraphs: Retention & { lost: string[] };
  headings: Retention;
  code: Retention;
  tables: Retention;
  images: Retention;
  /** Markdown text as a share of the main container's visible text (over 100 % when the page is mostly links). */
  textPct: number;
}

/** Pages that render over plain HTTP, permit fetching, and have stayed stable: docs, reference, government, health. */
export const DEFAULT_AUDIT_PAGES = [
  "https://docs.python.org/3/library/asyncio-task.html",
  "https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Array/flatMap",
  "https://en.wikipedia.org/wiki/Rayleigh_scattering",
  "https://arxiv.org/html/2401.04088v1",
  "https://docs.astral.sh/uv/concepts/projects/dependencies/",
  "https://www.gov.uk/vehicle-tax-rate-tables",
  "https://www.nhs.uk/conditions/migraine/",
  "https://kubernetes.io/docs/concepts/workloads/pods/",
];

const norm = (s: string) => s.replace(/\s+/g, " ").trim();
const key = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "");
const ratio = (kept: number, total: number): Retention => ({
  kept,
  total,
  pct: total ? Math.round((100 * kept) / total) : 100,
});

export async function measureRendering(
  app: App,
  url: string,
): Promise<RenderingMeasure | { url: string; error: string }> {
  try {
    const raw = await app.fetcher.fetch(url, { raw: true });
    const doc = await app.fetcher.fetch(url);
    const md = applyLinkMode(doc.markdown, false).body;
    const mdKey = key(md);
    const $ = cheerio.load(raw.markdown);
    $(
      "script, style, noscript, nav, footer, header, aside, [role=navigation], [role=banner], [role=contentinfo], form",
    ).remove();
    // A formula's text is inherently different in markdown (TeX, once); a block that is all links is
    // a navigation rail the converter drops on purpose. Neither is a paragraph to keep.
    $("math, .mwe-math-element").remove();
    const main = $("main, article, [role=main], #content, #main").first();
    const root = main.length && norm(main.text()).length > 500 ? main : $("body");
    const linkShare = (e: AnyNode) => {
      const all = norm($(e).text()).length;
      const linked = $(e)
        .find("a")
        .toArray()
        .reduce((n, a) => n + norm($(a).text()).length, 0);
      return all ? linked / all : 0;
    };
    const paras = root
      .find("p, li, dd, dt, td, blockquote, figcaption")
      .toArray()
      .filter((e) => linkShare(e) < 0.8)
      .map((e) => norm($(e).text()))
      .filter((t) => t.length >= 40);
    const lost = paras.filter((t) => !mdKey.includes(key(t).slice(0, 40)));
    const heads = root
      .find("h1, h2, h3, h4")
      .toArray()
      .map((e) => norm($(e).text()))
      .filter(Boolean);
    const headsKept = heads.filter((t) => mdKey.includes(key(t).slice(0, 30))).length;
    const pre = root.find("pre").length;
    const fences = Math.floor((md.match(/^\s*```/gm) ?? []).length / 2);
    // A table is kept when its first cells' text survived — as a markdown table when it had a header
    // row, as text when the converter unwrapped a layout table.
    // A table of links (a specifications table, a navigation grid) is a rail the converter drops on purpose.
    const tables = root
      .find("table")
      .toArray()
      .filter((t) => linkShare(t) < 0.8);
    const tablesKept = tables.filter((t) => {
      const cells = $(t)
        .find("th, td")
        .toArray()
        .map((c) => key($(c).text()))
        .filter((k) => k.length >= 6)
        .slice(0, 2);
      return cells.length > 0 && cells.every((k) => mdKey.includes(k.slice(0, 30)));
    }).length;
    const imgs = root
      .find("img[alt]")
      .toArray()
      .filter((e) => norm($(e).attr("alt") ?? "").length >= 8 && !$(e).closest("a").length).length;
    const mdImgs = (md.match(/\[image: /g) ?? []).length;
    return {
      url,
      title: doc.title,
      source: doc.source,
      paragraphs: { ...ratio(paras.length - lost.length, paras.length), lost },
      headings: ratio(headsKept, heads.length),
      code: ratio(Math.min(fences, pre), pre),
      tables: ratio(tablesKept, tables.length),
      images: ratio(Math.min(mdImgs, imgs), imgs),
      textPct: Math.round((100 * norm(md).length) / Math.max(1, norm(root.text()).length)),
    };
  } catch (e) {
    return { url, error: (e as Error).message.split("\n")[0].slice(0, 200) };
  }
}
