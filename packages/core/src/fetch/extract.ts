/**
 * HTML → markdown extraction tuned for technical documentation.
 *
 * Strategy: locate the main-content container and convert it with a *pure* converter (turndown +
 * GFM), which never drops code blocks; fall back to Readability only when no container is found;
 * guard every candidate by counting <pre> blocks in vs. fenced blocks out. Heuristic extractors
 * (Readability, trafilatura) score their text by density and routinely drop or hollow out code.
 */

import { Readability } from "@mozilla/readability";
import * as cheerio from "cheerio";
import type { Cheerio, CheerioAPI } from "cheerio";
import type { AnyNode, Element as DomElement } from "domhandler";
import { parseHTML } from "linkedom";
import TurndownService from "turndown";
// turndown-plugin-gfm ships no types
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore
import { gfm } from "turndown-plugin-gfm";

export interface Extracted {
  title: string;
  markdown: string;
  method: "main" | "readability" | "body" | "pdf";
}

const MAIN_SELECTORS = [
  "main",
  "[role=main]",
  "article",
  "#main-content",
  "#content-main",
  "#main",
  "#content",
  "#docs-content",
  ".markdown-body",
  ".theme-doc-markdown",
  ".rst-content",
  ".md-content",
  ".docs-content",
  ".doc-content",
  ".document",
  ".post-content",
  ".entry-content",
  ".article-body",
  ".article-content",
  ".main-content",
  ".content",
  ".prose",
];

const REMOVE_SELECTORS =
  "script, style, noscript, iframe, svg, canvas, template, nav, footer, aside, form, button, input, select, " +
  "textarea, [role=navigation], [role=banner], [role=contentinfo], [role=complementary], [role=search], " +
  "[role=dialog], [role=alertdialog], [aria-hidden=true], .sr-only, .visually-hidden, " +
  // LaTeXML (arXiv HTML) chrome and error markers
  ".ltx_page_header, .ltx_page_footer, .ltx_ERROR, .ltx_missing, .ltx_page_navbar, " +
  // third-party comment widgets (the discussion itself, e.g. on HN or forums, is content and is kept)
  "#disqus_thread, .disqus, #comments-form, .comment-form, .comment-respond, " +
  // MediaWiki chrome: navboxes, edit links, category links, hatnotes
  ".navbox, .vertical-navbox, .navbox-styles, .mw-editsection, .catlinks, .hatnote, .mw-jump-link, .noprint";

const NOISE_CLASS_RE =
  /(^|[\s_-])(cookie|consent|gdpr|sidebar|side-nav|sidenav|breadcrumbs?|share|social|advert|ads?|promo|newsletter|popup|modal|subscribe|related|recommended|footer|navbar|topbar|menu|skip-link|skip-to|toc|table-of-contents|pagination|pager|announcement|banner|edit-this-page|feedback|on-this-page|page-nav|prev-next|theme-doc-toc|docs-toc)([\s_-]|$)/i;

const BLOCK_TAGS = "div, section, ul, ol, li, table, p, dl, details, figure, span";
/** Blocks that can be pure link farms (language pickers, tag clouds, "related" rails) even inside <main>. */
const LINK_FARM_TAGS = "ul, ol, table, nav, section, div";
const LINK_FARM_MIN_CHARS = 60;
const LINK_FARM_DENSITY = 0.85;
/** A content container must hold this share of the page's (de-noised) text, or it isn't the content. */
const MIN_CONTENT_SHARE = 0.5;
const HEADING_TAGS = "h1, h2, h3, h4, h5, h6";
const PERMALINK_TEXT = new Set(["¶", "#", "🔗", "", "Permalink", "permalink", "Link to this heading", "Anchor"]);

const JSX_LINE_RE = /^\s*<\/?[A-Z][A-Za-z0-9]*(?:\s[^>]*)?\/?>\s*$/;
const FENCE_INFO_RE = /^([ \t]*(?:`{3,}|~{3,}))[ \t]*([\w+#.-]*)[^\n]*$/gm;
const HEADING_PILCROW_RE = /^(#{1,6} .*?)\s*(?:¶|#)\s*$/gm;
const EMPTY_ANCHOR_RE = /<a\s+(?:name|id)="[^"]*"\s*>\s*<\/a>/gi;
const FRONTMATTER_RE = /^---[ \t]*\n([\s\S]*?)\n---[ \t]*\n/;
const MDX_COMMENT_RE = /\s*\{\/\*[\s\S]*?\*\/\}/g;
const ZERO_WIDTH_RE = /\u200b|\u200c|\u200d|\u2060|\ufeff/g;
const SKIP_LINE_RE = /^\s*(\[?Skip to (main )?content(\]\([^)]*\))?|\[?Skip to main(\]\([^)]*\))?|\s*)$/i;
const SHELL_PATTERNS =
  /(You need to enable JavaScript to run this app|This site requires JavaScript|Please (enable|ensure) JavaScript|JavaScript is (disabled|required)|enable JavaScript (to|and)|^\s*Loading(\.\.\.|…)?\s*$)/im;
/** Below this much visible text, a page whose bytes are mostly script is a client-rendered shell. */
const SHELL_MAX_TEXT = 600;
const SHELL_SCRIPT_SHARE = 0.5;
/** Interactive chrome that must be *unwrapped*, not removed, when it sits inside code (Twoslash hovers, copy buttons). */
const CODE_CONTAINERS = "pre, code";

// --- turndown ------------------------------------------------------------------

function codeLanguage(pre: Element): string {
  const candidates: Element[] = [pre];
  const code = pre.querySelector("code");
  if (code) candidates.push(code);
  for (const node of candidates) {
    for (const cls of (node.getAttribute("class") ?? "").split(/\s+/)) {
      const m = /^(?:language|lang|highlight|brush:)[-_ ]?([\w+#.-]+)$/i.exec(cls);
      if (m) return m[1].toLowerCase();
    }
    const dl = node.getAttribute("data-lang") ?? node.getAttribute("data-language");
    if (dl) return dl.toLowerCase();
  }
  return "";
}

let _td: TurndownService | undefined;
function turndown(): TurndownService {
  if (_td) return _td;
  const td = new TurndownService({
    headingStyle: "atx",
    bulletListMarker: "-",
    codeBlockStyle: "fenced",
    fence: "```",
    emDelimiter: "*",
    strongDelimiter: "**",
    hr: "---",
  });
  td.use(gfm);
  // Do not escape markdown punctuation in prose — LLM readers don't need it and it adds noise.
  td.escape = (s: string) => s;
  const dropTags = new Set([
    "script",
    "style",
    "noscript",
    "iframe",
    "svg",
    "canvas",
    "template",
    "video",
    "audio",
    "source",
    "picture",
  ]);
  td.remove((node) => dropTags.has(node.nodeName.toLowerCase()));
  td.addRule("images", { filter: "img", replacement: () => "" });
  td.addRule("pre", {
    filter: "pre",
    replacement: (_content, node) => {
      const el = node as unknown as Element;
      const code = (el.textContent ?? "").replace(/\n+$/, "");
      if (!code.trim()) return "";
      let fence = "```";
      while (code.includes(fence)) fence += "`";
      return `\n\n${fence}${codeLanguage(el)}\n${code}\n${fence}\n\n`;
    },
  });
  _td = td;
  return td;
}

// --- helpers --------------------------------------------------------------------

export function visibleText($el: Cheerio<AnyNode>): string {
  return $el.text().replace(/\s+/g, " ").trim();
}

/**
 * True when the HTML is an empty client-rendered shell or a JS-required stub. Three signals, any of
 * which decides: a "turn on JavaScript" / "Loading…" stub with little text; an empty client-side mount
 * point (React/Vue/Next/Nuxt/Angular); or a page whose bytes are mostly script and whose visible text
 * is a few lines (diagrams.net-style shells that say nothing recognisable). A short static page with
 * no scripts (example.com) is just a short page.
 */
export function detectShell(html: string): boolean {
  const $ = cheerio.load(html);
  const scripts = $("script[src], script:not([type])").length;
  let scriptBytes = 0;
  $("script").each((_, e) => {
    scriptBytes += ($(e).html() ?? "").length + ($(e).attr("src") ?? "").length;
  });
  const emptyMount =
    $("#app, #root, #__next, #__nuxt, #___gatsby, [data-reactroot], [ng-version], app-root").filter(
      (_, e) => !$(e).text().trim(),
    ).length > 0;
  $("script, style, noscript").remove();
  const text = visibleText($("body").length ? $("body") : $.root());
  if (SHELL_PATTERNS.test(text.slice(0, 3000)) && text.length < 1500) return true;
  if (text.length < 50) return scripts > 0;
  if (text.length < 200) return scripts > 0 && emptyMount;
  if (text.length < SHELL_MAX_TEXT && scripts > 0 && html.length > 0 && scriptBytes / html.length > SHELL_SCRIPT_SHARE)
    return true;
  return false;
}

function pageTitle($: CheerioAPI): string {
  const og = $('meta[property="og:title"]').attr("content");
  if (og?.trim()) return og.trim();
  const t = $("title").first().text().trim();
  if (t) return t;
  return $("h1").first().text().replace(/\s+/g, " ").trim();
}

/** The page's title from raw HTML (for raw-mode headers). */
export function htmlTitle(html: string): string {
  try {
    return pageTitle(cheerio.load(html.slice(0, 200_000)));
  } catch {
    return "";
  }
}

function stripBoilerplate($: CheerioAPI, $root: Cheerio<AnyNode>): void {
  // Nothing inside a code block is boilerplate: Twoslash wraps identifiers in <button>, copy buttons
  // and line anchors sit inside <pre>. Removing them would hollow the code out while leaving the
  // fence in place (the fence-count guard cannot see that). Inside code, only the tag goes.
  const inCode = (el: AnyNode) => $(el).parents(CODE_CONTAINERS).length > 0;
  $root.find(REMOVE_SELECTORS).each((_, el) => {
    if (inCode(el)) $(el).replaceWith($(el).contents());
    else $(el).remove();
  });
  // headers: keep article headers (title), drop site headers (nav-like)
  $root.find("header").each((_, el) => {
    const $h = $(el);
    if ($h.find("nav").length || $h.find("a").length >= 3) $h.remove();
  });
  // Class/id-based noise removal applies to block containers only — never inside a heading
  // (Sphinx wraps heading text in <a class="toc-backref">) and never inside code.
  $root.find(BLOCK_TAGS).each((_, el) => {
    const $el = $(el);
    if ($el.closest(HEADING_TAGS).length || inCode(el)) return;
    const ident = `${$el.attr("class") ?? ""} ${$el.attr("id") ?? ""}`.trim();
    if (ident && NOISE_CLASS_RE.test(ident)) $el.remove();
  });
  removeLinkFarms($, $root);
  // Permalink anchors (¶, #, "Link to this heading") add nothing but noise.
  $root.find("a").each((_, el) => {
    const $a = $(el);
    if (PERMALINK_TEXT.has($a.text().trim()) && !$a.find("img").length && !inCode(el)) $a.remove();
  });
  // Links inside headings become plain heading text.
  $root
    .find(HEADING_TAGS)
    .find("a")
    .each((_, el) => {
      const $a = $(el);
      $a.replaceWith($a.contents());
    });
  // Tables the GFM plugin will not convert — it only handles a table whose *first row* is a header
  // row — would pass through Turndown as raw HTML: Hacker News layout tables, old forums, and
  // Wikipedia infoboxes (row headers in <th scope="row">, image in the first row). Unwrap those
  // into block elements so their text converts normally; data tables are left to GFM.
  $root.find("table").each((_, el) => {
    if (isDataTable($, el)) return;
    // Only this table's own rows and cells: a data table nested inside a layout table keeps its shape.
    const own = $(el)
      .find("tr, td, th, tbody, thead, tfoot, caption")
      .toArray()
      .filter((n) => $(n).closest("table")[0] === el);
    for (const node of [el, ...own]) (node as DomElement).tagName = "div";
  });
}

/** A table turndown-plugin-gfm will convert: a <thead>, or a first row made only of <th> cells. */
function isDataTable($: CheerioAPI, table: AnyNode): boolean {
  const $t = $(table);
  if ($t.children("thead").length) return true;
  const firstRow = $t
    .find("tr")
    .toArray()
    .find((tr) => $(tr).closest("table")[0] === table);
  if (!firstRow) return false;
  const cells = $(firstRow).children("td, th").toArray();
  return cells.length > 0 && cells.every((c) => (c as DomElement).tagName === "th");
}

/**
 * Detach blocks that are almost entirely link text: navigation rails, "related articles" boxes,
 * language pickers. Prose never approaches this density, so only navigation-shaped noise goes.
 * Sizes are computed once per node (children before parents) rather than per candidate.
 */
function removeLinkFarms($: CheerioAPI, $root: Cheerio<AnyNode>): void {
  const sizes = new Map<AnyNode, { text: number; link: number }>();
  const measure = (node: AnyNode): { text: number; link: number } => {
    const known = sizes.get(node);
    if (known) return known;
    let text = 0;
    let link = 0;
    if (node.type === "text") {
      text = node.data.replace(/\s+/g, "").length;
    } else if (node.type === "tag") {
      for (const child of node.children) {
        const c = measure(child);
        text += c.text;
        link += c.link;
      }
      if (node.name === "a") link = text;
    }
    const size = { text, link };
    sizes.set(node, size);
    return size;
  };
  const farms = $root
    .find(LINK_FARM_TAGS)
    .toArray()
    .filter((el) => {
      const { text, link } = measure(el);
      return text >= LINK_FARM_MIN_CHARS && link >= text * LINK_FARM_DENSITY;
    });
  // Outermost farms only: a farm inside a farm is gone with its parent.
  for (const el of farms) if (!farms.some((other) => other !== el && $(other).find(el).length)) $(el).remove();
}

function findMain($: CheerioAPI): Cheerio<AnyNode> | null {
  let best: Cheerio<AnyNode> | null = null;
  let bestLen = 0;
  for (const sel of MAIN_SELECTORS) {
    $(sel).each((_, el) => {
      const $el = $(el);
      const n = visibleText($el).length;
      if (n < 200) return;
      if (!best || (n > bestLen && sel === "article")) {
        best = $el;
        bestLen = n;
      }
    });
    if (best) return best;
  }
  return null;
}

/**
 * Normalize markdown from any source: fence info strings reduced to the language token
 * (Mintlify emits ```python theme={...}), MDX/JSX-only lines dropped, heading pilcrows removed,
 * zero-width chars and leading "Skip to content" removed, whitespace collapsed.
 */
export function cleanMarkdownSource(md: string): string {
  let s = md.replace(/\r\n/g, "\n").replace(ZERO_WIDTH_RE, "");
  s = s.replace(FENCE_INFO_RE, (_m, fence: string, lang: string) => `${fence}${lang}`);
  s = s.replace(EMPTY_ANCHOR_RE, "").replace(MDX_COMMENT_RE, "");
  const lines = s.split("\n").filter((l) => !JSX_LINE_RE.test(l));
  while (lines.length && SKIP_LINE_RE.test(lines[0])) lines.shift();
  s = lines.join("\n");
  s = s.replace(HEADING_PILCROW_RE, "$1");
  s = s.replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n");
  return s.trim() + "\n";
}

/** Strip a leading YAML frontmatter block; return ({key: value}, body). */
export function splitFrontmatter(md: string): { meta: Record<string, string>; body: string } {
  const m = FRONTMATTER_RE.exec(md);
  if (!m) return { meta: {}, body: md };
  const meta: Record<string, string> = {};
  for (const line of m[1].split("\n")) {
    if (line.includes(":") && !/^[\s-]/.test(line)) {
      const [k, ...rest] = line.split(":");
      meta[k.trim().toLowerCase()] = rest
        .join(":")
        .trim()
        .replace(/^["']|["']$/g, "");
    }
  }
  return { meta, body: md.slice(m[0].length) };
}

function fenceCount(md: string): number {
  return Math.floor((md.match(/^\s*(`{3,}|~{3,})/gm) ?? []).length / 2);
}

/** Convert a fragment (e.g. an API-returned HTML body) to markdown. */
export function htmlSnippetToMarkdown(html: string): string {
  return cleanMarkdownSource(turndown().turndown(html));
}

// --- main entry -----------------------------------------------------------------

/**
 * Content is never dropped by mistake: a container that holds less than half of the page's
 * de-noised text is a sidebar or a summary, not the article — fall through to the other methods.
 * The page's de-noised length is computed once per page (it means a second full parse).
 */
function deNoisedPageLength(html: string): number {
  const $page = cheerio.load(html);
  const body = $page("body").length ? $page("body") : $page.root();
  stripBoilerplate($page, body);
  return visibleText(body).length;
}

export function htmlToMarkdown(html: string): Extracted {
  const $ = cheerio.load(html);
  const title = pageTitle($);
  const preTotal = $("pre").length;
  // Data tables must survive too. Counted on the *cleaned* candidate, so navboxes and other chrome
  // removed as boilerplate don't count, and with the same definition the converter uses.
  const dataTables = ($x: CheerioAPI, root: Cheerio<AnyNode>) =>
    root
      .find("table")
      .toArray()
      .filter((t) => isDataTable($x, t)).length;
  const tableCount = (md: string) => (md.match(/^\s*\|?\s*:?-{3,}/gm) ?? []).length;
  const guardOk = (md: string, tableTotal: number) =>
    md.trim().length >= 200 &&
    !(preTotal && fenceCount(md) < Math.ceil(0.8 * preTotal)) &&
    // Complex tables (rowspan/colspan, vertical headers) don't always convert; require half.
    !(tableTotal && tableCount(md) < Math.ceil(0.5 * tableTotal));

  const main = findMain($);
  if (main) {
    stripBoilerplate($, main);
    const md = cleanMarkdownSource(turndown().turndown($.html(main)));
    if (guardOk(md, dataTables($, main))) {
      const pageText = deNoisedPageLength(html);
      if (pageText === 0 || visibleText(main).length >= pageText * MIN_CONTENT_SHARE)
        return { title, markdown: md, method: "main" };
    }
  }

  // No usable container: let Readability find the content block.
  try {
    const { document } = parseHTML(html);
    const article = new Readability(document as unknown as Document, { keepClasses: true }).parse();
    if (article?.content) {
      // Same cleanup as the main-container path (permalinks, heading links, layout tables).
      const $a = cheerio.load(article.content);
      const root = $a("body").length ? $a("body") : $a.root();
      stripBoilerplate($a, root);
      const md = cleanMarkdownSource(turndown().turndown($a.html(root)));
      if (guardOk(md, dataTables($a, root)))
        return { title: title || article.title || "", markdown: md, method: "readability" };
    }
  } catch {
    // fall through
  }

  // Last resort: whole body minus boilerplate. Noisy, but never loses code.
  const $2 = cheerio.load(html);
  const body = $2("body").length ? $2("body") : $2.root();
  stripBoilerplate($2, body);
  const md = cleanMarkdownSource(turndown().turndown($2.html(body)));
  return { title, markdown: md, method: "body" };
}

export async function pdfToMarkdown(data: Uint8Array, maxPages = 200): Promise<Extracted> {
  const { extractText, getDocumentProxy, getMeta } = await import("unpdf");
  const pdf = await getDocumentProxy(data);
  let title = "";
  try {
    const meta = await getMeta(pdf);
    const t = (meta.info as Record<string, unknown> | undefined)?.Title;
    if (typeof t === "string") title = t;
  } catch {
    // metadata optional
  }
  const { text, totalPages } = await extractText(pdf, { mergePages: false });
  const pages = (text as string[]).slice(0, maxPages);
  // Most PDFs carry no Title in their metadata; the first line of page 1 is the honest fallback.
  if (!title.trim()) {
    const first = (pages[0] ?? "")
      .split("\n")
      .map((l) => l.trim())
      .find((l) => l.length >= 8 && /[a-z]/i.test(l) && !/@|https?:\/\/|^arxiv:/i.test(l));
    if (first) title = first.slice(0, 120);
  }
  const parts = pages
    .map((t, i) => {
      const s = t.replace(/[ \t]+\n/g, "\n").trim();
      return s ? `## Page ${i + 1}\n\n${s}` : "";
    })
    .filter(Boolean);
  if (totalPages > maxPages) parts.push(`[${totalPages - maxPages} more pages not extracted]`);
  return { title, markdown: parts.join("\n\n") + "\n", method: "pdf" };
}
