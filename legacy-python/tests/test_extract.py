from __future__ import annotations

import math
import re

import pytest
from conftest import all_html_fixtures

from websearch_mcp.fetch.extract import (
    _fence_count,
    clean_markdown_source,
    detect_shell,
    html_to_markdown,
    split_frontmatter,
)

SYNTHETIC = """<html><head><title>Retries — Lib Docs</title></head><body>
<header><nav><a href=/a>A</a><a href=/b>B</a><a href=/c>C</a></nav></header>
<aside class="sidebar"><ul><li>Sidebar item</li></ul></aside>
<main>
<h1>Retries<a class="headerlink" href="#retries">¶</a></h1>
<p>Intro paragraph about the library. It is long enough to count as content for the extractor guard,
hopefully more than two hundred characters when combined with the rest of the page text here.</p>
<h2><a class="toc-backref" href="#id1">Configuration</a></h2>
<p>Set <code>retries</code> like so:</p>
<pre><code class="language-python">client = Client(retries=3)
print("hi")</code></pre>
<h2>Timeouts</h2><p>Timeouts are separate.</p>
<pre><code>curl -m 5 https://x</code></pre>
<table><tr><th>Option</th><th>Default</th></tr><tr><td>retries</td><td>0</td></tr></table>
<div class="cookie-banner">Accept cookies</div>
<div id="comments">Comment spam</div>
<img src="x.png" alt="diagram">
</main>
<footer>© 2026 Footer text</footer>
</body></html>"""


def test_synthetic_main_extraction():
    ex = html_to_markdown(SYNTHETIC, "https://example.com/docs")
    md = ex.markdown
    assert ex.method == "main"
    assert ex.title == "Retries — Lib Docs"
    assert "# Retries" in md and "¶" not in md
    assert "## Configuration" in md  # toc-backref anchor unwrapped, not decomposed
    assert "```python\nclient = Client(retries=3)" in md
    assert "```\ncurl -m 5 https://x\n```" in md
    assert "| Option | Default |" in md
    for noise in ("Sidebar item", "Accept cookies", "Comment spam", "Footer text", "x.png"):
        assert noise not in md


def test_shell_detection():
    assert detect_shell("<html><body><div id='root'></div><script>app()</script></body></html>")
    assert detect_shell("<html><body><p>You need to enable JavaScript to run this app.</p></body></html>")
    assert not detect_shell(SYNTHETIC)


def test_clean_markdown_source_fences_and_mdx():
    src = "```python theme={\"a\":1}\nx = 1\n```\n\n<VersionBadge version=\"2\" />\n## Heading {/*anchor*/}\n\nIf text\n"
    out = clean_markdown_source(src)
    assert out.startswith("```python\nx = 1\n```")
    assert "VersionBadge" not in out
    assert "## Heading\n" in out
    assert "If text" in out


def test_clean_markdown_does_not_eat_code_first_line():
    src = "Example:\n\n```\nasync with timeout(10):\n    pass\n```\n\nIf the manager"
    out = clean_markdown_source(src)
    assert "```\nasync with timeout(10):" in out
    assert "```\n\nIf the manager" in out


def test_frontmatter():
    meta, body = split_frontmatter("---\ntitle: \"Workers\"\nkind: doc\n---\n# Body\n")
    assert meta["title"] == "Workers"
    assert body == "# Body\n"
    assert split_frontmatter("# no fm\n") == ({}, "# no fm\n")


@pytest.mark.parametrize("name", all_html_fixtures())
def test_real_pages_keep_code_and_drop_chrome(fixture_html, name):
    html = fixture_html(name)
    ex = html_to_markdown(html, "https://example.com/" + name)
    md = ex.markdown
    pre_total = html.count("<pre")
    assert len(md) > 1500, name
    assert ex.title, name
    # code-block retention guard (the property heuristic extractors fail)
    assert _fence_count(md) >= math.ceil(0.8 * pre_total), (name, _fence_count(md), pre_total)
    assert "Skip to content" not in md, name
    assert not re.search(r"^#{1,6} .*[¶#]\s*$", md, re.MULTILINE), name
    headings = "\n".join(re.findall(r"^#{1,6} .*$", md, re.MULTILINE))
    assert "](#" not in headings, name  # no links in headings
