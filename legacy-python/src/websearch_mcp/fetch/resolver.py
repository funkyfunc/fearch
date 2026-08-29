"""Fast paths for sources a coding agent hits constantly and that have a cleaner-than-HTML
representation: GitHub (raw files, READMEs, issues, gists), PyPI, npm, StackOverflow, arXiv,
and llms.txt. Each returns a `Fetched` with kind markdown/text, or None to fall through."""

from __future__ import annotations

import logging
import os
import re
from urllib.parse import urlsplit

import httpx

from .extract import html_snippet_to_markdown
from .transport import Fetched

log = logging.getLogger(__name__)

CODE_EXT = {
    "py": "python", "js": "javascript", "ts": "typescript", "tsx": "tsx", "jsx": "jsx", "rs": "rust",
    "go": "go", "java": "java", "kt": "kotlin", "swift": "swift", "rb": "ruby", "php": "php",
    "c": "c", "h": "c", "cpp": "cpp", "cc": "cpp", "hpp": "cpp", "cs": "csharp", "sh": "bash",
    "bash": "bash", "zsh": "bash", "yml": "yaml", "yaml": "yaml", "toml": "toml", "json": "json",
    "xml": "xml", "html": "html", "css": "css", "scss": "scss", "sql": "sql", "proto": "protobuf",
    "tf": "hcl", "dockerfile": "dockerfile", "lua": "lua", "ex": "elixir", "exs": "elixir",
    "scala": "scala", "hs": "haskell", "ml": "ocaml", "clj": "clojure", "dart": "dart", "r": "r",
    "jl": "julia", "zig": "zig", "nim": "nim", "vue": "vue", "svelte": "svelte", "ini": "ini",
    "cfg": "ini", "mk": "makefile", "makefile": "makefile", "gradle": "groovy", "ps1": "powershell",
}
TEXT_EXT = {"md", "mdx", "markdown", "rst", "txt", "adoc", "org"}


def _gh_headers(accept: str) -> dict[str, str]:
    h = {"Accept": accept, "User-Agent": "websearch-mcp/0.1 (+https://github.com)"}
    tok = os.environ.get("GITHUB_TOKEN")
    if tok:
        h["Authorization"] = f"Bearer {tok}"
    return h


def wrap_file(name: str, text: str) -> tuple[str, str]:
    """Return (kind, body): markdown-ish text verbatim, code fenced with a language."""
    ext = name.rsplit(".", 1)[-1].lower() if "." in name else name.lower()
    if ext in TEXT_EXT:
        return "markdown", text
    lang = CODE_EXT.get(ext, "")
    fence = "```"
    while fence in text:
        fence += "`"
    return "markdown", f"{fence}{lang}\n{text.rstrip()}\n{fence}\n"


async def _get(client: httpx.AsyncClient, url: str, headers: dict[str, str] | None = None) -> httpx.Response | None:
    try:
        r = await client.get(url, headers=headers, follow_redirects=True)
    except httpx.HTTPError as e:
        log.debug("fast path GET failed %s: %s", url, e)
        return None
    if r.status_code != 200:
        log.debug("fast path GET %s -> %s", url, r.status_code)
        return None
    return r


async def _github(url: str, parts, client: httpx.AsyncClient) -> Fetched | None:
    host = parts.netloc.lower()
    segs = [s for s in parts.path.split("/") if s]

    if host == "raw.githubusercontent.com" or host == "gist.githubusercontent.com":
        r = await _get(client, url)
        if r is None:
            return None
        kind, body = wrap_file(segs[-1] if segs else "", r.text)
        return Fetched(url, url, kind, body, "github-raw")

    if host == "gist.github.com" and len(segs) >= 2:
        r = await _get(client, f"https://api.github.com/gists/{segs[1]}", _gh_headers("application/vnd.github+json"))
        if r is None:
            return None
        data = r.json()
        out = [f"# Gist: {data.get('description') or segs[1]}"]
        for name, f in (data.get("files") or {}).items():
            content = f.get("content") or ""
            _, body = wrap_file(name, content)
            out.append(f"## {name}\n\n{body}")
        return Fetched(url, url, "markdown", "\n\n".join(out) + "\n", "github-gist")

    if host != "github.com" or len(segs) < 2:
        return None
    owner, repo = segs[0], segs[1]

    if len(segs) == 2:
        r = await _get(client, f"https://api.github.com/repos/{owner}/{repo}/readme", _gh_headers("application/vnd.github.raw+json"))
        if r is None:
            return None
        meta = await _get(client, f"https://api.github.com/repos/{owner}/{repo}", _gh_headers("application/vnd.github+json"))
        head = ""
        if meta is not None:
            m = meta.json()
            head = (
                f"# {m.get('full_name')}\n\n{m.get('description') or ''}\n\n"
                f"Stars: {m.get('stargazers_count')} · Language: {m.get('language')} · "
                f"Default branch: {m.get('default_branch')} · Updated: {str(m.get('pushed_at'))[:10]}\n\n---\n\n"
            )
        return Fetched(url, url, "markdown", head + r.text, "github-readme")

    if len(segs) >= 4 and segs[2] in {"blob", "raw"}:
        raw = f"https://raw.githubusercontent.com/{owner}/{repo}/{'/'.join(segs[3:])}"
        r = await _get(client, raw)
        if r is None:
            return None
        kind, body = wrap_file(segs[-1], r.text)
        return Fetched(url, url, kind, body, "github-raw")

    if len(segs) >= 4 and segs[2] in {"issues", "pull"} and segs[3].isdigit():
        num = segs[3]
        r = await _get(client, f"https://api.github.com/repos/{owner}/{repo}/issues/{num}", _gh_headers("application/vnd.github+json"))
        if r is None:
            return None
        issue = r.json()
        out = [
            f"# {issue.get('title')} (#{num})",
            (
                f"{owner}/{repo} · {issue.get('state')} · by {(issue.get('user') or {}).get('login')} · "
                f"{str(issue.get('created_at'))[:10]} · {issue.get('comments', 0)} comments"
            ),
            "",
            issue.get("body") or "(no description)",
        ]
        c = await _get(client, f"https://api.github.com/repos/{owner}/{repo}/issues/{num}/comments?per_page=15", _gh_headers("application/vnd.github+json"))
        if c is not None:
            for cm in c.json():
                out.append(f"\n---\n**{(cm.get('user') or {}).get('login')}** ({str(cm.get('created_at'))[:10]}):\n\n{cm.get('body') or ''}")
        return Fetched(url, url, "markdown", "\n".join(out) + "\n", "github-issue")

    return None


async def _pypi(parts, client: httpx.AsyncClient, url: str) -> Fetched | None:
    m = re.match(r"^/(?:project|pypi)/([^/]+)/?", parts.path)
    if not m:
        return None
    r = await _get(client, f"https://pypi.org/pypi/{m.group(1)}/json", {"Accept": "application/json"})
    if r is None:
        return None
    info = r.json().get("info") or {}
    urls = info.get("project_urls") or {}
    head = [
        f"# {info.get('name')} {info.get('version')}",
        info.get("summary") or "",
        "",
        f"Requires: {info.get('requires_python') or '?'} · License: {info.get('license') or '?'}",
        "Links: " + " · ".join(f"{k}: {v}" for k, v in list(urls.items())[:6]),
        "",
        "---",
        "",
    ]
    desc = info.get("description") or ""
    if (info.get("description_content_type") or "").startswith("text/x-rst"):
        desc = "(README is reStructuredText)\n\n" + desc
    return Fetched(url, url, "markdown", "\n".join(head) + desc + "\n", "pypi")


async def _npm(parts, client: httpx.AsyncClient, url: str) -> Fetched | None:
    m = re.match(r"^/package/((?:@[^/]+/)?[^/]+)", parts.path)
    if not m:
        return None
    r = await _get(client, f"https://registry.npmjs.org/{m.group(1)}", {"Accept": "application/json"})
    if r is None:
        return None
    data = r.json()
    latest = (data.get("dist-tags") or {}).get("latest")
    head = [
        f"# {data.get('name')} {latest or ''}",
        data.get("description") or "",
        "",
        f"Homepage: {data.get('homepage') or '?'} · Repo: {((data.get('repository') or {}).get('url') if isinstance(data.get('repository'), dict) else data.get('repository')) or '?'}",
        "",
        "---",
        "",
    ]
    return Fetched(url, url, "markdown", "\n".join(head) + (data.get("readme") or "(no README)") + "\n", "npm")


async def _stackoverflow(parts, client: httpx.AsyncClient, url: str) -> Fetched | None:
    m = re.match(r"^/(?:questions|q)/(\d+)", parts.path)
    if not m:
        return None
    qid = m.group(1)
    base = "https://api.stackexchange.com/2.3"
    q = await _get(client, f"{base}/questions/{qid}?site=stackoverflow&filter=withbody")
    if q is None:
        return None
    items = q.json().get("items") or []
    if not items:
        return None
    qi = items[0]
    out = [
        f"# {html_snippet_to_markdown(qi.get('title') or '').strip()}",
        f"Score {qi.get('score')} · {qi.get('answer_count')} answers · tags: {', '.join(qi.get('tags') or [])}",
        "",
        html_snippet_to_markdown(qi.get("body") or ""),
    ]
    a = await _get(client, f"{base}/questions/{qid}/answers?site=stackoverflow&order=desc&sort=votes&filter=withbody&pagesize=4")
    if a is not None:
        answers = a.json().get("items") or []
        answers.sort(key=lambda x: (not x.get("is_accepted"), -x.get("score", 0)))
        for ans in answers:
            tag = "Accepted answer" if ans.get("is_accepted") else "Answer"
            out.append(f"\n---\n## {tag} (score {ans.get('score')})\n\n{html_snippet_to_markdown(ans.get('body') or '')}")
    return Fetched(url, url, "markdown", "\n".join(out) + "\n", "stackoverflow")


def rewrite_url(url: str) -> str:
    """Cheap URL rewrites that yield a better representation of the same content."""
    parts = urlsplit(url)
    host = parts.netloc.lower()
    if host in {"arxiv.org", "www.arxiv.org"}:
        # Canonical abstract page; /pdf/ URLs are left alone (they go through the PDF path).
        m = re.match(r"^/abs/([\w.]+?)(?:v\d+)?/?$", parts.path)
        if m:
            return f"https://arxiv.org/abs/{m.group(1)}"
    return url


async def resolve_fast_path(url: str, client: httpx.AsyncClient) -> Fetched | None:
    parts = urlsplit(url)
    host = parts.netloc.lower()
    try:
        if host.endswith(("github.com", "githubusercontent.com")):
            return await _github(url, parts, client)
        if host in {"pypi.org", "www.pypi.org"}:
            return await _pypi(parts, client, url)
        if host in {"www.npmjs.com", "npmjs.com"}:
            return await _npm(parts, client, url)
        if host in {"stackoverflow.com", "www.stackoverflow.com"}:
            return await _stackoverflow(parts, client, url)
    except Exception as e:  # noqa: BLE001 — fast paths are best-effort
        log.warning("fast path failed for %s: %s", url, e)
    return None


_llms_cache: dict[str, str | None] = {}


async def llms_txt(url: str, client: httpx.AsyncClient) -> str | None:
    """Return the site's /llms.txt content if it exists (cached per origin)."""
    parts = urlsplit(url)
    origin = f"{parts.scheme}://{parts.netloc}"
    if origin in _llms_cache:
        return _llms_cache[origin]
    r = await _get(client, f"{origin}/llms.txt", {"Accept": "text/plain, text/markdown"})
    text = None
    if r is not None:
        ct = r.headers.get("content-type", "")
        body = r.text
        if "html" not in ct and "<html" not in body[:500].lower() and len(body.strip()) > 50:
            text = body
    _llms_cache[origin] = text
    return text
