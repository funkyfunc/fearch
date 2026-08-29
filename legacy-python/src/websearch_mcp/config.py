"""Environment-driven settings. Everything is optional; defaults work with zero keys."""

from __future__ import annotations

import os
from dataclasses import dataclass, field
from pathlib import Path

# Ordered to alternate between underlying indexes:
# duckduckgo/yahoo -> Bing index; google/startpage -> Google index; mojeek -> independent.
DEFAULT_ENGINES: tuple[str, ...] = ("duckduckgo", "yahoo", "mojeek", "google", "startpage", "brave")

# Per-engine sustained requests per minute (conservative; DDG blocks well before 30/min).
DEFAULT_ENGINE_RATES: dict[str, float] = {
    "duckduckgo": 6,
    "yahoo": 6,
    "mojeek": 10,
    "google": 3,
    "startpage": 3,
    "brave": 2,
    "wikipedia": 8,
    "grokipedia": 8,
}


def _env_bool(name: str, default: bool = False) -> bool:
    val = os.environ.get(name)
    if val is None:
        return default
    return val.strip().lower() in {"1", "true", "yes", "on"}


def _env_int(name: str, default: int) -> int:
    val = os.environ.get(name)
    try:
        return int(val) if val else default
    except ValueError:
        return default


@dataclass(frozen=True)
class Settings:
    engines: tuple[str, ...] = DEFAULT_ENGINES
    region: str = "us-en"
    searxng_url: str | None = None
    tavily_api_key: str | None = None
    exa_api_key: str | None = None
    jina_api_key: str | None = None
    proxy: str | None = None
    max_chars: int = 12_000
    excerpt_chars: int = 1_500
    allow_private: bool = False
    cache_dir: Path = field(default_factory=lambda: Path.home() / ".cache" / "websearch-mcp")
    timeout: float = 15.0
    impersonate: str = "chrome"
    engine_cooldown_seconds: int = 25 * 60
    engine_rates: dict[str, float] = field(default_factory=lambda: dict(DEFAULT_ENGINE_RATES))

    @classmethod
    def from_env(cls) -> Settings:
        engines_raw = os.environ.get("WEBSEARCH_ENGINES")
        engines = (
            tuple(e.strip() for e in engines_raw.split(",") if e.strip())
            if engines_raw
            else DEFAULT_ENGINES
        )
        cache_dir = os.environ.get("WEBSEARCH_CACHE_DIR")
        return cls(
            engines=engines,
            region=os.environ.get("WEBSEARCH_REGION", "us-en"),
            searxng_url=os.environ.get("SEARXNG_URL") or None,
            tavily_api_key=os.environ.get("TAVILY_API_KEY") or None,
            exa_api_key=os.environ.get("EXA_API_KEY") or None,
            jina_api_key=os.environ.get("JINA_API_KEY") or None,
            proxy=os.environ.get("WEBSEARCH_PROXY") or None,
            max_chars=_env_int("WEBSEARCH_MAX_CHARS", 12_000),
            allow_private=_env_bool("WEBSEARCH_ALLOW_PRIVATE"),
            cache_dir=Path(cache_dir).expanduser() if cache_dir else Path.home() / ".cache" / "websearch-mcp",
            timeout=float(os.environ.get("WEBSEARCH_TIMEOUT", "15")),
            impersonate=os.environ.get("WEBSEARCH_IMPERSONATE", "chrome"),
        )
