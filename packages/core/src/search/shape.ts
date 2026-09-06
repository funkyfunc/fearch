/**
 * The lower rungs of reading a results page, for any engine, when the engine's own parser (rung 1:
 * the exact markup, joined to the page's embedded data) finds nothing it recognises.
 *
 * Rung 2 — by shape. Every engine draws a result the same way for the person reading it: a title
 * that is a link, a display URL ("github.com › vitest-dev › issues"), a snippet. None of that
 * depends on a class name, so this parser reads links whose text is a title, takes the card of
 * text around each one, and keeps the cards that look like results (a snippet, or a display URL).
 * It is looser than rung 1 and says so in the output.
 *
 * Rung 3 — the page. The results column converted to markdown with its links, for the agent to
 * read as it reads any page: never silent, never wrong, just more tokens.
 */

import * as cheerio from "cheerio";
import type { AnyNode, Element } from "domhandler";
import { applyBudget } from "../fetch/budget.js";
import { htmlToMarkdown } from "../fetch/extract.js";
import { applyLinkMode } from "../fetch/render.js";
import { dedupe, type SearchResult } from "./provider.js";

/** Hosts that belong to the engines themselves, never a result. */
const ENGINE_OWN_RE =
  /(^|\.)(google\.[a-z.]+|googleusercontent\.com|gstatic\.com|duckduckgo\.com|bing\.com|microsoft\.com|youtube\.com)$/;
const RESULTS_ROOTS = ["#rso", "#search", "#links", "main", "[role=main]", "body"];
const CHROME =
  "script, style, svg, noscript, nav, header, footer, [role=navigation], [role=banner], [role=contentinfo], form";
/** "github.com › vitest-dev › issues", "https://vitest.dev › guide", "vitest.dev/guide/mocking" */
const DISPLAY_URL_RE =
  /^(https?:\/\/)?[\w.-]+\.[a-z]{2,}(\s*›\s*[^›\n]+)*\/?$|^(https?:\/\/)?[\w.-]+\.[a-z]{2,}\/\S*$/i;
const NOT_A_TITLE_RE =
  /^(read more|more|show more|show all|learn more|\d+ answers?|\d+ comments?|images?|videos?|news|maps)$/i;
/** Result metadata drawn beside the snippet: a path crumb, a date, a count. */
const META_RUN_RE =
  /›|^\d+\+? (comments?|answers?|votes?)|\b(years?|months?|weeks?|days?|hours?) ago\b|^\w{3} \d{1,2}, \d{4}( —)?$/;
/** How much text a result card may hold; beyond this an ancestor is the column, not the card. */
const CARD_MAX_CHARS = 700;
const PAGE_MAX_CHARS = 8000;

const clean = (s: string) => s.replace(/\s+/g, " ").trim();

/** The real destination of a link, unwrapped from the engine's redirector; null for the engine's own pages. */
export function resultUrl(href: string | undefined, engineHost: string): string | null {
  if (!href) return null;
  try {
    let u = new URL(href, `https://${engineHost}`);
    for (const key of ["uddg", "q", "url", "u"]) {
      const v = u.searchParams.get(key);
      if (v && /^https?:\/\//.test(v) && (u.hostname === engineHost || ENGINE_OWN_RE.test(u.hostname))) {
        u = new URL(v);
        break;
      }
    }
    if (!/^https?:$/.test(u.protocol) || u.hostname === engineHost || ENGINE_OWN_RE.test(u.hostname)) return null;
    return u.toString();
  } catch {
    return null;
  }
}

function leafRuns($: cheerio.CheerioAPI, el: AnyNode): string[] {
  return $(el)
    .find("*")
    .toArray()
    .filter((e) => $(e).children().length === 0)
    .map((e) => clean($(e).text()))
    .filter(Boolean);
}

function titleOf($: cheerio.CheerioAPI, a: Element): string {
  const heading = $(a).find("h1, h2, h3, h4, [role=heading]").first();
  if (heading.length) return clean(heading.text());
  const runs = leafRuns($, a).filter((t) => !DISPLAY_URL_RE.test(t));
  return runs[0] ?? clean($(a).text());
}

/**
 * The block of text a result lives in: the largest ancestor that still reads as one card — bounded
 * in size, and holding no other result's link (a column of three cards is not a card).
 */
function cardOf($: cheerio.CheerioAPI, a: Element, root: Element, urlOf: Map<Element, string>): Element {
  let card: Element = a;
  let node: AnyNode | null = a.parent;
  const mine = urlOf.get(a);
  while (node && node !== root && node.type === "tag") {
    if (clean($(node).text()).length > CARD_MAX_CHARS) break;
    const others = ($(node).find("a[href]").toArray() as Element[]).some((x) => urlOf.has(x) && urlOf.get(x) !== mine);
    if (others) break;
    card = node as Element;
    node = node.parent;
  }
  return card;
}

export function parseByShape(html: string, engineHost: string, provider: string): SearchResult[] {
  const $ = cheerio.load(html);
  $(CHROME).remove();
  const root = (RESULTS_ROOTS.map((sel) => $(sel).first()).find((r) => r.length && r.find("a[href]").length) ??
    $("body"))[0] as Element;
  const out: SearchResult[] = [];
  const taken = new Set<Element>();
  // Every link that could be a result, first, so a card's bound knows where the next result begins.
  const urlOf = new Map<Element, string>();
  for (const a of $(root).find("a[href]").toArray() as Element[]) {
    const url = resultUrl($(a).attr("href"), engineHost);
    if (!url) continue;
    const title = titleOf($, a);
    if (title.length < 8 || NOT_A_TITLE_RE.test(title) || DISPLAY_URL_RE.test(title)) continue;
    urlOf.set(a, url);
  }
  for (const [a, url] of urlOf) {
    const title = titleOf($, a);
    const card = cardOf($, a, root, urlOf);
    if (taken.has(card)) continue;
    const runs = [...new Set(leafRuns($, card))]; // an engine prints its display URL twice (one hidden)
    const displayUrl = runs.some((t) => DISPLAY_URL_RE.test(t) || /›/.test(t));
    const snippet = runs
      .filter(
        (t) => t !== title && !title.startsWith(t) && !DISPLAY_URL_RE.test(t) && !META_RUN_RE.test(t) && t.length >= 25,
      )
      .join(" ")
      .slice(0, 300);
    if (!displayUrl && snippet.length < 30) continue; // a bare link in the chrome, not a result
    taken.add(card);
    out.push({ title: title.slice(0, 200), url, snippet, provider });
  }
  return dedupe(out);
}

/** The results column as markdown with its links, bounded; the agent reads it as it reads any page. */
export function resultsPageMarkdown(html: string): string {
  const $ = cheerio.load(html);
  $(CHROME).remove();
  const root = RESULTS_ROOTS.map((sel) => $(sel).first()).find((r) => r.length) ?? $("body");
  const md = htmlToMarkdown(`<html><body>${root.html() ?? ""}</body></html>`).markdown;
  const { body, footer } = applyLinkMode(md, true);
  const window = applyBudget(body, 0, PAGE_MAX_CHARS);
  return `${window.text.trim()}${window.truncated ? "\n\n[page cut at " + PAGE_MAX_CHARS + " chars]" : ""}${footer ? "\n\n" + footer : ""}`;
}
