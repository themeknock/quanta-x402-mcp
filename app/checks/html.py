"""What the raw HTML says - and nothing about what JavaScript would add.

The one honesty rule in this file: `checked` is always reported, and its value is
"raw_html_only". Plenty of sites inject <title> and <meta name=viewport> from
JavaScript, so "not present in the raw HTML" is a different claim from "missing",
and the API must not blur the two. Every issue this module raises is named
..._IN_RAW_HTML for the same reason.

Mixed content is counted strictly: only sub-resources a browser would actually
block or warn about - img/script/iframe src and link rel=stylesheet href - and
only when the page itself was served over https.
"""
from __future__ import annotations

from urllib.parse import urlsplit

from selectolax.parser import HTMLParser

RAW_ONLY = "raw_html_only"
TRUNCATED = "truncated_2mb"
NOT_HTML = "not_html"
MAX_SAMPLES = 5


def _is_insecure(value: str) -> bool:
    return value.strip().lower().startswith("http://")


def parse(body: bytes, *, final_url: str, content_type: str,
          truncated: bool = False) -> dict:
    """The `html` block of a check result."""
    checked = TRUNCATED if truncated else RAW_ONLY
    base_is_https = urlsplit(final_url).scheme.lower() == "https"

    if content_type and "html" not in content_type.lower():
        return {"checked": NOT_HTML, "content_type": content_type,
                "title": {"present": False}, "viewport": {"present": False},
                "mixed_content": {"count": 0, "samples": []},
                "stylesheets": 0, "scripts": 0}

    tree = HTMLParser(body.decode("utf-8", errors="replace"))

    title_node = tree.css_first("title")
    title_text = (title_node.text(strip=True) if title_node else "") or ""
    title = {"present": bool(title_text), "text": title_text} if title_text else {"present": False}

    viewport = {"present": False}
    for meta in tree.css("meta"):
        if (meta.attributes.get("name") or "").strip().lower() == "viewport":
            content = (meta.attributes.get("content") or "").strip()
            viewport = {"present": True, "content": content} if content else {"present": True}
            break

    insecure: list[str] = []
    for node in tree.css("img, script, iframe"):
        src = node.attributes.get("src") or ""
        if src and _is_insecure(src):
            insecure.append(src)

    stylesheets = 0
    for node in tree.css("link"):
        rel = (node.attributes.get("rel") or "").strip().lower()
        if "stylesheet" not in rel.split():
            continue
        stylesheets += 1
        href = node.attributes.get("href") or ""
        if href and _is_insecure(href):
            insecure.append(href)

    scripts = len(tree.css("script"))

    if not base_is_https:
        # http:// sub-resources on an http:// page are not "mixed" content.
        insecure = []

    return {
        "checked": checked,
        "title": title,
        "viewport": viewport,
        "mixed_content": {"count": len(insecure), "samples": insecure[:MAX_SAMPLES]},
        "stylesheets": stylesheets,
        "scripts": scripts,
    }
