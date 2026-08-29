"""Search result model, backend protocol, and URL normalization shared by all backends."""

from __future__ import annotations

import base64
import binascii
import re
from dataclasses import asdict, dataclass
from typing import Protocol
from urllib.parse import parse_qs, unquote, urlparse, urlsplit, urlunsplit

TRACKING_PARAMS = re.compile(r"^(utm_\w+|fbclid|gclid|msclkid|mc_cid|mc_eid|ref|ref_src|_hsenc|_hsmi|yclid)$", re.IGNORECASE)


@dataclass
class SearchResult:
    title: str
    url: str
    snippet: str
    engine: str
    excerpt: str | None = None

    def to_dict(self) -> dict:
        return asdict(self)

    @classmethod
    def from_dict(cls, d: dict) -> SearchResult:
        return cls(**d)


class SearchBackend(Protocol):
    name: str

    async def search(
        self, query: str, max_results: int, recency: str | None
    ) -> tuple[list[SearchResult], list[str]]:
        """Returns (results, engines_used)."""
        ...


def unwrap_redirect(url: str) -> str:
    """Unwrap DuckDuckGo / Bing / Google click-tracking redirect URLs."""
    try:
        p = urlparse(url)
    except ValueError:
        return url
    host = p.netloc.lower()
    qs = parse_qs(p.query)
    if host.endswith("duckduckgo.com") and p.path.startswith("/l/") and "uddg" in qs:
        return unquote(qs["uddg"][0])
    if host.endswith("bing.com") and p.path.startswith("/ck/") and "u" in qs:
        raw = qs["u"][0]
        if raw.startswith("a1"):
            padded = raw[2:] + "=" * (-len(raw[2:]) % 4)
            try:
                return base64.urlsafe_b64decode(padded).decode("utf-8", "replace")
            except (binascii.Error, ValueError):
                return url
    if host.endswith("google.com") and p.path == "/url" and "q" in qs:
        return qs["q"][0]
    if host.endswith("google.com") and p.path == "/url" and "url" in qs:
        return qs["url"][0]
    if url.startswith("//"):
        return "https:" + url
    return url


def canonicalize(url: str) -> str:
    """Strip tracking params and fragments; normalize scheme/host case."""
    url = unwrap_redirect(url.strip())
    try:
        parts = urlsplit(url)
    except ValueError:
        return url
    if not parts.scheme:
        parts = urlsplit("https://" + url)
    query = "&".join(
        kv for kv in parts.query.split("&") if kv and not TRACKING_PARAMS.match(kv.split("=", 1)[0])
    )
    host = parts.netloc.lower()
    if host.startswith("www."):
        host_key = host[4:]
    else:
        host_key = host
    path = parts.path or "/"
    return urlunsplit((parts.scheme.lower(), host_key, path, query, ""))


def dedupe(results: list[SearchResult]) -> list[SearchResult]:
    seen: set[str] = set()
    out: list[SearchResult] = []
    for r in results:
        key = canonicalize(r.url).rstrip("/")
        if key in seen:
            continue
        seen.add(key)
        r.url = unwrap_redirect(r.url)
        out.append(r)
    return out
