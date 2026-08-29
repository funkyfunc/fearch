"""Optional self-hosted SearXNG backend (SEARXNG_URL). Requires `search.formats: [html, json]`
in the instance's settings.yml. Note: a SearXNG instance on your own IP inherits the same
engine blocks as direct scraping — it is an option, not a default."""

from __future__ import annotations

import logging

import httpx

from ..ratelimit import Limiter
from .backend import SearchResult, dedupe
from .errors import SearchError

log = logging.getLogger(__name__)

RECENCY = {"d": "day", "w": "week", "m": "month", "y": "year"}


class SearXNGBackend:
    name = "searxng"

    def __init__(self, base_url: str, limiter: Limiter, timeout: float = 15.0, proxy: str | None = None):
        self.base_url = base_url.rstrip("/")
        self.limiter = limiter
        self._client = httpx.AsyncClient(timeout=timeout, proxy=proxy, headers={"User-Agent": "websearch-mcp/0.1"})

    async def search(
        self, query: str, max_results: int, recency: str | None
    ) -> tuple[list[SearchResult], list[str]]:
        if not await self.limiter.acquire("searxng"):
            raise SearchError("searxng: local rate limit")
        params: dict[str, str | int] = {"q": query, "format": "json", "safesearch": 0, "pageno": 1}
        if recency and recency in RECENCY:
            params["time_range"] = RECENCY[recency]
        try:
            r = await self._client.get(f"{self.base_url}/search", params=params)
        except httpx.HTTPError as e:
            raise SearchError(f"searxng: {e}") from e
        if r.status_code == 403:
            raise SearchError("searxng: HTTP 403 — enable `json` in search.formats in settings.yml")
        if r.status_code != 200:
            raise SearchError(f"searxng: HTTP {r.status_code}")
        data = r.json()
        results = [
            SearchResult(
                title=(item.get("title") or "").strip(),
                url=(item.get("url") or "").strip(),
                snippet=(item.get("content") or "").strip(),
                engine=f"searxng/{(item.get('engine') or '?')}",
            )
            for item in data.get("results") or []
            if item.get("url")
        ]
        unresponsive = data.get("unresponsive_engines") or []
        if unresponsive:
            log.info("searxng unresponsive engines: %s", unresponsive)
        if not results:
            raise SearchError("searxng: no results")
        return dedupe(results)[:max_results], ["searxng"]
