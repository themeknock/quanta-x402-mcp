"""Certificate parsing and the header check.

The parsing helpers are tested against certificate dicts in the exact shape
Python's ssl module hands back, so no network is needed. One test does reach
badssl.com to prove the strict handshake actually fails on a bad certificate -
it is marked `network` and skipped when the machine is offline.
"""
from __future__ import annotations

import asyncio
import socket
from datetime import datetime, timedelta, timezone

import pytest

from app.checks import headers as header_check
from app.checks import tls as tls_check
from app.checks.verdict import issues_for, score


def run(coro):
    return asyncio.run(coro)


def cert_for(host: str, *, days: int = 60, issuer: str = "Let's Encrypt",
             sans: list[str] | None = None) -> dict:
    not_after = datetime.now(timezone.utc) + timedelta(days=days)
    return {
        "notAfter": not_after.strftime("%b %d %H:%M:%S %Y GMT"),
        "issuer": ((("countryName", "US"),), (("organizationName", issuer),)),
        "subject": ((("commonName", host),),),
        "subjectAltName": tuple(("DNS", name) for name in ([host] if sans is None else sans)),
    }


def test_issuer_is_read_from_the_organization_name():
    assert tls_check._name_field(cert_for("x.example")["issuer"], "organizationName") == "Let's Encrypt"


def test_not_after_parses_openssl_format():
    parsed = tls_check._parse_not_after("Oct 27 23:59:59 2026 GMT")
    assert parsed == datetime(2026, 10, 27, 23, 59, 59, tzinfo=timezone.utc)
    assert tls_check._parse_not_after("not a date") is None
    assert tls_check._parse_not_after("") is None


@pytest.mark.parametrize("host,sans,expected", [
    ("example.com", ["example.com"], True),
    ("example.com", ["www.example.com"], False),
    ("www.example.com", ["*.example.com"], True),
    ("example.com", ["*.example.com"], False),          # a wildcard does not cover the apex
    ("a.b.example.com", ["*.example.com"], False),      # nor a deeper label
    ("EXAMPLE.com", ["example.com"], True),             # case insensitive
    ("example.com", [], False),
])
def test_san_matching(host, sans, expected):
    assert tls_check._san_matches(cert_for(host, sans=sans), host) is expected


def test_unreachable_host_returns_a_reason_not_an_exception(monkeypatch):
    def boom(*args, **kwargs):
        raise socket.timeout()

    monkeypatch.setattr(tls_check, "_handshake", boom)
    out = run(tls_check.check("unreachable.example"))
    assert out["ok"] is False
    assert out["error"] == "timeout"
    assert out["days_left"] is None


def test_no_host_is_handled():
    out = run(tls_check.check(""))
    assert out["ok"] is False and out["error"] == "no_host"


# --- security headers -----------------------------------------------------

def test_headers_presence_is_case_insensitive():
    out = header_check.read({"Strict-Transport-Security": "max-age=63072000",
                             "X-Content-Type-Options": "nosniff"})
    assert out == {"hsts": True, "csp": False,
                   "x_frame_options": False, "x_content_type_options": True}


def test_empty_header_values_do_not_count_as_present():
    assert header_check.read({"content-security-policy": "   "})["csp"] is False


def test_no_headers_at_all():
    assert header_check.read({}) == {"hsts": False, "csp": False,
                                     "x_frame_options": False,
                                     "x_content_type_options": False}


# --- how TLS facts turn into issues ---------------------------------------

def test_a_certificate_expiring_in_a_week_is_a_high_severity_issue():
    codes = issues_for({"status": 200}, {"ok": True, "days_left": 6, "san_match": True},
                       {"hsts": True, "csp": True, "x_frame_options": True,
                        "x_content_type_options": True},
                       {"title": {"present": True}, "viewport": {"present": True},
                        "mixed_content": {"count": 0}})
    assert codes == ["TLS_EXPIRES_SOON"]
    assert score(codes)["score"] == 75


def test_a_healthy_site_scores_100():
    codes = issues_for({"status": 200, "ttfb_ms": 120},
                       {"ok": True, "days_left": 90, "san_match": True},
                       {"hsts": True, "csp": True, "x_frame_options": True,
                        "x_content_type_options": True},
                       {"title": {"present": True}, "viewport": {"present": True},
                        "mixed_content": {"count": 0}})
    assert codes == []
    assert score(codes) == {"score": 100, "grade": "A", "issues": []}


def test_a_403_is_reported_as_bot_protection_not_as_a_broken_page():
    """A site that refuses our user agent is not a site that is down, and the
    verdict has to say which one it saw."""
    codes = issues_for({"status": 403}, {"ok": True, "days_left": 90, "san_match": True},
                       {"hsts": True, "csp": True, "x_frame_options": True,
                        "x_content_type_options": True},
                       {"title": {"present": True}, "viewport": {"present": True},
                        "mixed_content": {"count": 0}})
    assert codes == ["BOT_PROTECTION_SUSPECTED"]
    assert "HTTP_ERROR_STATUS" not in codes
    note = score(codes)["issues"][0]["note"]
    assert "we do not run one" in note


def test_a_broken_site_collects_every_issue():
    codes = issues_for({"status": 503, "ttfb_ms": 4200, "truncated": True},
                       {"ok": False, "days_left": 3, "san_match": False},
                       {"hsts": False, "csp": False, "x_frame_options": False,
                        "x_content_type_options": False},
                       {"title": {"present": False}, "viewport": {"present": False},
                        "mixed_content": {"count": 7}})
    assert "HTTP_ERROR_STATUS" in codes
    assert "TLS_INVALID" in codes
    assert "TLS_HOSTNAME_MISMATCH" in codes
    assert "MIXED_CONTENT" in codes
    assert "REDIRECT_CHAIN_TRUNCATED" in codes
    assert score(codes)["grade"] == "F"


def test_http_only_pages_are_not_marked_down_for_a_certificate_they_do_not_have():
    codes = issues_for({"status": 200}, {},      # no tls block for an http page
                       {"hsts": True, "csp": True, "x_frame_options": True,
                        "x_content_type_options": True},
                       {"title": {"present": True}, "viewport": {"present": True},
                        "mixed_content": {"count": 0}})
    assert codes == []


@pytest.mark.network
def test_a_real_expired_certificate_fails_the_strict_handshake():
    try:
        out = run(tls_check.check("expired.badssl.com"))
    except Exception:
        pytest.skip("no network")
    if out.get("error") in {"timeout"} or "connect:" in str(out.get("error", "")):
        pytest.skip("no network")
    assert out["ok"] is False
    assert out["days_left"] is not None and out["days_left"] < 0
