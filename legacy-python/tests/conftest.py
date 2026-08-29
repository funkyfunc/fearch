from __future__ import annotations

import pathlib

import pytest

FIXTURES = pathlib.Path(__file__).parent / "fixtures"


@pytest.fixture
def fixture_html():
    def load(name: str) -> str:
        return (FIXTURES / "html" / name).read_text()

    return load


def all_html_fixtures() -> list[str]:
    return sorted(p.name for p in (FIXTURES / "html").glob("*.html"))
