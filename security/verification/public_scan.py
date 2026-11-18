#!/usr/bin/env python3
"""Fail the build if production-only values appear in the public tree."""

from __future__ import annotations

import re
import sys
from pathlib import Path


ROOT = Path(__file__).resolve().parents[2]
SKIP_PARTS = {".git", "__pycache__", "node_modules"}
TEXT_SUFFIXES = {
    ".md",
    ".py",
    ".sh",
    ".json",
    ".example",
    ".conf",
    ".service",
    ".timer",
    ".plist",
    ".xml",
    ".yml",
    ".yaml",
    ".editorconfig",
    ".ts",
    ".js",
    ".mjs",
    ".html",
    ".css",
    "",
}


REGEXES = [
    (
        "public IPv4 literal",
        re.compile(
            r"(?<![\w.])(?!0\.0\.0\.0)(?!10\.)(?!127\.)(?!192\.168\.)(?!172\.(?:1[6-9]|2\d|3[0-1])\.)"
            r"(?:\d{1,3}\.){3}\d{1,3}(?![\w.])"
        ),
    ),
    ("long numeric identifier", re.compile(r"(?<!\d)\d{10,}(?!\d)")),
    ("AWS instance id", re.compile(r"\bi-[0-9a-f]{17}\b")),
    ("private key marker", re.compile(r"BEGIN (?:OPENSSH|RSA|EC|DSA) PRIVATE KEY")),
    ("private Web path", re.compile(r"\bcc-[0-9a-f]{12,}\b")),
    ("private cc.cd domain", re.compile(r"\b[a-z0-9-]+\.cc\.cd\b", re.IGNORECASE)),
    ("Telegram bot username", re.compile(r"@[A-Za-z0-9_]{4,}bot\b", re.IGNORECASE)),
    ("macOS user path", re.compile(r"/Users/[A-Za-z0-9._-]+")),
    ("Linux user path", re.compile(r"/home/[A-Za-z0-9._-]+")),
    (
        "legacy external brand reference",
        re.compile(
            r"\b(?:desk" r"tunnel|cc-?desk-?" r"tunnel|cc" r"desk|sun" r"168567)\b",
            re.IGNORECASE,
        ),
    ),
]
FORBIDDEN_NAMES = {".credentials.json", "cloudflare.ini"}


def iter_files():
    for path in ROOT.rglob("*"):
        if not path.is_file():
            continue
        if SKIP_PARTS.intersection(path.parts):
            continue
        if path.suffix not in TEXT_SUFFIXES:
            continue
        yield path


def main() -> int:
    violations = []
    for path in iter_files():
        if path.name in FORBIDDEN_NAMES:
            violations.append(f"{path.relative_to(ROOT)}: forbidden credential filename")
        try:
            content = path.read_text(encoding="utf-8")
        except UnicodeDecodeError:
            continue
        for name, regex in REGEXES:
            if regex.search(content):
                violations.append(f"{path.relative_to(ROOT)}: {name}")
    if violations:
        print("PUBLIC_SCAN_FAILED")
        print("\n".join(violations))
        return 1
    print(f"PUBLIC_SCAN_OK files={sum(1 for _ in iter_files())}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
