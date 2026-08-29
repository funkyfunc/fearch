"""Character budgeting with paragraph-boundary cuts and explicit continuation markers."""

from __future__ import annotations

from dataclasses import dataclass


@dataclass
class Window:
    text: str
    start: int
    end: int
    total: int

    @property
    def truncated(self) -> bool:
        return self.end < self.total

    def footer(self) -> str:
        if not self.truncated:
            return ""
        return (
            f"[Showing chars {self.start}–{self.end} of {self.total}. "
            f"Continue with start_index={self.end}, or use focus=/section= to jump to what you need.]"
        )


def apply_budget(text: str, start_index: int = 0, max_chars: int = 12_000) -> Window:
    total = len(text)
    start = max(0, min(start_index, total))
    if start >= total > 0:
        return Window("", start, total, total)
    hard_end = min(total, start + max_chars)
    if hard_end >= total:
        return Window(text[start:], start, total, total)
    # Prefer cutting at a blank line, then a newline, within the last 25% of the window.
    floor = start + int(max_chars * 0.75)
    cut = text.rfind("\n\n", floor, hard_end)
    if cut == -1:
        cut = text.rfind("\n", floor, hard_end)
    if cut == -1 or cut <= start:
        cut = hard_end
    # Don't cut inside a fenced code block: if fences are unbalanced, back up to the last opener.
    chunk = text[start:cut]
    if chunk.count("```") % 2 == 1:
        last_fence = chunk.rfind("```")
        if last_fence > 0:
            cut = start + last_fence
            chunk = text[start:cut]
    return Window(chunk.rstrip("\n") + "\n", start, cut, total)
