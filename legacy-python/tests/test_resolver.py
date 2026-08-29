from __future__ import annotations

import httpx

from websearch_mcp.fetch.resolver import resolve_fast_path, rewrite_url, wrap_file


def test_wrap_file():
    assert wrap_file("README.md", "# hi") == ("markdown", "# hi")
    _, body = wrap_file("main.py", "print(1)")
    assert body == "```python\nprint(1)\n```\n"
    _, body = wrap_file("x.unknownext", "a```b")
    assert body.startswith("````\n")  # fence widened past inner backticks


def test_rewrite_url():
    assert rewrite_url("https://arxiv.org/abs/2511.16397v2") == "https://arxiv.org/abs/2511.16397"
    assert rewrite_url("https://arxiv.org/pdf/2511.16397") == "https://arxiv.org/pdf/2511.16397"
    assert rewrite_url("https://example.com/") == "https://example.com/"


def fake_client(routes: dict[str, object]) -> httpx.AsyncClient:
    def handler(request: httpx.Request) -> httpx.Response:
        key = str(request.url).split("?")[0]
        for prefix, payload in routes.items():
            if key.startswith(prefix):
                if isinstance(payload, (dict, list)):
                    return httpx.Response(200, json=payload)
                return httpx.Response(200, text=str(payload))
        return httpx.Response(404)

    return httpx.AsyncClient(transport=httpx.MockTransport(handler))


async def test_github_blob_to_raw():
    client = fake_client({"https://raw.githubusercontent.com/o/r/main/src/app.py": "x = 1"})
    f = await resolve_fast_path("https://github.com/o/r/blob/main/src/app.py", client)
    assert f is not None and f.source == "github-raw"
    assert f.body == "```python\nx = 1\n```\n"


async def test_github_readme_and_issue():
    client = fake_client({
        "https://api.github.com/repos/o/r/readme": "# R",
        "https://api.github.com/repos/o/r/issues/7/comments": [{"user": {"login": "u2"}, "created_at": "2026-01-02T", "body": "me too"}],
        "https://api.github.com/repos/o/r/issues/7": {"title": "Bug", "state": "open", "user": {"login": "u1"}, "created_at": "2026-01-01T", "comments": 1, "body": "It broke"},
        "https://api.github.com/repos/o/r": {"full_name": "o/r", "description": "d", "stargazers_count": 5, "language": "Go", "default_branch": "main", "pushed_at": "2026-01-01T"},
    })
    f = await resolve_fast_path("https://github.com/o/r", client)
    assert f.source == "github-readme" and "# o/r" in f.body and "# R" in f.body
    f = await resolve_fast_path("https://github.com/o/r/issues/7", client)
    assert f.source == "github-issue" and "# Bug (#7)" in f.body and "**u2**" in f.body and "me too" in f.body


async def test_pypi_npm_stackoverflow():
    client = fake_client({
        "https://pypi.org/pypi/pkg/json": {"info": {"name": "pkg", "version": "1.0", "summary": "S", "description": "# Readme", "project_urls": {"Home": "h"}}},
        "https://registry.npmjs.org/left-pad": {"name": "left-pad", "dist-tags": {"latest": "1.3.0"}, "description": "pad", "readme": "# LP"},
        "https://api.stackexchange.com/2.3/questions/1/answers": {"items": [{"is_accepted": True, "score": 9, "body": "<p>Use <code>x</code></p>"}]},
        "https://api.stackexchange.com/2.3/questions/1": {"items": [{"title": "How?", "score": 3, "answer_count": 1, "tags": ["python"], "body": "<p>Q body</p>"}]},
    })
    f = await resolve_fast_path("https://pypi.org/project/pkg/", client)
    assert f.source == "pypi" and f.body.startswith("# pkg 1.0") and "# Readme" in f.body
    f = await resolve_fast_path("https://www.npmjs.com/package/left-pad", client)
    assert f.source == "npm" and "# left-pad 1.3.0" in f.body and "# LP" in f.body
    f = await resolve_fast_path("https://stackoverflow.com/questions/1/how", client)
    assert f.source == "stackoverflow" and "# How?" in f.body and "## Accepted answer (score 9)" in f.body and "Use `x`" in f.body


async def test_unknown_host_falls_through():
    assert await resolve_fast_path("https://example.com/", fake_client({})) is None
    assert await resolve_fast_path("https://github.com/o/r/tree/main/dir", fake_client({})) is None
