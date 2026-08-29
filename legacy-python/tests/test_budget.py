from __future__ import annotations

from websearch_mcp.fetch.budget import apply_budget

TEXT = "para one\n\npara two\n\n```py\ncode line 1\ncode line 2\n```\n\npara three\n\npara four"


def test_cuts_at_paragraph_boundary():
    w = apply_budget(TEXT, 0, 30)
    assert w.text == "para one\n\npara two\n"
    assert w.end == 20 and w.total == len(TEXT) and w.truncated
    assert "start_index=20" in w.footer()


def test_does_not_split_fenced_code():
    w = apply_budget(TEXT, 0, 45)  # would land inside the code block
    assert w.text.count("```") % 2 == 0


def test_continuation_is_deterministic_and_complete():
    pieces, start = [], 0
    while True:
        w = apply_budget(TEXT, start, 25)
        pieces.append(w.text)
        if not w.truncated:
            break
        start = w.end
    joined = "".join(p.rstrip("\n") + "\n" for p in pieces)
    assert joined.replace("\n", "") == TEXT.replace("\n", "")


def test_start_index_past_end():
    w = apply_budget(TEXT, 10_000, 100)
    assert w.text == "" and not w.truncated and w.footer() == ""


def test_no_truncation_when_fits():
    w = apply_budget("short", 0, 100)
    assert w.text == "short" and not w.truncated
