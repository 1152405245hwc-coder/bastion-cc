#!/usr/bin/env python3
"""Fail-closed reboot gate for a small CC Relay Forge VPS."""

from __future__ import annotations

import argparse
import datetime as datetime
import fcntl
import json
import os
import re
import sqlite3
import struct
import subprocess
import sys
from pathlib import Path
from zoneinfo import ZoneInfo


LOCKS = (
    "/var/lib/dpkg/lock-frontend",
    "/var/lib/dpkg/lock",
    "/var/lib/apt/lists/lock",
    "/run/unattended-upgrades.lock",
)
BUSY_PROCESS = re.compile(r"\b(?:apt|apt-get|dpkg|unattended-upgrade|aptitude|certbot)\b")
EXCLUDED_PROCESS = "unattended-upgrade-shutdown --wait-for-signal"


def setting(name: str, default: str) -> str:
    return os.environ.get(name, default)


def log(message: str) -> None:
    line = f"{datetime.datetime.now(datetime.timezone.utc).isoformat()} {message}"
    print(line, flush=True)
    path = Path(setting("CCRF_REBOOT_LOG", "/var/log/safe-reboot.log"))
    try:
        path.parent.mkdir(parents=True, exist_ok=True)
        previous = path.read_text(encoding="utf-8").splitlines()[-499:] if path.exists() else []
        path.write_text("\n".join(previous + [line]) + "\n", encoding="utf-8")
    except OSError as exc:
        print(f"LOG_WRITE_FAILED path={path} error={exc}", file=sys.stderr, flush=True)


def lock_busy(path: str) -> bool:
    lock_path = Path(path)
    if not lock_path.exists():
        return False
    fd = os.open(lock_path, os.O_RDONLY)
    try:
        try:
            fcntl.flock(fd, fcntl.LOCK_SH | fcntl.LOCK_NB)
            fcntl.flock(fd, fcntl.LOCK_UN)
        except BlockingIOError:
            return True

        if sys.platform == "darwin":
            # struct flock on macOS: off_t, off_t, pid_t, short, short.
            fmt = "qqihh"
            request = struct.pack(fmt, 0, 0, 0, fcntl.F_WRLCK, os.SEEK_SET)
            reply = fcntl.fcntl(fd, fcntl.F_GETLK, request)
            lock_type = struct.unpack(fmt, reply[: struct.calcsize(fmt)])[3]
        else:
            # struct flock on Linux amd64/arm64: short, short, off_t, off_t, pid_t.
            fmt = "hhqqi"
            request = struct.pack(fmt, fcntl.F_WRLCK, os.SEEK_SET, 0, 0, 0)
            reply = fcntl.fcntl(fd, fcntl.F_GETLK, request)
            lock_type = struct.unpack(fmt, reply[: struct.calcsize(fmt)])[0]
        return lock_type != fcntl.F_UNLCK
    except (OSError, struct.error) as exc:
        raise RuntimeError(f"cannot inspect lock {path}: {exc}") from exc
    finally:
        os.close(fd)


def package_busy() -> list[str]:
    output = subprocess.run(
        ["ps", "-eo", "pid=,args="],
        check=True,
        capture_output=True,
        text=True,
    ).stdout
    found = []
    for line in output.splitlines():
        if EXCLUDED_PROCESS in line:
            continue
        if BUSY_PROCESS.search(line):
            found.append(line.strip())
    return found


def claude_busy() -> list[str]:
    container = setting("CCRF_CONTAINER", "REPLACE_WITH_CCRF_CONTAINER")
    if container.startswith("REPLACE_"):
        raise RuntimeError("set CCRF_CONTAINER before enabling the timer")
    result = subprocess.run(
        ["docker", "exec", container, "pgrep", "-af", "claude"],
        capture_output=True,
        text=True,
    )
    if result.returncode == 0:
        return [line.strip() for line in result.stdout.splitlines() if line.strip()]
    if result.returncode == 1:
        return []
    raise RuntimeError(f"docker exec failed: {result.stderr.strip()}")


def active_runs() -> list[str]:
    database = Path(setting("CCRF_DB", "/srv/cc-relay-forge/state/sessions.sqlite"))
    if not database.exists():
        raise RuntimeError(f"sessions database is missing: {database}")
    uri = f"file:{database}?mode=ro"
    found = []
    try:
        connection = sqlite3.connect(uri, uri=True)
        try:
            has_events = (
                connection.execute(
                    "SELECT 1 FROM sqlite_master WHERE type='table' AND name='events'"
                ).fetchone()
                is not None
            )
            if has_events:
                event_rows = connection.execute(
                    "SELECT aggregate_id, type, payload_json FROM events ORDER BY rowid"
                ).fetchall()
                run_states: dict[str, tuple[str, str]] = {}
                status_by_type = {
                    "RunQueued": "queued",
                    "RunLeased": "leased",
                    "RunStarted": "running",
                    "ApprovalRequested": "awaiting_approval",
                    "RunCompleted": "completed",
                    "RunFailed": "failed",
                    "RunCancelled": "cancelled",
                    "RunUnknown": "unknown",
                }
                for aggregate_id, event_type, raw_payload in event_rows:
                    try:
                        payload = json.loads(raw_payload or "{}")
                    except (TypeError, ValueError) as exc:
                        raise RuntimeError(f"invalid event payload for {aggregate_id}: {exc}") from exc
                    if not isinstance(payload, dict):
                        continue
                    run_id = payload.get("runId")
                    if not isinstance(run_id, str) or not run_id:
                        continue
                    if event_type == "ApprovalResponded":
                        status = "running" if payload.get("approved") is True else "cancelled"
                    elif event_type in status_by_type:
                        status = status_by_type[event_type]
                    else:
                        continue
                    run_states[run_id] = (str(aggregate_id), status)
                for run_id, (session_id, status) in run_states.items():
                    if status in {"queued", "leased", "running", "awaiting_approval"}:
                        found.append(f"{session_id}:{run_id}")
                return found

            rows = connection.execute("SELECT id, metadata FROM sessions").fetchall()
        finally:
            connection.close()
    except sqlite3.Error as exc:
        raise RuntimeError(f"cannot read sessions database: {exc}") from exc
    for session_id, raw_metadata in rows:
        try:
            metadata = json.loads(raw_metadata or "{}")
        except (TypeError, ValueError) as exc:
            raise RuntimeError(f"invalid metadata for session {session_id}: {exc}") from exc
        if metadata.get("activeRun"):
            found.append(f"{session_id}:{metadata['activeRun']}")
    return found


def should_evaluate() -> bool:
    reboot_file = Path(setting("CCRF_REBOOT_REQUIRED", "/var/run/reboot-required"))
    sunday = datetime.datetime.now(ZoneInfo("Asia/Shanghai")).weekday() == 6
    return reboot_file.exists() or sunday


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--dry-run", action="store_true")
    args = parser.parse_args(argv)

    if not should_evaluate():
        log("SKIP trigger=none")
        return 0

    busy: list[str] = []
    try:
        for lock in LOCKS:
            if lock_busy(lock):
                busy.append(f"lock:{lock}")
        busy.extend(f"package:{item}" for item in package_busy())
        busy.extend(f"claude:{item}" for item in claude_busy())
        busy.extend(f"activeRun:{item}" for item in active_runs())
    except RuntimeError as exc:
        log(f"DEFER reason=unknown-state detail={exc}")
        return 2

    if busy:
        log("DEFER busy=" + " | ".join(busy))
        return 0

    if args.dry_run:
        log("WOULD_REBOOT busy=none")
        return 0

    log("REBOOT busy=none")
    subprocess.run(["systemctl", "reboot"], check=True)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
