from __future__ import annotations

import httpx
import pytest

from websearch_mcp.cache import Cache
from websearch_mcp.ratelimit import Limiter
from websearch_mcp.search.backend import SearchResult
from websearch_mcp.search.composite import CompositeBackend
from websearch_mcp.search.errors import SearchError
from websearch_mcp.search.keyed import ExaBackend, TavilyBackend
from websearch_mcp.search.searxng_backend import SearXNGBackend


class NoWaitLimiter(Limiter):
    async def acquire(self, engine: str) -> bool:
        return True


class Stub:
    def __init__(self, name, results=None, error=None):
        self.name, self.results, self.error, self.calls = name, results or [], error, 0

    async def search(self, query, max_results, recency):
        self.calls += 1
        if self.error:
            raise SearchError(self.error)
        return list(self.results), [self.name]


def r(url: str) -> SearchResult:
    return SearchResult("t", url, "s", "e")


async def test_composite_order_dedupe_and_cache():
    a = Stub("a", [r("https://x.com/1"), r("https://x.com/2")])
    b = Stub("b", error="b down")
    c = Stub("c", [r("https://x.com/2?utm_source=z"), r("https://x.com/3")])
    comp = CompositeBackend([a, b, c], Cache(None))
    results, engines = await comp.search("q", max_results=3, recency=None)
    assert [x.url for x in results] == ["https://x.com/1", "https://x.com/2", "https://x.com/3"]
    assert engines == ["a", "c"]
    _, engines = await comp.search("q", max_results=3, recency=None)
    assert engines == ["cache"] and a.calls == 1

    results, engines = await comp.search("q2", max_results=2, recency=None)
    assert engines == ["a"] and c.calls == 1  # satisfied by first backend; c not called


async def test_composite_all_fail():
    comp = CompositeBackend([Stub("a", error="a down"), Stub("b", error="b down")], Cache(None))
    with pytest.raises(SearchError, match="a down; b down"):
        await comp.search("q", 3, None)


def client(handler) -> httpx.AsyncClient:
    return httpx.AsyncClient(transport=httpx.MockTransport(handler))


async def test_searxng_backend_parses_and_maps_recency():
    seen = {}

    def handler(req: httpx.Request) -> httpx.Response:
        seen.update(dict(req.url.params))
        return httpx.Response(200, json={"results": [{"title": "T", "url": "https://x.com/", "content": "c", "engine": "bing"}],
                                         "unresponsive_engines": [["google", "CAPTCHA"]]})

    b = SearXNGBackend("http://searx.local:8080/", NoWaitLimiter({}))
    b._client = client(handler)
    results, engines = await b.search("q", 5, "w")
    assert seen["format"] == "json" and seen["time_range"] == "week"
    assert results[0].engine == "searxng/bing" and engines == ["searxng"]


async def test_searxng_403_hint():
    b = SearXNGBackend("http://searx.local", NoWaitLimiter({}))
    b._client = client(lambda req: httpx.Response(403))
    with pytest.raises(SearchError, match="search.formats"):
        await b.search("q", 5, None)


async def test_tavily_backend():
    def handler(req: httpx.Request) -> httpx.Response:
        assert req.headers["authorization"] == "Bearer k"
        assert b'"time_range":"month"' in req.content.replace(b": ", b":")
        return httpx.Response(200, json={"results": [{"title": "T", "url": "https://t.com/a", "content": "body"}]})

    b = TavilyBackend("k", NoWaitLimiter({}), client=client(handler))
    results, engines = await b.search("q", 5, "m")
    assert results[0].snippet == "body" and engines == ["tavily"]


async def test_exa_backend_highlights():
    def handler(req: httpx.Request) -> httpx.Response:
        assert req.headers["x-api-key"] == "k"
        return httpx.Response(200, json={"results": [{"title": "T", "url": "https://e.com/a", "highlights": ["h1 ", "h2"]}]})

    b = ExaBackend("k", NoWaitLimiter({}), client=client(handler))
    results, _ = await b.search("q", 5, None)
    assert results[0].snippet == "h1 h2"


async def test_keyed_http_error_is_search_error():
    b = TavilyBackend("k", NoWaitLimiter({}), client=client(lambda req: httpx.Response(429)))
    with pytest.raises(SearchError, match="HTTP 429"):
        await b.search("q", 5, None)
