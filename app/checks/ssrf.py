"""SSRF guard: refuse to fetch anything that lives inside the network.

This service takes a URL from a stranger and fetches it, which is the textbook
setup for server-side request forgery: point it at 169.254.169.254 and read the
cloud metadata, or at 10.0.0.x and port-scan the private network through us.

Two rules keep that shut:
  * only http and https - no file:, ftp:, gopher:, data:;
  * every hostname is resolved BEFORE we connect, and every resolved address is
    checked against the private/loopback/link-local/reserved ranges. Re-checked
    after each redirect hop, because "public URL redirects to 127.0.0.1" is the
    classic bypass.

There is a residual TOCTOU window between resolving and connecting (DNS could
change underneath us). Closing it fully means pinning the socket to the checked
address; that is noted in the README's honest limits rather than pretended away.
"""
from __future__ import annotations

import asyncio
import ipaddress
import socket
from dataclasses import dataclass
from urllib.parse import urlsplit

ALLOWED_SCHEMES = {"http", "https"}

# Cloud instance metadata. Blocked by the link-local rule too, but named here so
# the refusal reason is specific.
METADATA_ADDRESSES = {"169.254.169.254", "fd00:ec2::254", "100.100.100.200"}


@dataclass
class Target:
    """A hostname that passed (or failed) the guard."""

    ok: bool = False
    host: str = ""
    ip: str = ""
    reason: str = ""

    def as_error(self) -> dict:
        return {"error": "target_blocked", "reason": self.reason}


def classify_ip(raw: str) -> str:
    """Return a refusal reason for an address, or "" if it is fine to fetch."""
    if raw in METADATA_ADDRESSES:
        return "metadata_address"
    try:
        ip = ipaddress.ip_address(raw)
    except ValueError:
        return "unresolvable"
    if ip.is_unspecified:
        return "unspecified_address"
    if ip.is_loopback:
        return "loopback_address"
    if ip.is_link_local:
        return "link_local_address"
    if ip.is_multicast:
        return "multicast_address"
    if ip.is_reserved:
        # 240.0.0.0/4 and friends. Checked before is_private because Python
        # reports both for them and "reserved" is the truthful word.
        return "reserved_address"
    if ip.is_private:
        # 10/8, 172.16/12, 192.168/16, fc00::/7
        return "private_address"
    if not ip.is_global:
        # Everything else that is not routable on the public internet -
        # carrier-grade NAT (100.64/10), documentation ranges, and so on.
        return "non_public_address"
    return ""


def validate_url(url: str) -> tuple[bool, str]:
    """(ok, host). A url is usable only if it is http(s) and has a hostname."""
    try:
        parts = urlsplit(url)
    except ValueError:
        return False, ""
    if parts.scheme.lower() not in ALLOWED_SCHEMES:
        return False, ""
    if not parts.hostname:
        return False, ""
    return True, parts.hostname


async def resolve(host: str, port: int = 443) -> Target:
    """Resolve a hostname and refuse it if ANY address it answers with is internal.

    All addresses, not just the first: a host that returns one public and one
    private address is a rebinding attempt, not a lucky draw.
    """
    if not host:
        return Target(False, reason="no_host")

    # A literal address never touches DNS.
    literal = classify_ip(host.strip("[]"))
    if literal and literal != "unresolvable":
        return Target(False, host=host, ip=host.strip("[]"), reason=literal)

    loop = asyncio.get_running_loop()
    try:
        infos = await loop.getaddrinfo(host, port, type=socket.SOCK_STREAM)
    except socket.gaierror:
        return Target(False, host=host, reason="dns_failed")
    except Exception:
        return Target(False, host=host, reason="dns_failed")

    addresses = [info[4][0] for info in infos]
    if not addresses:
        return Target(False, host=host, reason="dns_failed")

    for address in addresses:
        reason = classify_ip(address)
        if reason:
            return Target(False, host=host, ip=address, reason=reason)

    return Target(True, host=host, ip=addresses[0])


async def check_url(url: str) -> Target:
    """Validate a URL and resolve its host through the guard."""
    ok, host = validate_url(url)
    if not ok:
        return Target(False, reason="invalid_url")
    parts = urlsplit(url)
    port = parts.port or (443 if parts.scheme.lower() == "https" else 80)
    return await resolve(host, port)
