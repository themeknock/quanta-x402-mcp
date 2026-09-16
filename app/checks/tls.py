"""Certificate facts: is it valid, when does it expire, who issued it, does it
actually cover the hostname asked for.

Two handshakes at most. The first is strict (verification on, hostname checked)
because that is what a browser does. If it fails we retry unverified, purely to
read the certificate the server presented so the answer can say *why* it failed
instead of just "no".
"""
from __future__ import annotations

import asyncio
import socket
import ssl
from datetime import datetime, timezone
from typing import Any


def _name_field(pairs: Any, key: str) -> str:
    """certificate subject/issuer come as ((('organizationName', 'X'),), ...)."""
    for rdn in pairs or ():
        for entry in rdn:
            if len(entry) == 2 and entry[0] == key:
                return entry[1]
    return ""


def _parse_not_after(raw: str) -> datetime | None:
    try:
        return datetime.strptime(raw, "%b %d %H:%M:%S %Y %Z").replace(tzinfo=timezone.utc)
    except (ValueError, TypeError):
        return None


def _san_matches(cert: dict, host: str) -> bool:
    host = host.lower().rstrip(".")
    names = [value.lower() for kind, value in cert.get("subjectAltName", ()) if kind == "DNS"]
    for name in names:
        if name == host:
            return True
        if name.startswith("*.") and host.count(".") >= name.count("."):
            if host.split(".", 1)[-1] == name[2:]:
                return True
    return False


def _handshake(host: str, port: int, timeout: float, verify: bool) -> dict:
    context = ssl.create_default_context()
    if not verify:
        context.check_hostname = False
        context.verify_mode = ssl.CERT_NONE
    with socket.create_connection((host, port), timeout=timeout) as raw:
        with context.wrap_socket(raw, server_hostname=host) as tls:
            cert = tls.getpeercert()
            if not cert and not verify:
                # An unverified handshake returns {}; read the DER instead.
                der = tls.getpeercert(binary_form=True)
                cert = _decode_der(der) if der else {}
            return cert or {}


def _decode_der(der: bytes) -> dict:
    """Best effort: OpenSSL can hand back a parsed dict from a DER blob via a
    temporary file. Used only on the unverified retry."""
    import tempfile

    try:
        with tempfile.NamedTemporaryFile(suffix=".pem", mode="w", delete=True) as fh:
            fh.write(ssl.DER_cert_to_PEM_cert(der))
            fh.flush()
            return ssl._ssl._test_decode_cert(fh.name)  # type: ignore[attr-defined]
    except Exception:
        return {}


async def check(host: str, port: int = 443, timeout: float = 10.0) -> dict:
    """The `tls` block of a check result. Never raises."""
    blank = {"ok": False, "days_left": None, "not_after": None,
             "issuer": "", "san_match": False}
    if not host:
        return {**blank, "error": "no_host"}

    try:
        cert = await asyncio.to_thread(_handshake, host, port, timeout, True)
        verified = True
        error = ""
    except ssl.SSLError as exc:
        verified, error = False, (exc.reason or str(exc))
        cert = await _retry(host, port, timeout)
    except ssl.CertificateError as exc:
        verified, error = False, str(exc)
        cert = await _retry(host, port, timeout)
    except (socket.timeout, TimeoutError):
        return {**blank, "error": "timeout"}
    except OSError as exc:
        return {**blank, "error": f"connect:{exc.strerror or exc}"}

    if not cert:
        return {**blank, "error": error or "no_certificate"}

    not_after = _parse_not_after(cert.get("notAfter", ""))
    days_left = None
    if not_after:
        days_left = (not_after - datetime.now(timezone.utc)).days

    result = {
        "ok": verified,
        "days_left": days_left,
        "not_after": not_after.strftime("%Y-%m-%dT%H:%M:%SZ") if not_after else None,
        "issuer": _name_field(cert.get("issuer"), "organizationName")
        or _name_field(cert.get("issuer"), "commonName"),
        "san_match": _san_matches(cert, host),
    }
    if error:
        result["error"] = error
    return result


async def _retry(host: str, port: int, timeout: float) -> dict:
    try:
        return await asyncio.to_thread(_handshake, host, port, timeout, False)
    except Exception:
        return {}
