"""Presence of the four response headers a browser acts on. Presence only - this
does not grade a CSP's contents, and does not claim to."""
from __future__ import annotations

from typing import Mapping

WATCHED = {
    "hsts": "strict-transport-security",
    "csp": "content-security-policy",
    "x_frame_options": "x-frame-options",
    "x_content_type_options": "x-content-type-options",
}


def read(headers: Mapping[str, str]) -> dict:
    lowered = {k.lower(): v for k, v in headers.items()}
    return {name: bool(lowered.get(header, "").strip()) for name, header in WATCHED.items()}
