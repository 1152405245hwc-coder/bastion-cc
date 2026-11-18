#!/usr/bin/env python3
"""Read-only, redacted Telegram notifier for CC Relay Forge sessions."""

from __future__ import annotations

import datetime as datetime
import json
import os
import sqlite3
import stat
import time
import urllib.parse
import urllib.request
from pathlib import Path


TERMINAL = {"completed", "failed", "cancelled"}
APPROVAL = {"awaiting_approval", "awaiting_input"}


def required(name: str) -> str:
    return required_any(name)


def required_any(*names: str) -> str:
    for name in names:
        value = os.environ.get(name, "").strip()
        if value:
            return value
    raise RuntimeError(f"missing required environment variable: {' or '.join(names)}")


def setting(name: str, default: str) -> str:
    return os.environ.get(name, default)


def drop_to_database_owner(database: Path) -> None:
    if os.geteuid() != 0:
        return
    owner = database.stat()
    os.setgid(owner.st_gid)
    os.setuid(owner.st_uid)


def load_state(path: Path) -> dict:
    if not path.exists():
        return {"last_rowid": 0, "sent": {}}
    return json.loads(path.read_text(encoding="utf-8"))


def save_state(path: Path, state: dict) -> None:
    path.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
    temporary = path.with_suffix(".tmp")
    temporary.write_text(json.dumps(state, separators=(",", ":")) + "\n", encoding="utf-8")
    os.chmod(temporary, stat.S_IRUSR | stat.S_IWUSR)
    os.replace(temporary, path)


def status_message(status: str) -> str | None:
    return {
        "awaiting_approval": "CC Relay Forge: approval required",
        "awaiting_input": "CC Relay Forge: input required",
        "completed": "CC Relay Forge: task completed",
        "failed": "CC Relay Forge: task failed",
        "cancelled": "CC Relay Forge: task cancelled",
    }.get(status)


def duration_seconds(metadata: dict) -> float | None:
    for key in ("durationSeconds", "duration_seconds", "elapsedSeconds"):
        if isinstance(metadata.get(key), (int, float)):
            return float(metadata[key])

    def timestamp(value):
        if isinstance(value, (int, float)):
            return float(value)
        if not isinstance(value, str):
            return None
        try:
            return datetime.datetime.fromisoformat(value.replace("Z", "+00:00")).timestamp()
        except ValueError:
            return None

    started = next((timestamp(metadata.get(key)) for key in ("startedAt", "started_at", "startTime", "start_time") if timestamp(metadata.get(key)) is not None), None)
    ended = next((timestamp(metadata.get(key)) for key in ("endedAt", "ended_at", "completedAt", "completed_at", "updatedAt", "updated_at") if timestamp(metadata.get(key)) is not None), None)
    return ended - started if started is not None and ended is not None and ended >= started else None


def send_message(token: str, chat_id: str, text: str) -> None:
    endpoint = "https://api.telegram.org/bot" + urllib.parse.quote(token, safe="") + "/sendMessage"
    body = urllib.parse.urlencode({"chat_id": chat_id, "text": text}).encode("utf-8")
    request = urllib.request.Request(endpoint, data=body, method="POST")
    with urllib.request.urlopen(request, timeout=10) as response:
        result = json.loads(response.read().decode("utf-8"))
    if not result.get("ok"):
        raise RuntimeError("Telegram API returned ok=false")


def read_events(database: Path, after_rowid: int) -> list[tuple[int, str, dict]]:
    uri = f"file:{database}?mode=ro"
    connection = sqlite3.connect(uri, uri=True)
    try:
        has_events = (
            connection.execute(
                "SELECT 1 FROM sqlite_master WHERE type='table' AND name='events'"
            ).fetchone()
            is not None
        )
        if has_events:
            start_rows = connection.execute(
                "SELECT type, payload_json, created_at FROM events WHERE type IN ('RunQueued', 'RunStarted') ORDER BY rowid"
            ).fetchall()
            started_by_run: dict[str, str] = {}
            for event_type, raw_payload, created_at in start_rows:
                try:
                    payload = json.loads(raw_payload or "{}")
                except (TypeError, ValueError) as exc:
                    raise RuntimeError(f"invalid event payload: {exc}") from exc
                if not isinstance(payload, dict):
                    continue
                run_id = payload.get("runId")
                if isinstance(run_id, str) and run_id and (run_id not in started_by_run or event_type == "RunStarted"):
                    started_by_run[run_id] = str(created_at)

            rows = connection.execute(
                "SELECT rowid, type, payload_json, created_at FROM events WHERE rowid > ? ORDER BY rowid",
                (after_rowid,),
            ).fetchall()
            status_map = {
                "ApprovalRequested": "awaiting_approval",
                "RunCompleted": "completed",
                "RunFailed": "failed",
                "RunCancelled": "cancelled",
            }
            events = []
            for rowid, event_type, raw_payload, created_at in rows:
                try:
                    payload = json.loads(raw_payload or "{}")
                except (TypeError, ValueError) as exc:
                    raise RuntimeError(f"invalid event payload at rowid {rowid}: {exc}") from exc
                mapped_status = status_map.get(str(event_type), str(event_type))
                metadata: dict = {}
                if mapped_status in TERMINAL and isinstance(payload, dict):
                    run_id = payload.get("runId")
                    started_at = started_by_run.get(run_id) if isinstance(run_id, str) else None
                    if started_at:
                        metadata = {"startedAt": started_at, "endedAt": str(created_at)}
                events.append((int(rowid), mapped_status, metadata))
            return events

        rows = connection.execute(
            "SELECT rowid, status, metadata FROM sessions WHERE rowid > ? ORDER BY rowid",
            (after_rowid,),
        ).fetchall()
    finally:
        connection.close()

    events = []
    for rowid, status, raw_metadata in rows:
        try:
            metadata = json.loads(raw_metadata or "{}")
        except (TypeError, ValueError) as exc:
            raise RuntimeError(f"invalid metadata at rowid {rowid}: {exc}") from exc
        events.append((int(rowid), str(status), metadata))
    return events


def process_events(
    events: list[tuple[int, str, dict]],
    state: dict,
    minimum: float,
    sender,
) -> int:
    sent = state.setdefault("sent", {})
    sent_count = 0
    for rowid, status, metadata in events:
        message = status_message(status)
        if message is not None:
            should_send = status in APPROVAL
            if status in TERMINAL:
                elapsed = duration_seconds(metadata)
                should_send = elapsed is not None and elapsed >= minimum
            key = str(rowid)
            if should_send and sent.get(key) != status:
                sender(message)
                sent.pop(key, None)
                sent[key] = status
                while len(sent) > 500:
                    del sent[next(iter(sent))]
                sent_count += 1
        state["last_rowid"] = max(int(state.get("last_rowid", 0)), rowid)
    return sent_count


def poll_once(
    database: Path,
    state_file: Path,
    token: str,
    chat_id: str,
    minimum: float,
    sender=send_message,
) -> int:
    state = load_state(state_file)
    events = read_events(database, int(state.get("last_rowid", 0)))
    if not events:
        return 0
    sent_count = process_events(
        events,
        state,
        minimum,
        lambda text: sender(token, chat_id, text),
    )
    save_state(state_file, state)
    return sent_count


def main() -> None:
    database = Path(setting("CCRF_DB", "/srv/cc-relay-forge/state/sessions.sqlite"))
    state_file = Path(setting("CCRF_NOTIFY_STATE", "/var/lib/ccrf-notify/state.json"))
    minimum = float(setting("MIN_RUN_SECONDS", "15"))
    poll_seconds = float(setting("POLL_SECONDS", "2"))
    bot_auth = required_any("TELEGRAM_BOT_TOKEN", "TG_BOT_TOKEN")
    chat_id = required_any("TELEGRAM_CHAT_ID", "TG_CHAT_ID")

    drop_to_database_owner(database)
    load_state(state_file)

    while True:
        poll_once(database, state_file, bot_auth, chat_id, minimum)
        time.sleep(poll_seconds)


if __name__ == "__main__":
    main()
