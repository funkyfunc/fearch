"""Fetch orchestration: guard -> cache -> fast paths -> transport ladder -> extraction."""

from __future__ import annotations

import logging
from dataclasses import dataclass
from urllib.parse import urlsplit

import httpx

from ..cache import Cache
from ..config import Settings
from .extract import (
    clean_markdown_source,
    detect_shell,
    html_to_markdown,
    pdf_to_markdown,
    split_frontmatter,
)
from .guard import check_url
from .resolver import llms_txt, resolve_fast_path, rewrite_url
from .transport import Fetched, FetchError, Transport

log = logging.getLogger(__name__)


@dataclass
class PageDoc:
    url: str
    final_url: str
    title: str
    source: str
    markdown: str
    note: str = ""


class Fetcher:
    def __init__(self, settings: Settings, cache: Cache, transport: Transport):
        self.settings = settings
        self.cache = cache
        self.transport = transport
        self._http: httpx.AsyncClient | None = None

    def _client(self) -> httpx.AsyncClient:
        if self._http is None:
            self._http = httpx.AsyncClient(
                timeout=self.settings.timeout,
                proxy=self.settings.proxy,
                headers={"User-Agent": "websearch-mcp/0.1"},
            )
        return self._http

    async def close(self) -> None:
        if self._http is not None:
            await self._http.aclose()
            self._http = None
        await self.transport.close()

    def _to_doc(self, url: str, f: Fetched) -> PageDoc:
        if f.kind == "pdf":
            ex = pdf_to_markdown(f.body if isinstance(f.body, bytes) else f.body.encode())
            return PageDoc(url, f.final_url, ex.title, f"{f.source} (pdf)", ex.markdown)
        if f.kind in {"markdown", "text", "json"}:
            meta, text = split_frontmatter(f.text)
            text = clean_markdown_source(text) if f.kind == "markdown" else text
            title = meta.get("title", "")
            for line in text.splitlines()[:5] if not title else []:
                if line.startswith("# "):
                    title = line[2:].strip()
                    break
                if line.lower().startswith("title:"):
                    title = line.split(":", 1)[1].strip()
                    break
            src = f.source if f.source != "direct" else f"direct ({f.kind})"
            return PageDoc(url, f.final_url, title, src, text if text.endswith("\n") else text + "\n")
        ex = html_to_markdown(f.text, f.final_url)
        src = f.source if f.source != "direct" else f"direct (html/{ex.method})"
        return PageDoc(url, f.final_url, ex.title, src, ex.markdown)

    async def fetch(self, url: str, raw: bool = False) -> PageDoc:
        url = await check_url(url, self.settings.allow_private)
        url = rewrite_url(url)

        if raw:
            f = await self.transport.get(url)
            text = f.text
            return PageDoc(url, f.final_url, "", f"raw ({f.kind}, HTTP {f.status})", text)

        cached = self.cache.get_page(url)
        if cached is not None:
            log.info("page cache hit: %s", url)
            return PageDoc(url, cached.final_url, cached.title, f"cache ← {cached.source}", cached.markdown)

        client = self._client()
        doc: PageDoc | None = None

        fast = await resolve_fast_path(url, client)
        if fast is not None:
            doc = self._to_doc(url, fast)
        else:
            def is_shell(f: Fetched) -> bool:
                return detect_shell(f.text)

            f = await self.transport.fetch_with_fallbacks(url, is_shell)
            doc = self._to_doc(url, f)

            # Root pages of docs sites: llms.txt is usually a far better index than the HTML home.
            path = urlsplit(url).path
            depth = len([s for s in path.split("/") if s])
            if depth <= 1:
                llms = await llms_txt(url, client)
                if llms:
                    if depth == 0 or len(doc.markdown.strip()) < 500:
                        doc = PageDoc(url, doc.final_url, doc.title or "llms.txt", "llms.txt", llms if llms.endswith("\n") else llms + "\n")
                    else:
                        origin = f"{urlsplit(url).scheme}://{urlsplit(url).netloc}"
                        doc.note = f"Note: this site publishes {origin}/llms.txt (an agent-friendly index of its docs)."

        if not doc.markdown.strip():
            raise FetchError(f"Fetched {url} but extracted no readable content (source: {doc.source}).")

        self.cache.set_page(url, doc.final_url, doc.title, doc.source, doc.markdown)
        return doc
