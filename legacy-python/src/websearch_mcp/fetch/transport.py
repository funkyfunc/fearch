"""HTTP transport: curl_cffi with Chrome TLS impersonation, plus the fallback ladder
(direct -> r.jina.ai -> Wayback Machine) for blocked or JS-shell pages."""

from __future__ import annotations

import json
import logging
import re
from collections.abc import Callable
from dataclasses import dataclass
from urllib.parse import quote

from curl_cffi import AsyncSession
from curl_cffi.requests.exceptions import RequestException

from ..config import Settings

log = logging.getLogger(__name__)

ACCEPT_HEADER = (
    "text/markdown;q=1.0, text/x-markdown;q=0.9, text/plain;q=0.8, "
    "text/html;q=0.7, application/xhtml+xml;q=0.6, application/pdf;q=0.5, */*;q=0.1"
)

BLOCK_STATUSES = {401, 403, 405, 406, 409, 429, 500, 502, 503, 520, 521, 522, 523, 524, 525, 526, 530}

CHALLENGE_PATTERNS = re.compile(
    r"(cf-browser-verification|cf_chl_|Just a moment\.\.\.|Checking your browser|"
    r"Attention Required! \| Cloudflare|challenge-platform|_Incapsula_Resource|"
    r"Please enable JavaScript and cookies|Access denied|DDoS protection by|"
    r"perimeterx|px-captcha|datadome|hcaptcha\.com|recaptcha/api\.js|Verify you are human)",
    re.IGNORECASE,
)


class FetchError(Exception):
    pass


@dataclass
class Fetched:
    url: str
    final_url: str
    kind: str  # html | markdown | text | pdf | json
    body: bytes | str
    source: str
    status: int = 200
    content_type: str = ""

    @property
    def text(self) -> str:
        if isinstance(self.body, str):
            return self.body
        return self.body.decode("utf-8", "replace")


def classify(content_type: str, body: bytes, url: str) -> str:
    ct = (content_type or "").split(";")[0].strip().lower()
    if ct in {"text/markdown", "text/x-markdown"}:
        return "markdown"
    if ct == "application/pdf" or (not ct and url.lower().endswith(".pdf")) or body[:5] == b"%PDF-":
        return "pdf"
    if ct == "application/json":
        return "json"
    if ct.startswith("text/plain"):
        head = body[:4000].decode("utf-8", "replace")
        if re.search(r"^#{1,6} |^```|^\* |^- ", head, re.MULTILINE):
            return "markdown"
        return "text"
    if ct in {"text/html", "application/xhtml+xml"} or b"<html" in body[:2000].lower() or b"<!doctype" in body[:200].lower():
        return "html"
    if ct.startswith("text/"):
        return "text"
    return "html"


def looks_challenged(status: int, body: str) -> bool:
    if status in BLOCK_STATUSES:
        return True
    return bool(CHALLENGE_PATTERNS.search(body[:20000]))


class Transport:
    def __init__(self, settings: Settings):
        self.settings = settings
        self._session: AsyncSession | None = None

    def _get_session(self) -> AsyncSession:
        if self._session is None:
            kwargs: dict = {
                "impersonate": self.settings.impersonate,
                "timeout": self.settings.timeout,
                "allow_redirects": True,
                "max_redirects": 6,
            }
            if self.settings.proxy:
                kwargs["proxy"] = self.settings.proxy
            self._session = AsyncSession(**kwargs)
        return self._session

    async def close(self) -> None:
        if self._session is not None:
            await self._session.close()
            self._session = None

    async def get(self, url: str, headers: dict[str, str] | None = None, source: str = "direct") -> Fetched:
        hdrs = {
            "Accept": ACCEPT_HEADER,
            "Accept-Language": "en-US,en;q=0.9",
            "Upgrade-Insecure-Requests": "1",
        }
        if headers:
            hdrs.update(headers)
        session = self._get_session()
        try:
            resp = await session.get(url, headers=hdrs)
        except RequestException as e:
            # https upgrade may have broken a plain-http-only host; retry once.
            if url.startswith("https://"):
                try:
                    resp = await session.get("http://" + url[len("https://"):], headers=hdrs)
                except RequestException as e2:
                    raise FetchError(f"{source}: connection failed ({e2})") from e2
            else:
                raise FetchError(f"{source}: connection failed ({e})") from e
        body = resp.content or b""
        ct = resp.headers.get("content-type", "")
        return Fetched(
            url=url,
            final_url=str(resp.url) or url,
            kind=classify(ct, body, str(resp.url) or url),
            body=body,
            source=source,
            status=resp.status_code,
            content_type=ct,
        )

    # -- fallbacks -----------------------------------------------------------

    async def via_jina(self, url: str) -> Fetched:
        headers = {"Accept": "text/plain", "X-Return-Format": "markdown"}
        if self.settings.jina_api_key:
            headers["Authorization"] = f"Bearer {self.settings.jina_api_key}"
        f = await self.get(f"https://r.jina.ai/{url}", headers=headers, source="jina")
        if f.status != 200:
            raise FetchError(f"jina: HTTP {f.status}")
        text = f.text
        if len(text.strip()) < 100:
            raise FetchError("jina: empty response")
        return Fetched(url=url, final_url=url, kind="markdown", body=text, source="jina", status=200)

    async def via_wayback(self, url: str) -> Fetched:
        avail = await self.get(
            f"https://archive.org/wayback/available?url={quote(url, safe='')}",
            headers={"Accept": "application/json"},
            source="wayback",
        )
        if avail.status != 200:
            raise FetchError(f"wayback: availability API HTTP {avail.status}")
        try:
            data = json.loads(avail.text)
            snap = data["archived_snapshots"]["closest"]
            snap_url: str = snap["url"]
            ts: str = snap["timestamp"]
        except (ValueError, KeyError, TypeError) as e:
            raise FetchError("wayback: no snapshot") from e
        # `id_` returns the original page without the Wayback toolbar injected.
        raw_url = snap_url.replace(f"/web/{ts}/", f"/web/{ts}id_/", 1)
        f = await self.get(raw_url, source="wayback")
        if f.status != 200:
            raise FetchError(f"wayback: snapshot HTTP {f.status}")
        f.url = url
        f.final_url = url
        f.source = f"wayback ({ts[:8]})"
        return f

    async def fetch_with_fallbacks(self, url: str, is_shell: Callable[[Fetched], bool]) -> Fetched:
        """Direct fetch; on block/challenge/JS-shell fall through to Jina, then Wayback."""
        attempts: list[str] = []
        try:
            f = await self.get(url)
            if f.status == 404:
                raise FetchError("direct: HTTP 404 Not Found")
            if f.status == 410:
                raise FetchError("direct: HTTP 410 Gone")
            challenged = looks_challenged(f.status, f.text[:20000] if f.kind in {"html", "text"} else "")
            if not challenged and not (f.kind == "html" and is_shell(f)):
                return f
            attempts.append(
                f"direct: HTTP {f.status}" + (" (bot challenge)" if challenged else " (empty/JS-rendered shell)")
            )
        except FetchError as e:
            if "404" in str(e) or "410" in str(e):
                raise
            attempts.append(str(e))

        for name, fn in (("jina", self.via_jina), ("wayback", self.via_wayback)):
            try:
                f = await fn(url)
                log.info("fetched %s via %s", url, name)
                return f
            except FetchError as e:
                attempts.append(str(e))
            except Exception as e:  # noqa: BLE001
                attempts.append(f"{name}: {type(e).__name__}: {e}")

        raise FetchError(
            "Could not fetch page. Tried: " + "; ".join(attempts)
            + ". Try a different URL, or search with `site:` for an alternative source."
        )
