from __future__ import annotations

import os
import subprocess
import sys

import pytest
from fastmcp import Client

from websearch_mcp import server
from websearch_mcp.fetch.pipeline import PageDoc

LONG_DOC = "# Title\n\nIntro.\n\n" + "\n\n".join(
    f"## Section {i}\n\n" + f"Text about topic {i}. " * 40 + (f"\n\n```python\nx = {i}\n```" if i % 2 else "")
    for i in range(1, 15)
)


class FakeFetcher:
    async def fetch(self, url: str, raw: bool = False) -> PageDoc:
        return PageDoc(url, url, "Title", "fake", LONG_DOC)


@pytest.fixture
def fake_state(monkeypatch):
    st = server.state()
    monkeypatch.setattr(st, "fetcher", FakeFetcher())
    return st


async def test_tools_listed_with_annotations():
    async with Client(server.mcp) as c:
        tools = {t.name: t for t in await c.list_tools()}
    assert set(tools) == {"search", "fetch"}
    for t in tools.values():
        assert t.annotations.readOnlyHint is True and t.annotations.openWorldHint is True
        assert len(t.description) > 200
    props = tools["fetch"].inputSchema["properties"]
    assert {"url", "urls", "focus", "section", "max_chars", "start_index", "include_links", "raw"} <= set(props)


async def test_fetch_truncates_with_outline_and_continuation(fake_state):
    async with Client(server.mcp) as c:
        r = await c.call_tool("fetch", {"url": "https://x.test/p", "max_chars": 1500})
    text = r.content[0].text
    assert text.startswith("# Title\nURL: https://x.test/p\nSource: fake\nChars 0–")
    assert "Sections not shown:" in text and "Continue with start_index=" in text
    assert text.count("```") % 2 == 0


async def test_fetch_focus_and_section(fake_state):
    async with Client(server.mcp) as c:
        r = await c.call_tool("fetch", {"url": "https://x.test/p", "focus": "topic 7", "max_chars": 1500})
        f = r.content[0].text
        r = await c.call_tool("fetch", {"url": "https://x.test/p", "section": "Section 3"})
        s = r.content[0].text
    assert "## Section 7" in f and "Focused on: 'topic 7'" in f
    assert "## Section 3" in s and "## Section 4" not in s


async def test_fetch_missing_section_lists_available(fake_state):
    async with Client(server.mcp) as c:
        with pytest.raises(Exception, match="Available sections: .*Section 1 · Section 2"):
            await c.call_tool("fetch", {"url": "https://x.test/p", "section": "nope zzz"})


async def test_fetch_batch_splits_budget(fake_state):
    async with Client(server.mcp) as c:
        r = await c.call_tool("fetch", {"urls": ["https://a.test/", "https://b.test/"]})
    text = r.content[0].text
    assert text.count("=====") == 1
    assert "URL: https://a.test/" in text and "URL: https://b.test/" in text


async def test_fetch_requires_url():
    async with Client(server.mcp) as c:
        with pytest.raises(Exception, match="Provide `url` or `urls`"):
            await c.call_tool("fetch", {})


def test_stdio_stdout_is_pure_jsonrpc():
    """Spawn the real server over stdio: initialize + tools/list must round-trip, and stdout
    must contain nothing but JSON-RPC frames (Python MCP servers die from stray prints)."""
    init = {
        "jsonrpc": "2.0", "id": 1, "method": "initialize",
        "params": {"protocolVersion": "2025-06-18", "capabilities": {}, "clientInfo": {"name": "t", "version": "0"}},
    }
    import json

    env = {**os.environ, "WEBSEARCH_NO_CACHE": "1", "WEBSEARCH_LOG_LEVEL": "DEBUG"}
    proc = subprocess.Popen(
        [sys.executable, "-m", "websearch_mcp.server"],
        stdin=subprocess.PIPE,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
        env=env,
    )
    assert proc.stdin and proc.stdout

    def send(msg: dict) -> None:
        proc.stdin.write(json.dumps(msg) + "\n")
        proc.stdin.flush()

    def recv() -> dict:
        line = proc.stdout.readline()
        assert line, proc.stderr.read()
        return json.loads(line)  # any non-JSON byte on stdout fails here

    try:
        send(init)
        first = recv()
        assert first["id"] == 1 and "serverInfo" in first["result"]
        send({"jsonrpc": "2.0", "method": "notifications/initialized"})
        send({"jsonrpc": "2.0", "id": 2, "method": "tools/list"})
        second = recv()
        assert second["id"] == 2
        names = {t["name"] for t in second["result"]["tools"]}
        assert names == {"search", "fetch"}
    finally:
        proc.stdin.close()
        proc.wait(timeout=30)
