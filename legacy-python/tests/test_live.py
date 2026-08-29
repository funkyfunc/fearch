"""Opt-in live network tests: WEBSEARCH_LIVE=1 uv run pytest tests/test_live.py -v"""

from __future__ import annotations

import os

import pytest

from websearch_mcp import server

# One event loop for the whole module: the server's HTTP sessions are process singletons and
# curl_cffi/httpx bind to the loop they were created under.
pytestmark = [
    pytest.mark.skipif(not os.environ.get("WEBSEARCH_LIVE"), reason="set WEBSEARCH_LIVE=1"),
    pytest.mark.asyncio(loop_scope="module"),
]


async def test_search_returns_results():
    out = await server.search("python asyncio timeout context manager", max_results=5)
    assert out.count("\n1. **") == 1 and "https://" in out


async def test_fetch_markdown_negotiation():
    out = await server.fetch(url="https://gofastmcp.com/servers/tools", max_chars=2000)
    assert "Source: direct (markdown)" in out


async def test_fetch_github_readme_and_sphinx_section():
    out = await server.fetch(url="https://github.com/deedy5/ddgs", max_chars=1000)
    assert "Source: github-readme" in out
    out = await server.fetch(url="https://docs.python.org/3/library/asyncio-task.html", section="Timeouts", max_chars=1500)
    assert "## Timeouts" in out and "asyncio.timeout" in out


async def test_fetch_pdf():
    out = await server.fetch(url="https://arxiv.org/pdf/2511.16397", max_chars=800)
    assert "(pdf)" in out and "## Page" in out


async def test_private_refused():
    with pytest.raises(Exception, match="private"):
        await server.fetch(url="http://127.0.0.1:1/")
