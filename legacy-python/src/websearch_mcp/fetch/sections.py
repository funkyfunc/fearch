"""Heading-aware sectioning, section lookup, and BM25 focus ranking (no LLM, no embeddings)."""

from __future__ import annotations

import difflib
import re
from dataclasses import dataclass, field

from rank_bm25 import BM25Okapi

HEADING_RE = re.compile(r"^(#{1,6})\s+(.*?)\s*#*\s*$")
MD_LINK_RE = re.compile(r"\[([^\]]*)\]\([^)]*\)")
MD_INLINE_RE = re.compile(r"[*_`]+")
FENCE_RE = re.compile(r"^\s*(`{3,}|~{3,})")
TOKEN_RE = re.compile(r"[a-z0-9_]+(?:[.-][a-z0-9_]+)*")


@dataclass
class Section:
    level: int
    title: str
    path: tuple[str, ...]
    text: str
    start: int
    end: int
    index: int = field(default=0)

    @property
    def has_code(self) -> bool:
        return "```" in self.text


def clean_title(raw: str) -> str:
    """Heading text without link/emphasis markup, for outlines and matching."""
    t = MD_LINK_RE.sub(r"\1", raw)
    t = MD_INLINE_RE.sub("", t)
    return re.sub(r"\s+", " ", t).strip(" ¶#")


def split_sections(md: str) -> list[Section]:
    """Split markdown into heading-delimited sections; fenced code is never split."""
    lines = md.split("\n")
    sections: list[Section] = []
    in_fence = False
    fence_marker = ""
    cur_level = 0
    cur_title = "(intro)"
    cur_lines: list[str] = []
    cur_start = 0
    pos = 0
    stack: list[tuple[int, str]] = []

    def flush(end: int) -> None:
        text = "\n".join(cur_lines).strip("\n")
        if text.strip() or sections:
            path = tuple(t for _, t in stack) if stack else (cur_title,)
            sections.append(Section(cur_level, cur_title, path, text, cur_start, end, len(sections)))

    for line in lines:
        m_fence = FENCE_RE.match(line)
        if m_fence:
            marker = m_fence.group(1)
            if not in_fence:
                in_fence, fence_marker = True, marker[0] * 3
            elif line.strip().startswith(fence_marker):
                in_fence = False
        m = None if in_fence else HEADING_RE.match(line)
        if m:
            flush(pos)
            cur_level = len(m.group(1))
            cur_title = clean_title(m.group(2)) or "(untitled)"
            while stack and stack[-1][0] >= cur_level:
                stack.pop()
            stack.append((cur_level, cur_title))
            cur_lines = [line]
            cur_start = pos
        else:
            cur_lines.append(line)
        pos += len(line) + 1
    flush(len(md))
    if not sections:
        sections.append(Section(0, "(intro)", ("(intro)",), md, 0, len(md), 0))
    return sections


def subtree(sections: list[Section], idx: int) -> list[Section]:
    root = sections[idx]
    out = [root]
    for s in sections[idx + 1:]:
        if s.level <= root.level and root.level > 0:
            break
        out.append(s)
    return out


def find_section(sections: list[Section], name: str) -> list[Section] | None:
    """Fuzzy-match a heading; returns the section plus its nested subsections."""
    target = name.strip().lower()
    if not target:
        return None
    titles = [s.title.lower() for s in sections]
    for i, t in enumerate(titles):
        if t == target:
            return subtree(sections, i)
    for i, t in enumerate(titles):
        if target in t or t in target and len(t) > 3:
            return subtree(sections, i)
    match = difflib.get_close_matches(target, titles, n=1, cutoff=0.6)
    if match:
        return subtree(sections, titles.index(match[0]))
    return None


def tokenize(text: str) -> list[str]:
    return TOKEN_RE.findall(text.lower())


def focus_sections(sections: list[Section], query: str, budget: int) -> list[Section]:
    """Rank sections by BM25 relevance to `query`; return the best ones (in document order)
    whose combined length fits `budget`. Always returns at least one section."""
    q = tokenize(query)
    if not q or len(sections) == 1:
        return sections[:1]
    corpus = [tokenize(" ".join([s.title] * 3 + [" ".join(s.path), s.text])) for s in sections]
    bm25 = BM25Okapi(corpus)
    scores = bm25.get_scores(q)
    ranked: list[tuple[float, Section]] = []
    for s, score in zip(sections, scores):
        boost = 1.0
        if 1 <= s.level <= 2:
            boost *= 1.3
        if s.has_code:
            boost *= 1.2
        if s.level == 0 and len(s.text) < 400:
            boost *= 0.8
        ranked.append((float(score) * boost, s))
    ranked.sort(key=lambda t: t[0], reverse=True)
    chosen: list[Section] = []
    used = 0
    for score, s in ranked:
        if score <= 0 and chosen:
            break
        n = len(s.text)
        if chosen and used + n > budget:
            continue
        chosen.append(s)
        used += n
        if used >= budget:
            break
    chosen.sort(key=lambda s: s.index)
    return chosen


def render_outline(sections: list[Section], shown: set[int], limit: int = 40) -> str:
    titles = [s.title for s in sections if s.index not in shown and s.level > 0]
    if not titles:
        return ""
    extra = f" (+{len(titles) - limit} more)" if len(titles) > limit else ""
    return "Sections not shown: " + " · ".join(titles[:limit]) + extra


def join_sections(chosen: list[Section]) -> str:
    return "\n\n".join(s.text for s in chosen).strip() + "\n"
