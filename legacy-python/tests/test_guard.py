from __future__ import annotations

import pytest

from websearch_mcp.fetch.guard import BlockedURL, check_url, normalize_url


def test_normalize():
    assert normalize_url("example.com/a#frag") == "https://example.com/a"
    assert normalize_url("http://example.com") == "https://example.com/"
    with pytest.raises(BlockedURL):
        normalize_url("ftp://example.com/x")
    with pytest.raises(BlockedURL):
        normalize_url("")


@pytest.mark.parametrize(
    "url",
    [
        "http://localhost:8080/admin",
        "http://127.0.0.1/",
        "http://10.0.0.5/secret",
        "http://192.168.1.1/",
        "http://169.254.169.254/latest/meta-data/",
        "http://[::1]/",
        "http://metadata.google.internal/",
        "http://printer.local/",
    ],
)
async def test_private_targets_refused(url):
    with pytest.raises(BlockedURL):
        await check_url(url)


async def test_private_allowed_when_configured():
    assert await check_url("http://127.0.0.1:9/", allow_private=True) == "https://127.0.0.1:9/"
