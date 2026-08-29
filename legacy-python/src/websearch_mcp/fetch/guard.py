"""SSRF guard: refuse private/loopback/link-local/metadata targets unless explicitly allowed."""

from __future__ import annotations

import asyncio
import ipaddress
import socket
from urllib.parse import urlsplit, urlunsplit


class BlockedURL(Exception):
    pass


def _is_private(ip: str) -> bool:
    try:
        addr = ipaddress.ip_address(ip)
    except ValueError:
        return True
    return (
        addr.is_private
        or addr.is_loopback
        or addr.is_link_local
        or addr.is_reserved
        or addr.is_multicast
        or addr.is_unspecified
    )


def normalize_url(url: str) -> str:
    """Add a scheme if missing, upgrade http -> https, drop fragments."""
    url = url.strip()
    if not url:
        raise BlockedURL("Empty URL.")
    if "://" not in url:
        url = "https://" + url
    parts = urlsplit(url)
    scheme = parts.scheme.lower()
    if scheme not in {"http", "https"}:
        raise BlockedURL(f"Unsupported URL scheme: {scheme!r}. Only http(s) is allowed.")
    if scheme == "http":
        scheme = "https"
    if not parts.netloc:
        raise BlockedURL(f"URL has no host: {url!r}")
    return urlunsplit((scheme, parts.netloc, parts.path or "/", parts.query, ""))


async def check_url(url: str, allow_private: bool = False) -> str:
    """Validate and normalize a URL. Resolves the host and rejects private ranges."""
    url = normalize_url(url)
    if allow_private:
        return url
    host = urlsplit(url).hostname or ""
    if host in {"localhost", "metadata.google.internal"} or host.endswith((".local", ".internal")):
        raise BlockedURL(f"Refusing to fetch private host {host!r} (set WEBSEARCH_ALLOW_PRIVATE=1 to allow).")
    try:
        infos = await asyncio.to_thread(socket.getaddrinfo, host, None, proto=socket.IPPROTO_TCP)
    except socket.gaierror as e:
        raise BlockedURL(f"DNS resolution failed for {host!r}: {e}") from e
    for info in infos:
        ip = info[4][0]
        if _is_private(ip):
            raise BlockedURL(
                f"Refusing to fetch {host!r}: resolves to private/internal address {ip} "
                "(set WEBSEARCH_ALLOW_PRIVATE=1 to allow)."
            )
    return url
