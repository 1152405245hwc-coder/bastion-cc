#!/usr/bin/env python3
"""Read-only release gate for privacy-safe public repositories."""

from __future__ import annotations

import argparse
import os
import re
import shutil
import subprocess
import sys
from dataclasses import dataclass
from pathlib import Path


ALLOWED_IDENTITIES = {("CC Relay Forge", "noreply@example.invalid")}
EXEMPT_HIDDEN_NAMES = {".gitignore", ".editorconfig"}
EXEMPT_HIDDEN_DIRS = {".github"}
SKIP_DIRS = {".git", "__pycache__"}
SUSPICIOUS_NAMES = {
    ".aws",
    ".cloudflared",
    ".ssh",
    ".netrc",
    ".npmrc",
    ".pypirc",
    "known_hosts",
}
SUSPICIOUS_SUFFIXES = {
    ".asar",
    ".bak",
    ".crt",
    ".db",
    ".key",
    ".kdbx",
    ".log",
    ".orig",
    ".pem",
    ".pfx",
    ".p12",
    ".shm",
    ".sqlite",
    ".wal",
}
SUSPICIOUS_DIRS = {"backup", "backups", "credentials", "private", "secrets"}
MAX_FILE_BYTES = 8 * 1024 * 1024
# macOS attaches this non-content provenance marker locally; Git does not store it.
ALLOWED_XATTRS = {"com.apple.provenance"}

SECRET_PATTERNS = (
    re.compile(rb"-----BEGIN [A-Z0-9 ]+ PRIVATE KEY-----"),
    re.compile(rb"\b(?:ghp_|github_pat_|xoxb-|xoxp-|sk-|AKIA|ASIA|AIza)[-_A-Za-z0-9]{16,}\b"),
    re.compile(rb"\beyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b"),
    re.compile(
        rb"(?i)\b(?:api[_-]?key|client[_-]?secret|password|secret|token)"
        rb"\s*[:=]\s*['\"]?"
        rb"(?!REPLACE_|YOUR_|CHANGEME|EXAMPLE|DUMMY|TEST|CapabilityToken|createCapabilityToken)(?![A-Z][A-Za-z0-9]*(?:\s*[,;\)\]}]|$))[A-Za-z0-9._~+/=-]{12,}"
    ),
    re.compile(rb"\b[0-9a-f]{32,}\b"),
)


@dataclass(frozen=True)
class Finding:
    category: str
    path: str


class ReleaseGate:
    def __init__(self, root: Path, allow_dirty: bool = False):
        self.root = root.resolve()
        self.allow_dirty = allow_dirty
        self.findings: set[Finding] = set()
        self.file_count = 0
        self.commit_count = 0

    def relative(self, path: Path | str) -> str:
        candidate = Path(path)
        if not candidate.is_absolute():
            candidate = self.root / candidate
        try:
            return candidate.absolute().relative_to(self.root).as_posix() or "."
        except ValueError:
            return "<outside-worktree>"

    def add(self, category: str, path: Path | str = ".") -> None:
        self.findings.add(Finding(category, self.relative(path)))

    def git(self, *args: str, allow_no_match: bool = False) -> str | None:
        try:
            result = subprocess.run(
                ["git", "-C", str(self.root), *args],
                check=True,
                capture_output=True,
                text=True,
            )
        except FileNotFoundError:
            self.add("git", ".")
            return None
        except subprocess.CalledProcessError:
            if allow_no_match:
                return ""
            self.add("git", ".")
            return None
        return result.stdout

    def iter_paths(self):
        for path in self.root.rglob("*"):
            if any(part in SKIP_DIRS for part in path.parts):
                continue
            yield path

    def check_worktree(self) -> None:
        output = self.git("status", "--porcelain=v1", "--untracked-files=all")
        if output is None:
            return
        for line in output.splitlines():
            if len(line) < 4:
                self.add("worktree", ".")
                continue
            changed = line[3:]
            if " -> " in changed:
                changed = changed.rsplit(" -> ", 1)[-1]
            self.add("worktree", changed)

    def check_history(self) -> None:
        output = self.git(
            "log",
            "--format=%an%x1f%ae%x1f%cn%x1f%ce",
            "--all",
        )
        if output is None:
            return
        rows = [row for row in output.splitlines() if row]
        self.commit_count = len(rows)
        for row in rows:
            fields = row.split("\x1f")
            if len(fields) != 4:
                self.add("identity", "git-history")
                continue
            author_name, author_email, committer_name, committer_email = fields
            if (author_name, author_email) not in ALLOWED_IDENTITIES:
                self.add("identity", "git-history")
            if (committer_name, committer_email) not in ALLOWED_IDENTITIES:
                self.add("identity", "git-history")

    def check_git_config(self) -> None:
        local_name = self.git("config", "--local", "--get", "user.name", allow_no_match=True)
        local_email = self.git("config", "--local", "--get", "user.email", allow_no_match=True)
        if local_name is not None and local_email is not None:
            name = local_name.strip()
            email = local_email.strip()
            if name and email:
                if (name, email) not in ALLOWED_IDENTITIES:
                    self.add("identity", ".git/config")
            elif name:
                if name not in {allowed_name for allowed_name, _ in ALLOWED_IDENTITIES}:
                    self.add("identity", ".git/config")
            elif email:
                if email not in {allowed_email for _, allowed_email in ALLOWED_IDENTITIES}:
                    self.add("identity", ".git/config")

        output = self.git("config", "--local", "--get-regexp", r"^remote\..*\.url$", allow_no_match=True)
        if output is None:
            return
        for row in output.splitlines():
            _, _, value = row.partition(" ")
            if re.search(r"://[^/@\s]+@|^[^/\s]+@[^/\s:]+:", value):
                if not value.startswith("git@github.com:"):
                    self.add("git-config", ".git/config")
                    break

    def check_xattrs(self, path: Path) -> None:
        if hasattr(os, "listxattr"):
            try:
                names = os.listxattr(path, follow_symlinks=False)
            except OSError:
                self.add("xattr-check", path)
                return
            unexpected = [name for name in names if name not in ALLOWED_XATTRS]
            if unexpected:
                self.add("xattr", path)
            return

        command = shutil.which("xattr")
        if not command:
            self.add("xattr-unavailable", path)
            return
        try:
            result = subprocess.run([command, "-l", str(path)], capture_output=True, text=False)
        except OSError:
            self.add("xattr-check", path)
            return
        if result.returncode != 0:
            self.add("xattr-check", path)
        elif result.stdout:
            names = set()
            for line in result.stdout.splitlines():
                name = line.split(b":", 1)[0].decode("utf-8", "replace").strip()
                if name:
                    names.add(name)
            if names.difference(ALLOWED_XATTRS):
                self.add("xattr", path)

    def check_name(self, path: Path) -> None:
        name = path.name
        relative = Path(self.relative(path))
        lowered_parts = {part.lower() for part in relative.parts}
        if name in SUSPICIOUS_NAMES or lowered_parts.intersection(SUSPICIOUS_DIRS):
            self.add("sensitive-name", path)
        if name.startswith(".") and name not in EXEMPT_HIDDEN_NAMES:
            if not any(part in EXEMPT_HIDDEN_DIRS for part in path.parts):
                self.add("hidden-config", path)
        if name == ".env" or name.startswith(".env."):
            self.add("hidden-config", path)
        if path.is_file() and path.suffix.lower() in SUSPICIOUS_SUFFIXES:
            self.add("runtime-artifact", path)

    def scan_content(self, path: Path) -> None:
        try:
            size = path.stat().st_size
        except OSError:
            self.add("read-check", path)
            return
        if size > MAX_FILE_BYTES:
            self.add("large-file", path)
            return
        try:
            content = path.read_bytes()
        except OSError:
            self.add("read-check", path)
            return
        for pattern in SECRET_PATTERNS:
            if pattern.search(content):
                self.add("secret-shape", path)
                return

    def check_files(self) -> None:
        for path in self.iter_paths():
            self.file_count += 1
            self.check_xattrs(path)
            self.check_name(path)
            if path.is_symlink():
                self.add("symlink", path)
                continue
            if path.is_file():
                self.scan_content(path)

    def run(self) -> int:
        if not self.allow_dirty:
            self.check_worktree()
        self.check_history()
        self.check_git_config()
        self.check_xattrs(self.root)
        self.check_files()
        if self.findings:
            print("RELEASE_GATE_FAILED")
            for finding in sorted(self.findings, key=lambda item: (item.category, item.path)):
                print(f"- category={finding.category} path={finding.path}")
            return 1
        print(f"RELEASE_GATE_OK files={self.file_count} commits={self.commit_count}")
        return 0


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Check a repository before public release.")
    parser.add_argument("--root", type=Path, default=Path(__file__).resolve().parents[2])
    parser.add_argument("--allow-dirty", action="store_true", help="skip dirty worktree check")
    args = parser.parse_args(argv)
    try:
        return ReleaseGate(args.root, allow_dirty=args.allow_dirty).run()
    except (OSError, ValueError, UnicodeError):
        print("RELEASE_GATE_FAILED")
        print("- category=gate path=.")
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
