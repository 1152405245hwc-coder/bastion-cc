#!/usr/bin/env python3
"""Unit tests for BastionCC VPS notification and safe-reboot helper scripts."""

from __future__ import annotations

import importlib.util
import json
import os
import sqlite3
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path


REPO_ROOT = Path(__file__).resolve().parents[2]


def load_module(name: str, relative_path: str):
    path = REPO_ROOT / relative_path
    spec = importlib.util.spec_from_file_location(name, path)
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


NOTIFY = load_module("ccrf_tg_notify", "deploy/vps/scripts/ccrf-tg-notify.py")
REBOOT = load_module("safe_scheduled_reboot", "deploy/vps/scripts/safe-scheduled-reboot.py")


class TelegramNotifyTests(unittest.TestCase):
    def test_events_schema_notifications_and_dedup(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            tmp_dir = Path(tmp)
            db_path = tmp_dir / "events.sqlite"
            state_path = tmp_dir / "state.json"

            conn = sqlite3.connect(db_path)
            conn.executescript(
                """
                CREATE TABLE events (
                    event_id TEXT PRIMARY KEY,
                    aggregate_id TEXT NOT NULL,
                    sequence INTEGER NOT NULL,
                    generation INTEGER NOT NULL,
                    type TEXT NOT NULL,
                    payload_json TEXT NOT NULL,
                    created_at TEXT NOT NULL
                );
                """
            )
            rows = [
                ("e1", "s1", 1, 0, "RunQueued", json.dumps({"runId": "r-short"}), "2026-11-18T10:00:00Z"),
                ("e2", "s1", 2, 0, "RunStarted", json.dumps({"runId": "r-short"}), "2026-11-18T10:00:01Z"),
                ("e3", "s1", 3, 0, "RunCompleted", json.dumps({"runId": "r-short"}), "2026-11-18T10:00:05Z"),
                ("e4", "s1", 4, 0, "RunQueued", json.dumps({"runId": "r-long"}), "2026-11-18T10:01:00Z"),
                ("e5", "s1", 5, 0, "RunStarted", json.dumps({"runId": "r-long"}), "2026-11-18T10:01:01Z"),
                ("e6", "s1", 6, 0, "ApprovalRequested", json.dumps({"runId": "r-long", "reason": "secret prompt"}), "2026-11-18T10:01:05Z"),
                ("e7", "s1", 7, 0, "RunCompleted", json.dumps({"runId": "r-long"}), "2026-11-18T10:01:30Z"),
            ]
            conn.executemany(
                "INSERT INTO events VALUES (?, ?, ?, ?, ?, ?, ?)",
                rows,
            )
            conn.commit()
            conn.close()

            sent: list[str] = []
            first_count = NOTIFY.poll_once(
                db_path,
                state_path,
                "TEST_BOT_TOKEN",
                "chat-1",
                15.0,
                sender=lambda _tok, _cid, text: sent.append(text),
            )
            self.assertEqual(first_count, 2)
            self.assertEqual(
                sent,
                [
                    "CC Relay Forge: approval required",
                    "CC Relay Forge: task completed",
                ],
            )
            self.assertNotIn("secret prompt", " ".join(sent))

            second_count = NOTIFY.poll_once(
                db_path,
                state_path,
                "TEST_BOT_TOKEN",
                "chat-1",
                15.0,
                sender=lambda _tok, _cid, text: sent.append(text),
            )
            self.assertEqual(second_count, 0)

    def test_legacy_sessions_schema_fallback(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            tmp_dir = Path(tmp)
            db_path = tmp_dir / "sessions.sqlite"
            state_path = tmp_dir / "state.json"

            conn = sqlite3.connect(db_path)
            conn.executescript(
                """
                CREATE TABLE sessions (
                    id TEXT PRIMARY KEY,
                    status TEXT NOT NULL,
                    metadata TEXT
                );
                """
            )
            conn.executemany(
                "INSERT INTO sessions VALUES (?, ?, ?)",
                [
                    ("legacy-1", "failed", json.dumps({"durationSeconds": 25})),
                    ("legacy-2", "completed", json.dumps({"durationSeconds": 4})),
                ],
            )
            conn.commit()
            conn.close()

            sent: list[str] = []
            count = NOTIFY.poll_once(
                db_path,
                state_path,
                "TEST_BOT_TOKEN",
                "chat-1",
                15.0,
                sender=lambda _tok, _cid, text: sent.append(text),
            )
            self.assertEqual(count, 1)
            self.assertEqual(sent, ["CC Relay Forge: task failed"])


class SafeRebootTests(unittest.TestCase):
    def test_active_runs_on_events_schema_and_approval_denial(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            db_path = Path(tmp) / "events.sqlite"
            conn = sqlite3.connect(db_path)
            conn.executescript(
                """
                CREATE TABLE events (
                    event_id TEXT PRIMARY KEY,
                    aggregate_id TEXT NOT NULL,
                    sequence INTEGER NOT NULL,
                    generation INTEGER NOT NULL,
                    type TEXT NOT NULL,
                    payload_json TEXT NOT NULL,
                    created_at TEXT NOT NULL
                );
                """
            )
            conn.executemany(
                "INSERT INTO events VALUES (?, ?, ?, ?, ?, ?, ?)",
                [
                    ("e1", "s1", 1, 0, "RunQueued", json.dumps({"runId": "r1"}), "2026-11-18T10:00:00Z"),
                    ("e2", "s1", 2, 0, "RunStarted", json.dumps({"runId": "r1"}), "2026-11-18T10:00:01Z"),
                    ("e3", "s2", 1, 0, "RunQueued", json.dumps({"runId": "r2"}), "2026-11-18T10:00:02Z"),
                    ("e4", "s2", 2, 0, "ApprovalRequested", json.dumps({"runId": "r2"}), "2026-11-18T10:00:03Z"),
                    ("e5", "s2", 3, 0, "ApprovalResponded", json.dumps({"runId": "r2", "approved": False}), "2026-11-18T10:00:04Z"),
                ],
            )
            conn.commit()
            conn.close()

            previous = os.environ.get("CCRF_DB")
            os.environ["CCRF_DB"] = str(db_path)
            try:
                self.assertEqual(REBOOT.active_runs(), ["s1:r1"])
                conn = sqlite3.connect(db_path)
                conn.execute(
                    "INSERT INTO events VALUES (?, ?, ?, ?, ?, ?, ?)",
                    ("e6", "s1", 3, 0, "RunCompleted", json.dumps({"runId": "r1"}), "2026-11-18T10:00:09Z"),
                )
                conn.commit()
                conn.close()
                self.assertEqual(REBOOT.active_runs(), [])
            finally:
                if previous is None:
                    os.environ.pop("CCRF_DB", None)
                else:
                    os.environ["CCRF_DB"] = previous

    def test_active_runs_on_legacy_sessions_schema(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            db_path = Path(tmp) / "sessions.sqlite"
            conn = sqlite3.connect(db_path)
            conn.executescript(
                """
                CREATE TABLE sessions (
                    id TEXT PRIMARY KEY,
                    status TEXT NOT NULL,
                    metadata TEXT
                );
                """
            )
            conn.execute(
                "INSERT INTO sessions VALUES (?, ?, ?)",
                ("legacy-s1", "running", json.dumps({"activeRun": "run-77"})),
            )
            conn.commit()
            conn.close()

            previous = os.environ.get("CCRF_DB")
            os.environ["CCRF_DB"] = str(db_path)
            try:
                self.assertEqual(REBOOT.active_runs(), ["legacy-s1:run-77"])
            finally:
                if previous is None:
                    os.environ.pop("CCRF_DB", None)
                else:
                    os.environ["CCRF_DB"] = previous

    def test_lock_busy_detects_held_exclusive_flock(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            lock_path = Path(tmp) / "apt.lock"
            lock_path.write_text("", encoding="utf-8")
            self.assertFalse(REBOOT.lock_busy(str(lock_path)))

            holder = subprocess.Popen(
                [
                    sys.executable,
                    "-B",
                    "-c",
                    (
                        "import fcntl, sys, time; "
                        f"fd = open({str(lock_path)!r}, 'r+'); "
                        "fcntl.flock(fd, fcntl.LOCK_EX); "
                        "print('LOCKED', flush=True); "
                        "time.sleep(10)"
                    ),
                ],
                stdout=subprocess.PIPE,
                text=True,
            )
            try:
                assert holder.stdout is not None
                ready = holder.stdout.readline().strip()
                self.assertEqual(ready, "LOCKED")
                self.assertTrue(REBOOT.lock_busy(str(lock_path)))
            finally:
                if holder.stdout is not None:
                    holder.stdout.close()
                holder.terminate()
                holder.wait(timeout=5)

            self.assertFalse(REBOOT.lock_busy(str(lock_path)))


if __name__ == "__main__":
    unittest.main()
