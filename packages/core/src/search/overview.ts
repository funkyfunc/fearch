/**
 * Google's own generated answer on a results page — the "AI Overview" (also "AI Mode reply"), or the
 * opening summary of the newer "Web Guide" layout — read from the rendered page and returned as a
 * labelled block beside the results, never merged into them. It is that engine's model's claim, not
 * a fact, and the tool says so every time.
 *
 * The markup is volatile and A/B-tested, so nothing here depends on a class name. The anchors are
 * the two things Google keeps stable because people read them: the heading that names the block
 * ("AI Overview", "AI Mode reply for …", "Web Guide") and the disclaimer that ends it ("AI can make
 * mistakes…", "…AI generated and may include mistakes"). The block is the smallest element holding
 * both; the largest such block wins when the page carries a still-streaming placeholder beside a
 * finished one. Everything inside is converted with the same HTML→markdown converter as any page,
 * so lists and sub-headings survive, and the citation cards become the sources list.
 */

import * as cheerio from "cheerio";
import type { AnyNode, Element } from "domhandler";
import { applyBudget } from "../fetch/budget.js";
import { htmlSnippetToMarkdown } from "../fetch/extract.js";

export interface EngineSummary {
  /** What the block is called on the page: "AI Overview" or "Web Guide". */
  label: string;
  /** Markdown: paragraphs, lists and sub-headings as Google rendered them; capped, with a trailing … when cut. */
  text: string;
  sources: Array<{ title: string; url: string }>;
  provider: string;
}

const LABEL_RE = /^(AI Overview|AI Mode reply\b.*|Web Guide)$/;
/** What ends an AI Overview or Web Guide block: the disclaimer Google prints under it. */
const DISCLAIMER_RE = /AI can make mistakes|AI responses may include mistakes|AI generated and may include mistakes/;
/** What ends an AI Mode reply: it carries no disclaimer, but its feedback form follows it every time. */
const AI_MODE_END_RE =
  /^(Good response|Bad response)$|Share public link|A copy of this chat|Thanks for letting us know|Google may use account and system data/m;
const endOf = (label: string) => (/^AI Mode reply/.test(label) ? AI_MODE_END_RE : DISCLAIMER_RE);
const STREAMING_RE = /^(Thinking|Searching|Thinking a little longer|Generating)\b/;
/** Lines that are Google's chrome around the answer, not the answer. */
const CHROME_LINE_RE =
  /^(#+\s*)?(AI Overview|AI Mode (reply\b.*|replied:?)|Web Guide|Show (more|all|less)|Export|Copy|Copied|Edit|Share|Download|Submit|Got it|Learn more|Classic Search|More|Thinking|Searching|Thinking a little longer|Generating|Save to Google (Drive|Gmail)|When you export,.*|Feedback|Report a problem|Use code with caution\.?|Licensed by Google|Shared? \d+ files?|An AI Overview is not available.*|Can't generate.*|Deeply analyzed .*|Run expanded analysis|Help improve .*)\s*$/i;
const INLINE_TAGS = new Set(["span", "a", "b", "strong", "i", "em", "code", "u", "s", "sup", "sub"]);
/** A citation chip: "Marmicode Cookbook +1", "Facebook·The Mediterranean Dish", "connectpay.com". */
const CHIP_RE = /^\S.{0,80}\s\+\d+$/;
const isChipText = (t: string) =>
  CHIP_RE.test(t) || /^[a-z0-9-]+(\.[a-z0-9-]+)+$/i.test(t) || (/^\S[^\n]{0,60}·\S/.test(t) && t.length < 80);
/** A bare language name Google prints above a code block. */
const CODE_LABEL_RE =
  /^(typescript|javascript|python|js|ts|tsx|jsx|bash|shell|sh|json|html|css|go|java|rust|sql|yaml|yml|c|cpp|csharp|ruby|php|swift|kotlin|text|plaintext)$/i;
const MAX_CHARS = 3000;
const MIN_CHARS = 80;
const GOOGLE_HOST_RE = /(^|\.)(google\.[a-z.]+|googleusercontent\.com|gstatic\.com)$/;

function externalUrl(href: string | undefined): string | null {
  if (!href) return null;
  try {
    const u = new URL(href, "https://www.google.com");
    const target = u.pathname === "/url" ? (u.searchParams.get("q") ?? u.searchParams.get("url") ?? "") : u.toString();
    const t = new URL(target);
    if (!/^https?:$/.test(t.protocol) || GOOGLE_HOST_RE.test(t.hostname)) return null;
    return t.toString();
  } catch {
    return null;
  }
}

/**
 * The smallest ancestor of `el` whose text carries the block's end marker, or null when none does.
 * An "AI Mode reply" heading also sits inside a classic AI Overview, so the other marker is tried
 * when the label's own finds nothing.
 */
function blockAround($: cheerio.CheerioAPI, el: Element): Element | null {
  const own = endOf($(el).text().trim());
  for (const end of [own, own === DISCLAIMER_RE ? AI_MODE_END_RE : DISCLAIMER_RE]) {
    let node: AnyNode | null = el;
    while (node && node.type === "tag") {
      if (end.test($(node).text())) return node as Element;
      if ((node as Element).tagName === "body") break;
      node = node.parent;
    }
  }
  return null;
}

/** Is this page still writing its answer (a heading with a "Thinking…" placeholder, no finished block)? */
export function overviewPending(html: string): boolean {
  const $ = cheerio.load(html);
  const labels = labelElements($);
  if (!labels.length) return false;
  return !labels.some((el) => {
    const block = blockAround($, el);
    return block && visibleLength($(block).text()) > 200 && !STREAMING_RE.test(firstLine($(block).text()));
  });
}

function labelElements($: cheerio.CheerioAPI): Element[] {
  return $("[role=heading], h1, h2, h3, div, span")
    .filter((_, e) => {
      const t = $(e).text().trim();
      return $(e).children().length <= 3 && t.length < 160 && LABEL_RE.test(t);
    })
    .toArray() as Element[];
}

const visibleLength = (s: string) => s.replace(/\s+/g, " ").trim().length;
const firstLine = (s: string) => s.trim().split(/\n|\s{2,}/)[0] ?? "";

/**
 * Cut everything from `stop` onward inside `root`: the element itself and every following sibling
 * at each level up to the root (a Web Guide's intro ends where its first result card begins).
 */
function cutFrom($: cheerio.CheerioAPI, root: Element, stop: Element): void {
  let node: Element = stop;
  $(stop).nextAll().remove();
  $(stop).remove();
  while (node.parent && node.parent !== root) {
    node = node.parent as Element;
    $(node).nextAll().remove();
  }
}

/** A block is finished when it holds more than a placeholder and its first words are not "Thinking…". */
function finished($: cheerio.CheerioAPI, label: Element, block: Element): boolean {
  if (visibleLength($(block).text()) < 200) return false;
  // The text that follows the label inside the block: a streaming placeholder starts with "Thinking".
  const after = $(block)
    .text()
    .slice($(block).text().indexOf($(label).text().trim()) + $(label).text().trim().length)
    .trim();
  return !STREAMING_RE.test(after);
}

export function parseGoogleOverview(html: string, query = ""): Omit<EngineSummary, "provider"> | null {
  const $ = cheerio.load(html);
  // The smallest finished block: a page can carry a streaming placeholder beside the real answer,
  // and the placeholder's nearest disclaimer is the whole results column.
  let best: { block: Element; label: Element; name: string; size: number } | null = null;
  for (const el of labelElements($)) {
    const block = blockAround($, el);
    if (!block || !finished($, el, block)) continue;
    const size = visibleLength($(block).text());
    const name = /^Web Guide$/.test($(el).text().trim()) ? "Web Guide" : "AI Overview";
    if (!best || size < best.size) best = { block, label: el, name, size };
  }
  if (!best) return null;
  const labelText = $(best.label).text().trim();
  // What the block is: an "AI Mode reply" heading sits inside the AI Overview of a classic results
  // page, so it names an AI Mode only on a page that carries no "AI Overview" heading at all.
  const pageHasOverview = labelElements($).some((l) => $(l).text().trim() === "AI Overview");
  const name = /^AI Mode reply/.test(labelText) && !pageHasOverview ? "AI Mode" : best.name;
  const end = name === "AI Mode" ? AI_MODE_END_RE : DISCLAIMER_RE;
  const $r = cheerio.load("<div></div>");
  const root = $r("div").first();
  root.append($(best.block).clone());

  // Chrome, not answer: scripts, icons, dialogs, forms, buttons. A cited phrase is a clickable
  // span on the page, so [role=button] is unwrapped, not removed. Hidden elements go only when they
  // are the short fallback spans ("An AI Overview is not available…") — the collapsed half behind
  // "Show more" is hidden too, and it is the answer.
  root
    .find("script, style, svg, noscript, iframe, img, [role=dialog], [role=alertdialog], form, textarea, input")
    .remove();
  root.find("button, [role=button]").each((_, e) => {
    const t = $r(e).text().replace(/\s+/g, " ").trim();
    if (!t || CHROME_LINE_RE.test(t) || isChipText(t)) $r(e).remove();
    else if (t.length < 200)
      $r(e).replaceWith(t); // a cited phrase: inline text, whatever block it was drawn as
    else $r(e).replaceWith($r("<span></span>").append($r(e).contents())); // an expandable section: keep its shape
  });
  // Google-internal links (the label's own link, "search for more") carry nothing for the reader.
  root.find("a[href]").each((_, a) => {
    if (!externalUrl($r(a).attr("href"))) $r(a).replaceWith($r("<span></span>").append($r(a).contents()));
  });
  // A cited phrase sits in a <div> between the words of its sentence ("To get a <div>runny yolk</div>
  // with firm whites"): a block box drawn inline. Such a div — text beside it, no block inside — is
  // a span to the converter. Deepest first, so a wrapper of a wrapper is judged after its child.
  const blockInside = (d: Element) =>
    $r(d).find("div, p, ul, ol, li, table, pre, h1, h2, h3, h4, h5, h6, br").length > 0;
  const hasText = (n: AnyNode) =>
    (n.type === "text" && n.data.trim().length > 0) ||
    (n.type === "tag" && INLINE_TAGS.has(n.name) && $r(n).text().trim().length > 0);
  root
    .find("div")
    .toArray()
    .reverse()
    .forEach((d) => {
      if (!$r(d).text().trim() && !$r(d).find("img, table").length) return $r(d).remove(); // a spacer
      if (blockInside(d) || $r(d).text().length > 200) return;
      // Climb the single-child wrappers this box sits in; the outermost is what has neighbours.
      let outer: Element = d;
      while (
        outer.parent &&
        outer.parent !== root[0] &&
        (outer.parent as Element).tagName === "div" &&
        ((outer.parent as Element).children as AnyNode[]).filter((n) => n.type === "tag" || hasText(n)).length === 1
      )
        outer = outer.parent as Element;
      const siblings = (outer.parent?.children ?? []) as AnyNode[];
      if (!siblings.some((n) => n !== outer && hasText(n))) return;
      for (let x: Element = d; ; x = x.parent as Element) {
        x.tagName = "span";
        if (x === outer) break;
      }
    });

  // Web Guide: the summary is what comes after the label and before the first result card; the
  // cards are the results, read by the results parser.
  if (best.name === "Web Guide") {
    let pastLabel = false;
    let firstCard: Element | undefined;
    for (const e of root.find("*").toArray() as Element[]) {
      if (!pastLabel) {
        if ($r(e).children().length <= 1 && $r(e).text().trim() === labelText) pastLabel = true;
        continue;
      }
      if (e.tagName === "a" && externalUrl($r(e).attr("href")) && $r(e).find("h3, [role=heading]").length > 0) {
        firstCard = e;
        break;
      }
    }
    if (firstCard) cutFrom($r, root[0] as Element, firstCard);
  }

  // Sources: the citation cards (a list item around an external link) and inline citation icons.
  const sources: EngineSummary["sources"] = [];
  const seen = new Set<string>();
  const addSource = (url: string, title: string) => {
    if (seen.has(url)) return;
    seen.add(url);
    sources.push({ title: title || new URL(url).hostname, url });
  };
  // A citation card is a list item that is nothing but a link: the anchor wraps an icon (no text of
  // its own) and the item carries no emphasis or code. An answer bullet with an inline citation
  // keeps its place in the prose.
  root.find("li, [role=listitem]").each((_, li) => {
    const external = $r(li)
      .find("a[href]")
      .toArray()
      .filter((x) => externalUrl($r(x).attr("href")));
    const a = external[0];
    if (!a || external.length > 1 || $r(a).text().trim() || $r(li).find("strong, b, code, em").length) return;
    const url = externalUrl($r(a).attr("href"))!;
    // A card reads: source name, title, "date — snippet" — each its own element. The title is the
    // heading when the card has one, else the longer of the first two text runs.
    const heading = $r(li).find("h3, [role=heading]").first().text().replace(/\s+/g, " ").trim();
    const runs = $r(li)
      .find("*")
      .toArray()
      .filter((e) => $r(e).children().length === 0)
      .map((e) => $r(e).text().replace(/\s+/g, " ").trim())
      .filter((t) => t.length >= 3);
    const short = runs.filter((r) => r.length <= 90 && !/•/.test(r));
    const title = heading || [...short.slice(0, 2)].sort((x, y) => y.length - x.length)[0] || "";
    addSource(url, title.slice(0, 120));
    $r(li).remove();
  });
  root.find("a[href]").each((_, a) => {
    const url = externalUrl($r(a).attr("href"));
    if (!url) return;
    const text = $r(a).text().replace(/\s+/g, " ").trim();
    // An icon link inside a citation chip ("EBSCO +2") is named by the chip.
    const chip = text
      ? ""
      : $r(a)
          .parent()
          .text()
          .replace(/\s+/g, " ")
          .replace(/\s*\+\d+$/, "")
          .trim();
    addSource(url, (text || chip).slice(0, 120));
    if (!text) $r(a).remove(); // an inline citation icon leaves no text behind
  });

  // Headings the page marks with ARIA become markdown headings.
  root.find("[role=heading]").each((_, h) => {
    const level = Math.min(6, Math.max(3, Number($r(h).attr("aria-level") ?? 3)));
    (h as Element).tagName = `h${level}`;
  });

  const lines = htmlSnippetToMarkdown(root.html() ?? "").split("\n");
  const kept: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].replace(/[\u00a0\u200b]/g, " ").replace(/\s+$/, "");
    if (end.test(line)) break; // the answer ends where the disclaimer (or the feedback form) begins
    if (CHROME_LINE_RE.test(line.trim()) || CHIP_RE.test(line.trim())) continue;
    if (query && new RegExp(`^(#+\\s*)?AI Mode reply for ${escapeRe(query)}\\s*$`, "i").test(line.trim())) continue;
    if (CODE_LABEL_RE.test(line.trim()) && /^\s*```/.test(lines.slice(i + 1).find((l) => l.trim()) ?? "")) continue;
    if (/^#+\s*$/.test(line)) continue; // a heading whose text was chrome
    kept.push(line);
  }
  // Source chips beside sentences ("connectpay.com", "Facebook·The Mediterranean Dish") are labels
  // for the sources list, not prose.
  const chipWords = new Set(
    sources.flatMap((s) => [s.title.toLowerCase(), new URL(s.url).hostname.replace(/^www\./, "")]),
  );
  const isChip = (line: string) => {
    const t = line.trim();
    return !!t && (chipWords.has(t.toLowerCase()) || isChipText(t));
  };
  const text = kept
    .filter((l) => !isChip(l))
    .join("\n")
    .replace(/\[\]\([^)]*\)/g, "") // link syntax left by a removed icon
    .replace(/\n\s*([.,;:!?])(?=\s|$)/g, "$1") // punctuation orphaned by a removed chip
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  if (text.length < MIN_CHARS || STREAMING_RE.test(text)) return null;
  const window = applyBudget(text, 0, MAX_CHARS);
  return {
    label: name,
    text: window.truncated ? `${window.text.trim()} …` : window.text.trim(),
    sources: sources.slice(0, 10),
  };
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
