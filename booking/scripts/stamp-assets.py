#!/usr/bin/env python3
"""Adds a version tag to every page's links to the booking files, e.g.
/book/booking.js?v=3f9a1c2e. The tag is a fingerprint of the file's contents,
so when the file changes browsers fetch the new copy instead of a cached one.

  python3 booking/scripts/stamp-assets.py          (from the repo root)

Run it after changing book/booking.js or book/booking.css (the launch
preflight does this too). Safe to run any number of times.
"""
import hashlib
import pathlib
import re
import sys

ROOT = pathlib.Path(__file__).resolve().parents[2]
ASSETS = ["book/booking.js", "book/booking.css"]
SKIP = {"node_modules", ".test-build", ".email-previews", ".git", "booking"}


def fingerprints(root=ROOT):
    return {a: hashlib.sha256((root / a).read_bytes()).hexdigest()[:8] for a in ASSETS}


def stamp(html: str, prints: dict) -> str:
    for asset, h in prints.items():
        html = re.sub(rf'(["\'])/{re.escape(asset)}(\?v=[0-9a-f]*)?\1', rf'\1/{asset}?v={h}\1', html)
    return html


def main():
    prints = fingerprints()
    changed = []
    for page in ROOT.rglob("*.html"):
        if SKIP & set(page.relative_to(ROOT).parts):
            continue
        text = page.read_text(encoding="utf-8")
        new = stamp(text, prints)
        if new != text:
            page.write_text(new, encoding="utf-8")
            changed.append(str(page.relative_to(ROOT)))
    print(f"booking.js v={prints['book/booking.js']}, booking.css v={prints['book/booking.css']}")
    print("updated:", ", ".join(changed) if changed else "nothing (already current)")


if __name__ == "__main__":
    sys.exit(main())
