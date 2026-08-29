"""Runs search backends in order (SearXNG if configured -> ddgs engines -> keyed APIs as a last
resort) until enough unique results are collected. Owns the 15-minute result cache."""

from __future__ import annotations

import hashlib
import logging

from ..cache import Cache
from .backend import SearchBackend, SearchResult, dedupe
from .errors import SearchError

log = logging.getLogger(__name__)


class CompositeBackend:
    name = "composite"

    def __init__(self, backends: list[SearchBackend], cache: Cache, region: str = "us-en"):
        self.backends = backends
        self.cache = cache
        self.region = region

    async def search(
        self, query: str, max_results: int, recency: str | None
    ) -> tuple[list[SearchResult], list[str]]:
        key = hashlib.sha1(f"{query}|{max_results}|{recency}|{self.region}".encode()).hexdigest()
        cached = self.cache.get_search(key)
        if cached is not None:
            log.info("search cache hit: %r", query)
            return [SearchResult.from_dict(d) for d in cached], ["cache"]

        results: list[SearchResult] = []
        engines: list[str] = []
        errors: list[str] = []
        for backend in self.backends:
            if len(results) >= max_results:
                break
            try:
                r, e = await backend.search(query, max_results, recency)
            except SearchError as ex:
                errors.append(str(ex))
                continue
            results = dedupe(results + r)
            engines.extend(e)

        if not results:
            raise SearchError("No results from any backend (" + "; ".join(errors) + ").")
        results = results[:max_results]
        self.cache.set_search(key, [x.to_dict() for x in results])
        return results, engines
