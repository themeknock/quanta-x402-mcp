"""The SSRF guard. This is the file that decides whether Quanta can be used as a
port scanner for someone else's private network.

Every address family the spec names is here, plus the bypass that actually gets
used in the wild: a public hostname that 302s to 127.0.0.1.
"""
from __future__ import annotations

import asyncio
import socket

import pytest

from app.checks import ssrf

BLOCKED = [
    ("169.254.169.254", "metadata_address"),   # cloud instance metadata
    ("10.0.0.1", "private_address"),
    ("172.16.5.4", "private_address"),
    ("192.168.1.1", "private_address"),
    ("127.0.0.1", "loopback_address"),
    ("::1", "loopback_address"),
    ("fc00::1", "private_address"),
    ("fe80::1", "link_local_address"),
    ("169.254.10.1", "link_local_address"),
    ("0.0.0.0", "unspecified_address"),
    ("240.0.0.1", "reserved_address"),
    ("100.64.0.1", "non_public_address"),   # carrier-grade NAT
    ("224.0.0.1", "multicast_address"),
]


def run(coro):
    return asyncio.run(coro)


@pytest.mark.parametrize("address,reason", BLOCKED)
def test_literal_addresses_are_blocked(address, reason):
    target = run(ssrf.resolve(address))
    assert target.ok is False
    assert target.reason == reason


@pytest.mark.parametrize("url", [
    "http://169.254.169.254/latest/meta-data/",
    "http://10.0.0.1/admin",
    "https://192.168.0.1",
    "http://[::1]:8080/",
])
def test_internal_urls_are_blocked(url):
    assert run(ssrf.check_url(url)).ok is False


def test_localhost_resolves_to_loopback_and_is_blocked():
    target = run(ssrf.resolve("localhost"))
    assert target.ok is False
    assert target.reason == "loopback_address"


@pytest.mark.parametrize("url", [
    "file:///etc/passwd",
    "ftp://example.com/pub",
    "gopher://example.com",
    "data:text/html,<h1>hi</h1>",
    "https://",
    "not a url at all",
])
def test_only_http_and_https_with_a_host_are_accepted(url):
    ok, _ = ssrf.validate_url(url)
    assert ok is False
    assert run(ssrf.check_url(url)).reason == "invalid_url"


def test_a_public_url_passes():
    ok, host = ssrf.validate_url("https://example.com/page?x=1")
    assert (ok, host) == (True, "example.com")
    assert ssrf.classify_ip("93.184.216.34") == ""


def test_a_host_that_answers_with_any_internal_address_is_blocked(monkeypatch):
    """One public address and one private address is a rebinding attempt, not a
    lucky draw - so the whole host is refused."""

    async def fake_getaddrinfo(host, port, **kwargs):
        return [
            (socket.AF_INET, socket.SOCK_STREAM, 6, "", ("93.184.216.34", port)),
            (socket.AF_INET, socket.SOCK_STREAM, 6, "", ("10.1.2.3", port)),
        ]

    loop = asyncio.new_event_loop()
    monkeypatch.setattr(loop, "getaddrinfo", fake_getaddrinfo)
    try:
        target = loop.run_until_complete(ssrf.resolve("split-horizon.example"))
    finally:
        loop.close()
    assert target.ok is False
    assert target.reason == "private_address"


def test_redirect_to_internal_is_blocked(monkeypatch):
    """The classic bypass: the first URL is public, the Location header is not.

    The guard has to run on every hop, so this asserts through fetch.get(), not
    through resolve() alone.
    """
    import httpx

    from app.checks import fetch

    def handler(request: httpx.Request) -> httpx.Response:
        if request.url.host == "redirector.example":
            return httpx.Response(302, headers={"location": "http://169.254.169.254/latest/meta-data/"})
        raise AssertionError(f"guard let us reach {request.url}")

    transport = httpx.MockTransport(handler)
    real_client = httpx.AsyncClient

    def patched(*args, **kwargs):
        kwargs["transport"] = transport
        return real_client(*args, **kwargs)

    async def fake_check_url(url: str):
        from urllib.parse import urlsplit
        host = urlsplit(url).hostname or ""
        if host == "redirector.example":
            return ssrf.Target(True, host=host, ip="93.184.216.34")
        return await ssrf.check_url(url)

    monkeypatch.setattr(fetch.httpx, "AsyncClient", patched)
    monkeypatch.setattr(fetch, "check_url", fake_check_url)

    result = run(fetch.get("https://redirector.example/start"))
    assert result.ok is False
    assert result.detail == "metadata_address"
    assert result.redirects == 1
