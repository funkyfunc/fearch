from __future__ import annotations

import base64

import pytest
from ddgs.exceptions import DDGSException

from websearch_mcp.cache import Cache
from websearch_mcp.config import Settings
from websearch_mcp.ratelimit import Limiter
from websearch_mcp.search.backend import SearchResult, canonicalize, dedupe, unwrap_redirect
from websearch_mcp.search.ddgs_backend import OrderedDDGSBackend, SearchError
from websearch_mcp.search.render import render_results


def test_unwrap_redirects():
    assert unwrap_redirect("https://duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com%2Fa%3Fb%3D1&rut=x") == "https://example.com/a?b=1"
    b64 = base64.urlsafe_b64encode(b"https://example.com/bing").decode().rstrip("=")
    assert unwrap_redirect(f"https://www.bing.com/ck/a?!&&p=abc&u=a1{b64}&ntb=1") == "https://example.com/bing"
    assert unwrap_redirect("https://www.google.com/url?q=https://example.com/g&sa=U") == "https://example.com/g"
    assert unwrap_redirect("https://plain.example.com/x") == "https://plain.example.com/x"


def test_canonicalize_and_dedupe():
    assert canonicalize("https://WWW.Example.com/p?utm_source=x&a=1&fbclid=2#frag") == "https://example.com/p?a=1"
    results = [
        SearchResult("a", "https://example.com/p?utm_source=x", "", "e1"),
        SearchResult("b", "https://www.example.com/p/", "", "e2"),
        SearchResult("c", "https://example.com/q", "", "e1"),
    ]
    assert [r.title for r in dedupe(results)] == ["a", "c"]


def test_render_results_markdown():
    out = render_results("q", [SearchResult("Title", "https://e.com", "snip", "ddg", excerpt="line1\nline2")], ["ddg"])
    assert '1. **Title** — https://e.com' in out
    assert "   snip" in out and "   > line1\n   > line2" in out
    assert "fetch(" in out


class FakeLimiter(Limiter):
    async def acquire(self, engine: str) -> bool:  # no sleeping in tests
        return True


def make_backend(calls: dict[str, object]) -> OrderedDDGSBackend:
    settings = Settings(engines=("e1", "e2", "e3"), engine_cooldown_seconds=600)
    b = OrderedDDGSBackend(settings, Cache(None), FakeLimiter(settings.engine_rates))
    log: list[str] = []

    def fake_query(engine, query, max_results, recency):
        log.append(engine)
        r = calls.get(engine)
        if isinstance(r, Exception):
            raise r
        return r or []

    b._query_engine = fake_query  # type: ignore[method-assign]
    b._log = log  # type: ignore[attr-defined]
    return b


async def test_ordered_failover_and_cooldown():
    b = make_backend({
        "e1": DDGSException("No results found."),
        "e2": [{"title": "T", "href": "https://x.com/1", "body": "s"}],
    })
    results, engines = await b.search("q", max_results=5, recency=None)
    assert [r.url for r in results] == ["https://x.com/1"]
    assert engines == ["e2"]
    # e1 failed -> on cooldown; e2 gave results; e3 also tried since < max_results
    assert b._log == ["e1", "e2", "e3"]
    assert b.cache.cooldown_until("e1") > 0
    assert b.cache.cooldown_until("e2") == 0

    b._log.clear()
    await b.search("q2", max_results=1, recency=None)
    assert b._log == ["e2"]  # e1 skipped on cooldown, e2 satisfied max_results


async def test_all_engines_fail():
    b = make_backend({"e1": DDGSException("x"), "e2": [], "e3": RuntimeError("boom")})
    with pytest.raises(SearchError, match="No results from any engine"):
        await b.search("q", max_results=3, recency=None)
