"""Optional keyed backends (Tavily, Exa). Used only when the corresponding env key is set, and
only as a last resort after the free backends, to protect the free-tier quota.

These are thin adapters written against the public API docs and are exercised by unit tests
with recorded response shapes, not live calls."""

from __future__ import annotations

import logging

import httpx

from ..ratelimit import Limiter
from .backend import SearchResult, dedupe
from .errors import SearchError

log = logging.getLogger(__name__)

TAVILY_RECENCY = {"d": "day", "w": "week", "m": "month", "y": "year"}


class TavilyBackend:
    name = "tavily"

    def __init__(self, api_key: str, limiter: Limiter, timeout: float = 15.0, client: httpx.AsyncClient | None = None):
        self.api_key = api_key
        self.limiter = limiter
        self._client = client or httpx.AsyncClient(timeout=timeout)

    async def search(self, query: str, max_results: int, recency: str | None) -> tuple[list[SearchResult], list[str]]:
        if not await self.limiter.acquire("tavily"):
            raise SearchError("tavily: local rate limit")
        body: dict = {"query": query, "max_results": min(max_results, 20), "search_depth": "basic"}
        if recency in TAVILY_RECENCY:
            body["time_range"] = TAVILY_RECENCY[recency]
        try:
            r = await self._client.post(
                "https://api.tavily.com/search",
                json=body,
                headers={"Authorization": f"Bearer {self.api_key}", "Content-Type": "application/json"},
            )
        except httpx.HTTPError as e:
            raise SearchError(f"tavily: {e}") from e
        if r.status_code != 200:
            raise SearchError(f"tavily: HTTP {r.status_code}")
        results = [
            SearchResult(
                title=(item.get("title") or "").strip(),
                url=(item.get("url") or "").strip(),
                snippet=(item.get("content") or "").strip()[:600],
                engine="tavily",
            )
            for item in r.json().get("results") or []
            if item.get("url")
        ]
        if not results:
            raise SearchError("tavily: no results")
        return dedupe(results)[:max_results], ["tavily"]


class ExaBackend:
    name = "exa"

    def __init__(self, api_key: str, limiter: Limiter, timeout: float = 15.0, client: httpx.AsyncClient | None = None):
        self.api_key = api_key
        self.limiter = limiter
        self._client = client or httpx.AsyncClient(timeout=timeout)

    async def search(self, query: str, max_results: int, recency: str | None) -> tuple[list[SearchResult], list[str]]:
        if not await self.limiter.acquire("exa"):
            raise SearchError("exa: local rate limit")
        body: dict = {
            "query": query,
            "numResults": min(max_results, 20),
            "type": "auto",
            "contents": {"highlights": {"maxCharacters": 400, "numSentences": 2, "highlightsPerUrl": 1}},
        }
        if recency:
            from datetime import UTC, datetime, timedelta

            days = {"d": 1, "w": 7, "m": 31, "y": 365}[recency]
            body["startPublishedDate"] = (datetime.now(UTC) - timedelta(days=days)).strftime("%Y-%m-%dT00:00:00.000Z")
        try:
            r = await self._client.post(
                "https://api.exa.ai/search",
                json=body,
                headers={"x-api-key": self.api_key, "Content-Type": "application/json"},
            )
        except httpx.HTTPError as e:
            raise SearchError(f"exa: {e}") from e
        if r.status_code != 200:
            raise SearchError(f"exa: HTTP {r.status_code}")
        results = []
        for item in r.json().get("results") or []:
            if not item.get("url"):
                continue
            highlights = item.get("highlights") or []
            snippet = " ".join(h.strip() for h in highlights) if highlights else (item.get("text") or "")[:400]
            results.append(SearchResult(title=(item.get("title") or "").strip(), url=item["url"], snippet=snippet.strip(), engine="exa"))
        if not results:
            raise SearchError("exa: no results")
        return dedupe(results)[:max_results], ["exa"]
