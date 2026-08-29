"""Token-bucket rate limiting with jitter, per engine plus a global bucket."""

from __future__ import annotations

import asyncio
import random
import time


class TokenBucket:
    def __init__(self, rate_per_minute: float, burst: int):
        self.rate = rate_per_minute / 60.0
        self.capacity = float(burst)
        self.tokens = float(burst)
        self.updated = time.monotonic()

    def _refill(self) -> None:
        now = time.monotonic()
        self.tokens = min(self.capacity, self.tokens + (now - self.updated) * self.rate)
        self.updated = now

    def wait_time(self) -> float:
        self._refill()
        if self.tokens >= 1:
            return 0.0
        return (1 - self.tokens) / self.rate

    def consume(self) -> None:
        self._refill()
        self.tokens = max(0.0, self.tokens - 1)


class Limiter:
    """Global average <= 1 request / 3 s (burst 20), plus per-engine buckets."""

    def __init__(self, engine_rates: dict[str, float], max_wait: float = 8.0):
        self._global = TokenBucket(rate_per_minute=20, burst=20)
        self._engines = {name: TokenBucket(rate, burst=3) for name, rate in engine_rates.items()}
        self._default_rate = 4.0
        self._max_wait = max_wait
        self._lock = asyncio.Lock()

    def _bucket(self, engine: str) -> TokenBucket:
        if engine not in self._engines:
            self._engines[engine] = TokenBucket(self._default_rate, burst=2)
        return self._engines[engine]

    def would_wait(self, engine: str) -> float:
        return max(self._global.wait_time(), self._bucket(engine).wait_time())

    async def acquire(self, engine: str) -> bool:
        """Wait for capacity. Returns False if the wait would exceed max_wait (caller should skip)."""
        async with self._lock:
            wait = self.would_wait(engine)
            if wait > self._max_wait:
                return False
            if wait > 0:
                await asyncio.sleep(wait)
            await asyncio.sleep(random.uniform(0.3, 1.2))  # jitter
            self._global.consume()
            self._bucket(engine).consume()
            return True
