"""websearch-mcp: zero-API-key web search + page reading for coding agents (stdio MCP server)."""

from __future__ import annotations

import asyncio
import logging
import os
import sys
from typing import Annotated, Literal

from fastmcp import FastMCP
from fastmcp.exceptions import ToolError
from mcp.types import ToolAnnotations
from pydantic import Field

from .cache import Cache
from .config import Settings
from .fetch.budget import apply_budget
from .fetch.guard import BlockedURL
from .fetch.pipeline import Fetcher, PageDoc
from .fetch.render import apply_link_mode, render_page
from .fetch.sections import (
    find_section,
    focus_sections,
    join_sections,
    render_outline,
    split_sections,
)
from .fetch.transport import FetchError, Transport
from .ratelimit import Limiter
from .search.backend import SearchBackend, SearchResult
from .search.composite import CompositeBackend
from .search.ddgs_backend import OrderedDDGSBackend
from .search.errors import SearchError
from .search.keyed import ExaBackend, TavilyBackend
from .search.render import render_results
from .search.searxng_backend import SearXNGBackend

log = logging.getLogger("websearch_mcp")

SEARCH_DESCRIPTION = """Search the web (multi-engine, no API key). Returns a ranked markdown list of results: title, URL, snippet.

Use this for discovery — finding docs pages, GitHub repos/issues, blog posts, error messages, package names.
Then call `fetch` on the best URL to read it. To save a round trip, pass `fetch_top=N` (1–3) and the top N
results will be fetched and the passages most relevant to your query included inline.

Tips: `site="docs.python.org"` (or a `site:` operator in the query) restricts to one domain; `recency="w"`
limits to the past week (d/w/m/y). Quote exact error strings. If results are poor, rephrase rather than
paging — engines rotate automatically."""

FETCH_DESCRIPTION = """Fetch a web page and return its main content as clean markdown (boilerplate removed, code blocks
and tables preserved). Handles HTML, markdown, plain text, PDF, GitHub (files, READMEs, issues, gists),
PyPI, npm, StackOverflow, and llms.txt. Falls back to a reader proxy and the Wayback Machine when blocked.

Output is bounded by `max_chars` (default 12000). If a page is truncated the footer says
`Continue with start_index=N` and lists the sections not shown — but before paging, prefer:
  - `focus="what you are looking for"` → returns only the sections most relevant to that phrase (BM25).
  - `section="Heading text"` → returns exactly that section and its subsections (fuzzy heading match).
Both are far cheaper than reading the whole page. Pass `urls=[...]` (max 5) to read several pages in one call.
`include_links=true` adds reference-style links with a footer; `raw=true` returns the unprocessed body."""

READ_ONLY = ToolAnnotations(readOnlyHint=True, openWorldHint=True, idempotentHint=True)

mcp = FastMCP("websearch")


class _State:
    def __init__(self) -> None:
        self.settings = Settings.from_env()
        cache_path = None if os.environ.get("WEBSEARCH_NO_CACHE") else self.settings.cache_dir / "cache.sqlite"
        self.cache = Cache(cache_path)
        self.limiter = Limiter(self.settings.engine_rates)
        self.transport = Transport(self.settings)
        self.fetcher = Fetcher(self.settings, self.cache, self.transport)
        s = self.settings
        backends: list[SearchBackend] = []
        if s.searxng_url:
            backends.append(SearXNGBackend(s.searxng_url, self.limiter, s.timeout, s.proxy))
        backends.append(OrderedDDGSBackend(s, self.cache, self.limiter))
        if s.tavily_api_key:
            backends.append(TavilyBackend(s.tavily_api_key, self.limiter, s.timeout))
        if s.exa_api_key:
            backends.append(ExaBackend(s.exa_api_key, self.limiter, s.timeout))
        log.info("search backends: %s", ", ".join(b.name for b in backends))
        self.search = CompositeBackend(backends, self.cache, s.region)


_state: _State | None = None


def state() -> _State:
    global _state
    if _state is None:
        _state = _State()
    return _state


# ---------------------------------------------------------------------------
# fetch helpers
# ---------------------------------------------------------------------------


def _render_doc(
    doc: PageDoc,
    *,
    focus: str | None,
    section: str | None,
    max_chars: int,
    start_index: int,
    include_links: bool,
    raw: bool,
) -> str:
    md = doc.markdown
    if raw:
        window = apply_budget(md, start_index, max_chars)
        return render_page(title=doc.title, url=doc.final_url, source=doc.source, window=window, note=doc.note)

    sections = split_sections(md)
    outline = ""
    selected = md
    if section:
        sub = find_section(sections, section)
        if sub is None:
            available = " · ".join(s.title for s in sections if s.level > 0)[:2000]
            raise ToolError(
                f"No section matching {section!r} on {doc.final_url}. Available sections: {available or '(none — page has no headings)'}"
            )
        selected = join_sections(sub)
        outline = render_outline(sections, {s.index for s in sub})
    elif focus:
        chosen = focus_sections(sections, focus, budget=max_chars)
        selected = join_sections(chosen)
        outline = render_outline(sections, {s.index for s in chosen})

    body, links_footer = apply_link_mode(selected, include_links)
    window = apply_budget(body, start_index, max_chars)

    if not section and not focus and window.truncated:
        # Plain read: show which sections lie beyond the returned window.
        shown = {s.index for s in sections if s.start < window.end and s.end > window.start}
        outline = render_outline(sections, shown)

    note = doc.note
    if focus:
        note = (note + " " if note else "") + f"Focused on: {focus!r}."
    elif section:
        note = (note + " " if note else "") + f"Section: {section!r}."
    return render_page(
        title=doc.title,
        url=doc.final_url,
        source=doc.source,
        window=window,
        outline=outline,
        links_footer=links_footer,
        note=note,
    )


async def _fetch_one(url: str, **kw) -> str:
    st = state()
    try:
        doc = await st.fetcher.fetch(url, raw=kw.get("raw", False))
    except (BlockedURL, FetchError) as e:
        raise ToolError(str(e)) from e
    except TimeoutError as e:
        raise ToolError(f"Timed out fetching {url}") from e
    return _render_doc(doc, **kw)


async def _excerpt(url: str, query: str) -> str | None:
    """Best-effort focused excerpt of a page, for search(fetch_top=...)."""
    st = state()
    try:
        doc = await asyncio.wait_for(st.fetcher.fetch(url), timeout=st.settings.timeout + 10)
    except Exception as e:  # noqa: BLE001
        log.info("excerpt fetch failed for %s: %s", url, e)
        return None
    sections = split_sections(doc.markdown)
    chosen = focus_sections(sections, query, budget=st.settings.excerpt_chars)
    text, _ = apply_link_mode(join_sections(chosen), include_links=False)
    window = apply_budget(text, 0, st.settings.excerpt_chars)
    out = window.text.strip()
    if window.truncated:
        out += " …"
    return out or None


# ---------------------------------------------------------------------------
# tools
# ---------------------------------------------------------------------------


@mcp.tool(name="search", description=SEARCH_DESCRIPTION, annotations=READ_ONLY)
async def search(
    query: Annotated[str, Field(description="Search query. Supports `site:` and quoted phrases.")],
    max_results: Annotated[int, Field(ge=1, le=20, description="Number of results (default 8).")] = 8,
    recency: Annotated[
        Literal["d", "w", "m", "y"] | None,
        Field(description="Restrict to the past day/week/month/year."),
    ] = None,
    site: Annotated[str | None, Field(description="Restrict results to this domain, e.g. 'docs.python.org'.")] = None,
    fetch_top: Annotated[
        int, Field(ge=0, le=3, description="Also fetch the top N results and include query-focused excerpts inline.")
    ] = 0,
) -> str:
    st = state()
    q = query.strip()
    if site:
        q = f"{q} site:{site.strip()}"
    if not q:
        raise ToolError("Empty query.")
    try:
        results, engines = await st.search.search(q, max_results=max_results, recency=recency)
    except SearchError as e:
        raise ToolError(str(e)) from e

    if fetch_top:
        top: list[SearchResult] = results[:fetch_top]
        excerpts = await asyncio.gather(*(_excerpt(r.url, query) for r in top))
        for r, ex in zip(top, excerpts):
            r.excerpt = ex
    return render_results(query, results, engines)


@mcp.tool(name="fetch", description=FETCH_DESCRIPTION, annotations=READ_ONLY)
async def fetch(
    url: Annotated[str | None, Field(description="URL to fetch.")] = None,
    urls: Annotated[list[str] | None, Field(max_length=5, description="Up to 5 URLs to fetch in one call.")] = None,
    focus: Annotated[
        str | None,
        Field(description="Return only the sections most relevant to this phrase (cheapest way to read a long page)."),
    ] = None,
    section: Annotated[str | None, Field(description="Return only this heading's section (fuzzy match).")] = None,
    max_chars: Annotated[int | None, Field(ge=500, le=100_000, description="Character budget (default 12000).")] = None,
    start_index: Annotated[int, Field(ge=0, description="Character offset to continue from (see footer).")] = 0,
    include_links: Annotated[bool, Field(description="Keep hyperlinks as reference-style links with a footer.")] = False,
    raw: Annotated[bool, Field(description="Return the raw response body without extraction.")] = False,
) -> str:
    st = state()
    targets = [u for u in ([url] if url else []) + list(urls or []) if u and u.strip()]
    if not targets:
        raise ToolError("Provide `url` or `urls`.")
    if len(targets) > 5:
        raise ToolError("At most 5 URLs per call.")
    budget = max_chars or st.settings.max_chars
    if len(targets) > 1 and max_chars is None:
        budget = max(2000, budget // len(targets))
    kw = {
        "focus": focus,
        "section": section,
        "max_chars": budget,
        "start_index": start_index,
        "include_links": include_links,
        "raw": raw,
    }

    if len(targets) == 1:
        return await _fetch_one(targets[0], **kw)

    outs = await asyncio.gather(*(_fetch_one(t, **kw) for t in targets), return_exceptions=True)
    parts: list[str] = []
    for t, o in zip(targets, outs):
        if isinstance(o, BaseException):
            parts.append(f"# (failed) {t}\nError: {o}\n")
        else:
            parts.append(o)
    return "\n\n=====\n\n".join(parts)


# ---------------------------------------------------------------------------
# entrypoint
# ---------------------------------------------------------------------------


def _configure_logging() -> None:
    level = os.environ.get("WEBSEARCH_LOG_LEVEL", "INFO").upper()
    logging.basicConfig(stream=sys.stderr, level=level, format="%(levelname)s %(name)s: %(message)s")
    for noisy in ("trafilatura", "urllib3", "charset_normalizer", "httpx", "httpcore", "primp", "ddgs"):
        logging.getLogger(noisy).setLevel(logging.WARNING)


def main() -> None:
    _configure_logging()
    mcp.run()  # stdio by default; stdout carries only JSON-RPC


if __name__ == "__main__":
    main()
