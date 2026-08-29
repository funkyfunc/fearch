"""Render search results as compact markdown (cheaper for the model than JSON)."""

from __future__ import annotations

from .backend import SearchResult


def render_results(query: str, results: list[SearchResult], engines_used: list[str]) -> str:
    via = ", ".join(engines_used) if engines_used else "none"
    lines = [f'Results for "{query}" ({len(results)}, via {via}):', ""]
    for i, r in enumerate(results, start=1):
        title = r.title or r.url
        lines.append(f"{i}. **{title}** — {r.url}")
        if r.snippet:
            lines.append(f"   {r.snippet}")
        if r.excerpt:
            excerpt = "\n".join(f"   > {ln}" if ln.strip() else "   >" for ln in r.excerpt.splitlines())
            lines.append(excerpt)
        lines.append("")
    lines.append("Use `fetch(url=...)` to read a result in full; add `focus=` to get only the relevant sections.")
    return "\n".join(lines).rstrip() + "\n"
