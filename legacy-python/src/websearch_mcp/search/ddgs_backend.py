"""Ordered multi-engine search on top of `ddgs`.

We deliberately do NOT use ddgs' backend="auto": it shuffles engine order, runs only ~2
engines, and never raises RatelimitException (deedy5/ddgs#478) — blocked engines surface as
"No results found". So this wrapper owns engine ordering, per-engine rate limits, and
cooldowns, and runs one named engine per call.
"""

from __future__ import annotations

import asyncio
import logging
import time

from ddgs import DDGS
from ddgs.exceptions import DDGSException

from ..cache import Cache
from ..config import Settings
from ..ratelimit import Limiter
from .backend import SearchResult, dedupe
from .errors import SearchError

__all__ = ["OrderedDDGSBackend", "SearchError"]

log = logging.getLogger(__name__)


class OrderedDDGSBackend:
    name = "ddgs"

    def __init__(self, settings: Settings, cache: Cache, limiter: Limiter):
        self.settings = settings
        self.cache = cache
        self.limiter = limiter
        self._ddgs = DDGS(proxy=settings.proxy, timeout=int(settings.timeout))

    def _query_engine(self, engine: str, query: str, max_results: int, recency: str | None) -> list[dict]:
        return self._ddgs.text(
            query,
            region=self.settings.region,
            safesearch="off",
            timelimit=recency,
            max_results=max_results,
            backend=engine,
        )

    async def search(
        self, query: str, max_results: int, recency: str | None
    ) -> tuple[list[SearchResult], list[str]]:
        results: list[SearchResult] = []
        engines_used: list[str] = []
        errors: list[str] = []
        now = time.time()

        for engine in self.settings.engines:
            if len(results) >= max_results:
                break
            cooldown = self.cache.cooldown_until(engine)
            if cooldown > now:
                log.info("engine %s on cooldown for %ds", engine, int(cooldown - now))
                continue
            if not await self.limiter.acquire(engine):
                log.info("engine %s rate-limited locally; skipping", engine)
                continue
            try:
                raw = await asyncio.to_thread(
                    self._query_engine, engine, query, max_results, recency
                )
            except DDGSException as e:
                # Includes the "No results found." case that actually means blocked/empty.
                log.warning("engine %s failed: %s", engine, e)
                errors.append(f"{engine}: {e}")
                self.cache.set_cooldown(engine, now + self.settings.engine_cooldown_seconds)
                continue
            except Exception as e:  # noqa: BLE001 — never let one engine kill the search
                log.warning("engine %s error: %s", engine, e)
                errors.append(f"{engine}: {type(e).__name__}")
                continue

            if not raw:
                errors.append(f"{engine}: empty")
                self.cache.set_cooldown(engine, now + self.settings.engine_cooldown_seconds)
                continue

            engines_used.append(engine)
            for item in raw:
                results.append(
                    SearchResult(
                        title=(item.get("title") or "").strip(),
                        url=(item.get("href") or item.get("url") or "").strip(),
                        snippet=(item.get("body") or "").strip(),
                        engine=engine,
                    )
                )
            results = dedupe(results)

        if not results:
            detail = "; ".join(errors) if errors else "all engines skipped (cooldown/rate limit)"
            raise SearchError(f"No results from any engine ({detail}).")

        return results[:max_results], engines_used
