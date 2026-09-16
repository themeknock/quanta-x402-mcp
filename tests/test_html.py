"""Raw-HTML checks, against hand-written fixtures.

The rule these tests enforce: Quanta reads the HTML the server sent and says so.
It never reports "missing viewport" - it reports "not present in the raw HTML",
because plenty of sites inject that tag with JavaScript and we do not run any.
"""
from __future__ import annotations

from pathlib import Path

import pytest

from app.checks import html as html_check
from app.checks.verdict import CATALOG, grade_for, score

FIXTURES = Path(__file__).parent / "fixtures"


def load(name: str) -> bytes:
    return (FIXTURES / name).read_bytes()


def parse(name: str, url: str = "https://northgate.example/"):
    return html_check.parse(load(name), final_url=url, content_type="text/html")


def test_raw_html_only_is_always_stated():
    for name in ["mixed_content.html", "no_viewport.html", "many_stylesheets.html"]:
        assert parse(name)["checked"] == "raw_html_only"


def test_truncated_body_says_so():
    out = html_check.parse(load("no_viewport.html"), final_url="https://x.example/",
                           content_type="text/html", truncated=True)
    assert out["checked"] == "truncated_2mb"


def test_title_and_viewport_are_read():
    out = parse("mixed_content.html")
    assert out["title"] == {"present": True, "text": "Northgate Home Services"}
    assert out["viewport"]["present"] is True


def test_missing_viewport_is_reported_as_absent_from_raw_html():
    out = parse("no_viewport.html")
    assert out["viewport"] == {"present": False}
    assert out["title"]["present"] is True

    verdict = score(["NO_VIEWPORT_IN_RAW_HTML"])
    issue = verdict["issues"][0]
    assert issue["code"].endswith("_IN_RAW_HTML")
    assert "not checked in a browser" in issue["note"]


def test_missing_title_is_found():
    out = parse("no_title.html")
    assert out["title"] == {"present": False}


def test_mixed_content_is_strict():
    out = parse("mixed_content.html")
    mixed = out["mixed_content"]
    # img + iframe + script + one stylesheet link = 4.
    # The http <a href> and the http rel=preload link do NOT count: a browser
    # does not block either one.
    assert mixed["count"] == 4
    assert sorted(mixed["samples"]) == [
        "http://cdn.example.com/analytics.js",
        "http://cdn.example.com/legacy.css",
        "http://images.example.com/van.jpg",
        "http://maps.example.com/embed",
    ]


def test_http_pages_have_no_mixed_content():
    out = parse("mixed_content.html", url="http://northgate.example/")
    assert out["mixed_content"]["count"] == 0


def test_asset_counts():
    out = parse("many_stylesheets.html")
    assert out["stylesheets"] == 40
    assert out["scripts"] == 2          # one external, one inline
    assert out["mixed_content"]["count"] == 0


def test_non_html_is_not_parsed_as_html():
    out = html_check.parse(b'{"ok":true}', final_url="https://api.example/x",
                           content_type="application/json")
    assert out["checked"] == "not_html"
    assert out["title"]["present"] is False


def test_samples_are_capped():
    body = b"<html><body>" + b"".join(
        f'<img src="http://cdn.example.com/{i}.jpg">'.encode() for i in range(20)
    ) + b"</body></html>"
    out = html_check.parse(body, final_url="https://x.example/", content_type="text/html")
    assert out["mixed_content"]["count"] == 20
    assert len(out["mixed_content"]["samples"]) == html_check.MAX_SAMPLES


# --- the score is arithmetic, not opinion ---------------------------------

def test_score_is_100_minus_the_weights():
    assert score([])["score"] == 100
    assert score([])["grade"] == "A"
    # medium 12 + low 8 + low 8
    out = score(["NO_VIEWPORT_IN_RAW_HTML", "NO_CSP", "NO_X_FRAME_OPTIONS"])
    assert out["score"] == 72
    assert out["grade"] == "C"
    assert [i["code"] for i in out["issues"]] == [
        "NO_VIEWPORT_IN_RAW_HTML", "NO_CSP", "NO_X_FRAME_OPTIONS"]


def test_score_never_goes_below_zero():
    assert score(list(CATALOG))["score"] == 0
    assert score(list(CATALOG))["grade"] == "F"


@pytest.mark.parametrize("value,expected", [(100, "A"), (90, "A"), (89, "B"), (80, "B"),
                                            (79, "C"), (70, "C"), (69, "D"), (60, "D"),
                                            (59, "F"), (0, "F")])
def test_grade_boundaries(value, expected):
    assert grade_for(value) == expected


def test_every_catalogued_issue_has_a_known_weight():
    for code, (severity, _) in CATALOG.items():
        assert severity in {"high", "medium", "low"}, code
