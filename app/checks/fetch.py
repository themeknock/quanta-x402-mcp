"""One bounded GET. Redirects are followed by hand so the SSRF guard sees every hop.

Budgets, all configurable, all enforced:
  * 10 s for the whole thing, TTFB included;
  * 5 redirect hops, then stop and say the chain was truncated;
  * 2 MB of body, then stop reading and say the body was truncated.

httpx's own follow_redirects is off on purpose: it would hop straight past the
guard into the private network.
"""
from __future__ import annotations

import time
from dataclasses import dataclass, field
from urllib.parse import urljoin, urlsplit

import httpx

from ..config import settings
from .ssrf import Target, check_url

USER_AGENT = "QuantaCheck/0.2 (+https://quanta.themeknock.net/bot)"


@dataclass
class Fetch:
    """The outcome of one GET. `ok=False` carries a `detail` the API turns into a 502."""

    ok: bool
    detail: str = ""                 # dns | connect | timeout | tls
    status: int = 0
    final_url: str = ""
    redirects: int = 0
    truncated_redirects: bool = False
    ttfb_ms: int = 0
    total_ms: int = 0
    bytes: int = 0
    body_truncated: bool = False
    content_type: str = ""
    body: bytes = b""
    response_headers: dict = field(default_factory=dict)
    target: Target = field(default_factory=Target)


def _classify(exc: Exception) -> str:
    if isinstance(exc, httpx.ConnectTimeout | httpx.ReadTimeout | httpx.PoolTimeout):
        return "timeout"
    if isinstance(exc, httpx.ConnectError):
        text = str(exc).lower()
        if "ssl" in text or "certificate" in text or "tls" in text:
            return "tls"
        if "name or service not known" in text or "nodename nor servname" in text:
            return "dns"
        return "connect"
    if isinstance(exc, httpx.TimeoutException):
        return "timeout"
    return "connect"


async def get(url: str) -> Fetch:
    max_redirects = settings.check_max_redirects
    max_bytes = settings.check_max_bytes
    budget = settings.check_timeout_s

    started = time.perf_counter()
    current = url
    redirects = 0
    truncated_redirects = False
    target = Target(False)

    timeout = httpx.Timeout(budget, connect=min(budget, 5.0))
    headers = {"User-Agent": USER_AGENT, "Accept": "text/html,*/*"}

    async with httpx.AsyncClient(follow_redirects=False, timeout=timeout,
                                 headers=headers, max_redirects=0) as client:
        while True:
            # Guard runs on the ORIGINAL url and again on every redirect target.
            target = await check_url(current)
            if not target.ok:
                return Fetch(False, detail=target.reason, target=target,
                             final_url=current, redirects=redirects)

            try:
                request_started = time.perf_counter()
                async with client.stream("GET", current) as response:
                    ttfb_ms = int((time.perf_counter() - request_started) * 1000)

                    if response.is_redirect and redirects < max_redirects:
                        location = response.headers.get("location", "")
                        if not location:
                            break
                        current = urljoin(current, location)
                        redirects += 1
                        continue

                    if response.is_redirect:
                        truncated_redirects = True

                    body = bytearray()
                    async for chunk in response.aiter_bytes():
                        body.extend(chunk)
                        if len(body) >= max_bytes:
                            break
                    body_truncated = len(body) > max_bytes
                    body = bytes(body[:max_bytes])

                    return Fetch(
                        True,
                        status=response.status_code,
                        final_url=str(response.url),
                        redirects=redirects,
                        truncated_redirects=truncated_redirects,
                        ttfb_ms=ttfb_ms,
                        total_ms=int((time.perf_counter() - started) * 1000),
                        bytes=len(body),
                        body_truncated=body_truncated,
                        content_type=response.headers.get("content-type", ""),
                        body=body,
                        response_headers=dict(response.headers),
                        target=target,
                    )
            except Exception as exc:
                return Fetch(False, detail=_classify(exc), target=target,
                             final_url=current, redirects=redirects,
                             total_ms=int((time.perf_counter() - started) * 1000))

    return Fetch(False, detail="connect", target=target, final_url=current,
                 redirects=redirects, total_ms=int((time.perf_counter() - started) * 1000))


def host_of(url: str) -> str:
    return urlsplit(url).hostname or ""
