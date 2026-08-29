from __future__ import annotations

from websearch_mcp.fetch.budget import apply_budget
from websearch_mcp.fetch.render import apply_link_mode, render_page

MD = """[![Build](https://img.shields.io/x.svg)](https://ci.example.com) ![logo](https://x/logo.png) ![Diagram of flow](https://x/d.png)

See [the docs](https://example.com/docs "Docs") and [this](#anchor).

```python
print("[not a link](http://x)")
```
"""


def test_strip_links_by_default():
    body, footer = apply_link_mode(MD, include_links=False)
    assert footer == ""
    assert "See the docs and this." in body
    assert "shields.io" not in body and "logo.png" not in body
    assert "[image: Diagram of flow]" in body
    assert 'print("[not a link](http://x)")' in body  # code untouched


def test_reference_links():
    body, footer = apply_link_mode(MD, include_links=True)
    assert "[the docs][1]" in body
    assert "this." in body and "[this][" not in body  # in-page anchors dropped
    assert footer == "Links:\n[1]: https://example.com/docs"


def test_render_page_layout():
    w = apply_budget("body text\n\nmore", 0, 12)
    out = render_page(title="T", url="https://e.com", source="direct", window=w, outline="Sections not shown: A · B")
    assert out.startswith("# T\nURL: https://e.com\nSource: direct\nChars 0–")
    assert "Untrusted page content" in out
    assert "Sections not shown: A · B" in out
    assert "Continue with start_index=" in out
