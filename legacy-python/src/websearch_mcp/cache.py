"""On-disk sqlite cache: extracted pages, search results, engine cooldowns.

Cross-session caching matters for coding agents, which re-read the same docs constantly.
Caching the *extracted* markdown also makes `start_index` paging deterministic.
"""

from __future__ import annotations

import json
import sqlite3
import threading
import time
from dataclasses import dataclass
from pathlib import Path

PAGE_TTL = 24 * 3600
SEARCH_TTL = 15 * 60

_SCHEMA = """
CREATE TABLE IF NOT EXISTS pages (
    url TEXT PRIMARY KEY,
    final_url TEXT,
    title TEXT,
    source TEXT,
    markdown TEXT,
    fetched_at REAL
);
CREATE TABLE IF NOT EXISTS searches (
    key TEXT PRIMARY KEY,
    results TEXT,
    fetched_at REAL
);
CREATE TABLE IF NOT EXISTS engine_state (
    engine TEXT PRIMARY KEY,
    cooldown_until REAL
);
"""


@dataclass
class CachedPage:
    url: str
    final_url: str
    title: str
    source: str
    markdown: str
    fetched_at: float


class Cache:
    def __init__(self, path: Path | None):
        self._lock = threading.Lock()
        if path is None:
            self._conn = sqlite3.connect(":memory:", check_same_thread=False)
        else:
            path.parent.mkdir(parents=True, exist_ok=True)
            self._conn = sqlite3.connect(str(path), check_same_thread=False)
        self._conn.executescript(_SCHEMA)
        self._conn.commit()

    # -- pages -------------------------------------------------------------

    def get_page(self, url: str) -> CachedPage | None:
        with self._lock:
            row = self._conn.execute(
                "SELECT url, final_url, title, source, markdown, fetched_at FROM pages WHERE url = ?",
                (url,),
            ).fetchone()
        if not row or time.time() - row[5] > PAGE_TTL:
            return None
        return CachedPage(*row)

    def set_page(self, url: str, final_url: str, title: str, source: str, markdown: str) -> None:
        with self._lock:
            self._conn.execute(
                "INSERT OR REPLACE INTO pages VALUES (?, ?, ?, ?, ?, ?)",
                (url, final_url, title, source, markdown, time.time()),
            )
            self._conn.commit()

    # -- searches ----------------------------------------------------------

    def get_search(self, key: str) -> list[dict] | None:
        with self._lock:
            row = self._conn.execute(
                "SELECT results, fetched_at FROM searches WHERE key = ?", (key,)
            ).fetchone()
        if not row or time.time() - row[1] > SEARCH_TTL:
            return None
        return json.loads(row[0])

    def set_search(self, key: str, results: list[dict]) -> None:
        with self._lock:
            self._conn.execute(
                "INSERT OR REPLACE INTO searches VALUES (?, ?, ?)",
                (key, json.dumps(results), time.time()),
            )
            self._conn.commit()

    # -- engine cooldowns --------------------------------------------------

    def cooldown_until(self, engine: str) -> float:
        with self._lock:
            row = self._conn.execute(
                "SELECT cooldown_until FROM engine_state WHERE engine = ?", (engine,)
            ).fetchone()
        return float(row[0]) if row else 0.0

    def set_cooldown(self, engine: str, until: float) -> None:
        with self._lock:
            self._conn.execute(
                "INSERT OR REPLACE INTO engine_state VALUES (?, ?)", (engine, until)
            )
            self._conn.commit()

    def close(self) -> None:
        with self._lock:
            self._conn.close()
