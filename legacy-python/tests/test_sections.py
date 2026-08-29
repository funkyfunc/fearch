from __future__ import annotations

from websearch_mcp.fetch.sections import (
    clean_title,
    find_section,
    focus_sections,
    join_sections,
    render_outline,
    split_sections,
)

DOC = """Preamble text about the library.

# Guide

Intro to the guide.

## Installation

pip install thing

```bash
# this is a comment, not a heading
## neither is this
```

## Configuration

Set retries and timeouts in the config file.

### Retries

client = Client(retries=3)

### Timeouts

Timeouts are separate from retries.

## Deployment

Deploy with docker.
"""


def test_split_is_fence_aware():
    secs = split_sections(DOC)
    titles = [s.title for s in secs]
    assert titles == ["(intro)", "Guide", "Installation", "Configuration", "Retries", "Timeouts", "Deployment"]
    assert [s.level for s in secs] == [0, 1, 2, 2, 3, 3, 2]
    # offsets are exact slices of the source
    for s in secs:
        assert DOC[s.start:s.end].strip("\n") == s.text.strip("\n")


def test_find_section_fuzzy_and_subtree():
    secs = split_sections(DOC)
    sub = find_section(secs, "configuration")
    assert [s.title for s in sub] == ["Configuration", "Retries", "Timeouts"]
    assert [s.title for s in find_section(secs, "Deploy")] == ["Deployment"]
    assert [s.title for s in find_section(secs, "instalation")] == ["Installation"]  # typo
    assert find_section(secs, "nonexistent zzz") is None


def test_focus_ranks_relevant_sections():
    secs = split_sections(DOC)
    chosen = focus_sections(secs, "how do I set retries", budget=200)
    titles = [s.title for s in chosen]
    assert "Retries" in titles
    assert "Deployment" not in titles
    # document order preserved
    idx = [s.index for s in chosen]
    assert idx == sorted(idx)


def test_outline_and_join():
    secs = split_sections(DOC)
    shown = {s.index for s in secs if s.title in {"Retries"}}
    out = render_outline(secs, shown)
    assert out.startswith("Sections not shown: ")
    assert "Retries" not in out and "Deployment" in out
    assert join_sections(secs[:2]).startswith("Preamble")


def test_clean_title():
    assert clean_title("[Running tasks](#id8)") == "Running tasks"
    assert clean_title("**Bold** `code` ¶") == "Bold code"
