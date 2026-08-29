"""HTML -> markdown extraction tuned for technical documentation.

Strategy (see plan): locate the main-content container and convert it with a *pure* converter
(markdownify), which never drops code blocks; fall back to trafilatura only when no container
can be found; guard every candidate by counting <pre> blocks in vs. fenced blocks out.
Heuristic extractors (readability/trafilatura) score badly on code (MainWebBench: 0.06/0.13).
"""

from __future__ import annotations

import io
import logging
import math
import re
from dataclasses import dataclass

import trafilatura
from bs4 import BeautifulSoup, Tag
from markdownify import MarkdownConverter

log = logging.getLogger(__name__)

MAIN_SELECTORS = [
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
]

REMOVE_SELECTORS = (
    "script, style, noscript, iframe, svg, canvas, template, nav, footer, aside, form, button, "
    "input, select, textarea, [role=navigation], [role=banner], [role=contentinfo], "
    "[role=complementary], [role=search], [role=dialog], [role=alertdialog], [aria-hidden=true], "
    ".sr-only, .visually-hidden"
)

NOISE_CLASS_RE = re.compile(
    r"(^|[\s_-])(cookie|consent|gdpr|sidebar|side-nav|sidenav|breadcrumbs?|share|social|"
    r"comments?|advert|ads?|promo|newsletter|popup|modal|subscribe|related|recommended|"
    r"footer|navbar|topbar|menu|skip-link|skip-to|toc|table-of-contents|pagination|pager|"
    r"announcement|banner|edit-this-page|feedback|on-this-page|page-nav|prev-next|"
    r"theme-doc-toc|docs-toc)([\s_-]|$)",
    re.IGNORECASE,
)

BLOCK_TAGS = ["div", "section", "ul", "ol", "li", "table", "p", "dl", "details", "figure", "span"]
HEADING_TAGS = ["h1", "h2", "h3", "h4", "h5", "h6"]
PERMALINK_TEXT = {"¶", "#", "🔗", "", "Permalink", "permalink", "Link to this heading", "Anchor"}

JSX_LINE_RE = re.compile(r"^\s*</?[A-Z][A-Za-z0-9]*(?:\s[^>]*)?/?>\s*$")
FENCE_INFO_RE = re.compile(r"^([ \t]*(?:`{3,}|~{3,}))[ \t]*([\w+#.-]*)[^\n]*$", re.MULTILINE)
HEADING_PILCROW_RE = re.compile(r"^(#{1,6} .*?)\s*(?:¶|#)\s*$", re.MULTILINE)
EMPTY_ANCHOR_RE = re.compile(r"<a\s+(?:name|id)=\"[^\"]*\"\s*>\s*</a>", re.IGNORECASE)
FRONTMATTER_RE = re.compile(r"\A---[ \t]*\n(.*?)\n---[ \t]*\n", re.DOTALL)
MDX_COMMENT_RE = re.compile(r"\s*\{/\*.*?\*/\}")
ZERO_WIDTH_RE = re.compile("[\u200b\u200c\u200d\u2060\ufeff]")
SKIP_LINE_RE = re.compile(r"^\s*(Skip to (main )?content|Skip to main|\s*)$", re.IGNORECASE)

SHELL_PATTERNS = re.compile(
    r"(You need to enable JavaScript to run this app|This site requires JavaScript|"
    r"Please enable JavaScript|JavaScript is disabled|Loading\.\.\.$)",
    re.IGNORECASE,
)


@dataclass
class Extracted:
    title: str
    markdown: str
    method: str


class _Converter(MarkdownConverter):
    """markdownify with GFM-friendly defaults: ATX headings, fenced code with language."""

    def convert_pre(self, el, text, parent_tags):  # type: ignore[override]
        if not text:
            return ""
        lang = _code_language(el)
        code = text.rstrip("\n")
        # widen fence if the code itself contains backtick runs
        fence = "```"
        while fence in code:
            fence += "`"
        return f"\n\n{fence}{lang}\n{code}\n{fence}\n\n"


def _code_language(el: Tag) -> str:
    candidates = [el] + [c for c in el.find_all("code", limit=1)]
    for node in candidates:
        for cls in node.get("class") or []:
            m = re.match(r"^(?:language|lang|highlight|brush:)[-_ ]?([\w+#.-]+)$", cls, re.IGNORECASE)
            if m:
                return m.group(1).lower()
        dl = node.get("data-lang") or node.get("data-language")
        if dl:
            return str(dl).lower()
    return ""


def _converter() -> _Converter:
    return _Converter(
        heading_style="ATX",
        bullets="-",
        escape_asterisks=False,
        escape_underscores=False,
        escape_misc=False,
        strip=["img", "picture", "video", "audio", "source"],
        wrap=False,
        autolinks=True,
        strip_document="strip",
    )


def visible_text(node: Tag) -> str:
    return re.sub(r"\s+", " ", node.get_text(" ", strip=True))


def detect_shell(html: str) -> bool:
    """True when the HTML is an empty client-rendered shell or a JS-required stub."""
    soup = BeautifulSoup(html, "lxml")
    for t in soup(["script", "style", "noscript"]):
        t.decompose()
    body = soup.body or soup
    text = visible_text(body)
    if len(text) < 200:
        return True
    return bool(SHELL_PATTERNS.search(text[:3000])) and len(text) < 1500


def _title(soup: BeautifulSoup) -> str:
    og = soup.find("meta", attrs={"property": "og:title"})
    if og and og.get("content"):
        return str(og["content"]).strip()
    if soup.title and soup.title.string:
        return soup.title.string.strip()
    h1 = soup.find("h1")
    return h1.get_text(" ", strip=True) if h1 else ""


def _strip_boilerplate(root: Tag) -> None:
    for el in root.select(REMOVE_SELECTORS):
        if el is root:
            continue
        el.decompose()
    # headers: keep article headers (title), drop site headers (nav-like)
    for el in root.find_all("header"):
        if el is root:
            continue
        if el.find("nav") or len(el.find_all("a")) >= 3:
            el.decompose()
    # Class/id-based noise removal applies to block containers only — never to inline
    # elements or anything inside a heading (Sphinx wraps heading text in <a class="toc-backref">).
    for el in root.find_all(BLOCK_TAGS):
        if el is root or el.decomposed:
            continue
        if el.find_parent(HEADING_TAGS) is not None:
            continue
        ident = " ".join([*(el.get("class") or []), str(el.get("id") or "")])
        if ident and NOISE_CLASS_RE.search(ident):
            el.decompose()
    # Permalink anchors (¶, #, "Link to this heading") add nothing but noise.
    for a in root.find_all("a"):
        txt = a.get_text("", strip=True)
        if txt in PERMALINK_TEXT and not a.find("img"):
            a.decompose()
    # Links inside headings (Sphinx toc-backref, GitHub anchors) become plain heading text.
    for h in root.find_all(HEADING_TAGS):
        for a in h.find_all("a"):
            a.unwrap()


def _find_main(soup: BeautifulSoup) -> Tag | None:
    best: Tag | None = None
    best_len = 0
    for sel in MAIN_SELECTORS:
        try:
            nodes = soup.select(sel)
        except Exception as e:  # noqa: BLE001 — invalid selector in some bs4 versions
            log.debug("selector %r failed: %s", sel, e)
            continue
        for node in nodes:
            n = len(visible_text(node))
            if n < 200:
                continue
            if best is None or n > best_len and sel in {"article"}:
                best, best_len = node, n
        if best is not None:
            return best
    return None


def clean_markdown_source(md: str) -> str:
    """Normalize markdown from any source: fence info strings reduced to the language token
    (Mintlify emits ```python theme={...}), MDX/JSX-only lines dropped, heading pilcrows removed,
    whitespace collapsed."""
    md = md.replace("\r\n", "\n")
    md = ZERO_WIDTH_RE.sub("", md)
    md = FENCE_INFO_RE.sub(lambda m: f"{m.group(1)}{m.group(2)}", md)
    md = EMPTY_ANCHOR_RE.sub("", md)
    md = MDX_COMMENT_RE.sub("", md)
    lines = [line for line in md.split("\n") if not JSX_LINE_RE.match(line)]
    while lines and SKIP_LINE_RE.match(lines[0]):
        lines.pop(0)
    md = "\n".join(lines)
    md = HEADING_PILCROW_RE.sub(r"\1", md)
    md = re.sub(r"[ \t]+\n", "\n", md)
    md = re.sub(r"\n{3,}", "\n\n", md)
    return md.strip() + "\n"


def split_frontmatter(md: str) -> tuple[dict[str, str], str]:
    """Strip a leading YAML frontmatter block; return ({key: value}, body)."""
    m = FRONTMATTER_RE.match(md)
    if not m:
        return {}, md
    meta: dict[str, str] = {}
    for line in m.group(1).split("\n"):
        if ":" in line and not line.startswith((" ", "-")):
            k, v = line.split(":", 1)
            meta[k.strip().lower()] = v.strip().strip("\"'")
    return meta, md[m.end():]


def _clean_markdown(md: str) -> str:
    return clean_markdown_source(md)


def _fence_count(md: str) -> int:
    return len(re.findall(r"^\s*(`{3,}|~{3,})", md, re.MULTILINE)) // 2


def html_to_markdown(html: str, url: str | None = None) -> Extracted:
    soup = BeautifulSoup(html, "lxml")
    title = _title(soup)
    pre_total = len(soup.find_all("pre"))

    def guard_ok(md: str) -> bool:
        if len(md.strip()) < 200:
            return False
        return not (pre_total and _fence_count(md) < math.ceil(0.8 * pre_total))

    conv = _converter()
    main = _find_main(soup)
    if main is not None:
        _strip_boilerplate(main)
        md = _clean_markdown(conv.convert_soup(main))
        if guard_ok(md):
            return Extracted(title, md, "main")
        log.debug("main-container extraction failed guard for %s", url)

    # No usable container: let trafilatura find the content block.
    try:
        tmd = trafilatura.extract(
            html,
            url=url,
            output_format="markdown",
            include_formatting=True,
            include_tables=True,
            include_links=True,
            include_comments=False,
            favor_recall=True,
        )
    except Exception as e:  # noqa: BLE001
        log.debug("trafilatura failed: %s", e)
        tmd = None
    if tmd:
        tmd = _clean_markdown(tmd)
        if guard_ok(tmd):
            return Extracted(title, tmd, "trafilatura")

    # Last resort: whole body minus boilerplate. Noisy, but never loses code.
    soup2 = BeautifulSoup(html, "lxml")
    body = soup2.body or soup2
    _strip_boilerplate(body)
    md = _clean_markdown(conv.convert_soup(body))
    return Extracted(title, md, "body")


def pdf_to_markdown(data: bytes, max_pages: int = 200) -> Extracted:
    from pypdf import PdfReader

    reader = PdfReader(io.BytesIO(data))
    title = ""
    try:
        if reader.metadata and reader.metadata.title:
            title = str(reader.metadata.title)
    except Exception as e:  # noqa: BLE001
        log.debug("pdf metadata unreadable: %s", e)
    parts: list[str] = []
    for i, page in enumerate(reader.pages[:max_pages], start=1):
        try:
            text = page.extract_text() or ""
        except Exception as e:  # noqa: BLE001
            text = f"[page {i}: extraction failed: {e}]"
        text = re.sub(r"[ \t]+\n", "\n", text).strip()
        if text:
            parts.append(f"## Page {i}\n\n{text}")
    if len(reader.pages) > max_pages:
        parts.append(f"[{len(reader.pages) - max_pages} more pages not extracted]")
    return Extracted(title, "\n\n".join(parts) + "\n", "pdf")


def html_snippet_to_markdown(html: str) -> str:
    """Convert a fragment (e.g. an API-returned HTML body) to markdown."""
    return _clean_markdown(_converter().convert(html))
