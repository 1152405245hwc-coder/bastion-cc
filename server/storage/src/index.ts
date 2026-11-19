import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import { ProtocolError, type Envelope } from "../../../core/protocol/src/index.ts";

export interface StoredChunk {
  runId: string;
  sessionId: string;
  chunkIndex: number;
  role: "prompt" | "output";
  text: string;
  bytes: number;
  digest: string;
  createdAt: string;
}

export interface ChunkPage {
  chunks: StoredChunk[];
  nextCursor: number;
  hasMore: boolean;
}

export interface StoredEvent {
  eventId: string;
  aggregateId: string;
  sequence: number;
  generation: number;
  type: string;
  payload: unknown;
  createdAt: string;
}

export interface Snapshot {
  aggregateId: string;
  sequence: number;
  generation: number;
  state: unknown;
  createdAt: string;
}

export interface StoreState {
  events: StoredEvent[];
  snapshots: Snapshot[];
}

export interface StoredDeviceRecord {
  deviceId: string;
  label: string;
  scopes: readonly string[];
  issuedAt: number;
  expiresAt: number;
  revokedAt?: number;
  credentialHashHex: string;
}

export interface StoredIdempotencyRecord {
  idempotencyKey: string;
  sessionId: string;
  runId: string;
  requestFingerprint: string;
  createdAt: string;
}

export interface EventStoreLike {
  append(event: Omit<StoredEvent, "sequence" | "createdAt">): StoredEvent;
  appendEnvelope<T>(aggregateId: string, envelope: Envelope<T>, type: string): StoredEvent;
  readAfter(aggregateId: string, cursor?: number): StoredEvent[];
  latestSequence(aggregateId: string): number;
  saveSnapshot(snapshot: Omit<Snapshot, "createdAt">): Snapshot;
  getSnapshot(aggregateId: string): Snapshot | undefined;
  exportState(): StoreState;
  importState(state: StoreState): void;
  appendChunk(chunk: Omit<StoredChunk, "createdAt">): StoredChunk;
  readChunks(sessionId: string, runId: string, afterChunk?: number, maxBytes?: number): ChunkPage;
  deleteSessionData(sessionId: string): void;
  compactBodies(options: { keepLatestRunsPerSession: number }): number;
  saveIdempotency?(record: Omit<StoredIdempotencyRecord, "createdAt">): void;
  listIdempotency?(): StoredIdempotencyRecord[];
  saveDevice?(record: StoredDeviceRecord): void;
  listDevices?(): StoredDeviceRecord[];
}

export class EventStore implements EventStoreLike {
  private readonly events: StoredEvent[] = [];
  private readonly snapshots = new Map<string, Snapshot>();
  private readonly eventIds = new Map<string, StoredEvent>();
  private readonly sequences = new Map<string, number>();
  private readonly chunks = new Map<string, StoredChunk[]>();
  private readonly sessionRunOrder = new Map<string, string[]>();
  private readonly idempotencyRecords = new Map<string, StoredIdempotencyRecord>();
  private readonly deviceRecords = new Map<string, StoredDeviceRecord>();

  append(event: Omit<StoredEvent, "sequence" | "createdAt">): StoredEvent {
    const existing = this.eventIds.get(event.eventId);
    if (existing) {
      const same = existing.aggregateId === event.aggregateId && existing.generation === event.generation && existing.type === event.type && JSON.stringify(existing.payload) === JSON.stringify(event.payload);
      if (!same) throw new ProtocolError("IDEMPOTENCY_CONFLICT", "Event id was reused with different content", { eventId: event.eventId });
      return existing;
    }
    const sequence = (this.sequences.get(event.aggregateId) ?? 0) + 1;
    const stored: StoredEvent = {
      ...event,
      sequence,
      createdAt: new Date().toISOString(),
    };
    this.events.push(stored);
    this.eventIds.set(stored.eventId, stored);
    this.sequences.set(stored.aggregateId, sequence);
    return stored;
  }

  appendEnvelope<T>(
    aggregateId: string,
    envelope: Envelope<T>,
    type: string,
  ): StoredEvent {
    return this.append({
      eventId: envelope.requestId,
      aggregateId,
      generation: envelope.generation,
      type,
      payload: envelope.payload,
    });
  }

  readAfter(aggregateId: string, cursor = 0): StoredEvent[] {
    return this.events.filter(
      (event) => event.aggregateId === aggregateId && event.sequence > cursor,
    );
  }

  latestSequence(aggregateId: string): number {
    return this.sequences.get(aggregateId) ?? 0;
  }

  saveSnapshot(snapshot: Omit<Snapshot, "createdAt">): Snapshot {
    const stored = { ...snapshot, createdAt: new Date().toISOString() };
    this.snapshots.set(snapshot.aggregateId, stored);
    return stored;
  }

  getSnapshot(aggregateId: string): Snapshot | undefined {
    return this.snapshots.get(aggregateId);
  }

  exportState(): StoreState {
    return {
      events: this.events.map((event) => ({ ...event })),
      snapshots: [...this.snapshots.values()].map((snapshot) => ({ ...snapshot })),
    };
  }

  importState(state: StoreState): void {
    this.events.splice(0, this.events.length, ...state.events.map((event) => ({ ...event })));
    this.eventIds.clear();
    this.sequences.clear();
    for (const event of this.events) this.eventIds.set(event.eventId, event);
    for (const event of this.events) this.sequences.set(event.aggregateId, Math.max(this.sequences.get(event.aggregateId) ?? 0, event.sequence));
    this.snapshots.clear();
    for (const snapshot of state.snapshots) {
      this.snapshots.set(snapshot.aggregateId, { ...snapshot });
    }
  }

  appendChunk(chunk: Omit<StoredChunk, "createdAt">): StoredChunk {
    const list = this.chunks.get(chunk.runId) ?? [];
    const existing = list.find((item) => item.chunkIndex === chunk.chunkIndex);
    if (existing) {
      if (existing.sessionId !== chunk.sessionId || existing.role !== chunk.role || existing.digest !== chunk.digest) {
        throw new ProtocolError("IDEMPOTENCY_CONFLICT", "Chunk index was reused with different content");
      }
      return { ...existing };
    }
    const stored: StoredChunk = { ...chunk, createdAt: new Date().toISOString() };
    list.push(stored);
    list.sort((left, right) => left.chunkIndex - right.chunkIndex);
    this.chunks.set(chunk.runId, list);
    const runOrder = this.sessionRunOrder.get(chunk.sessionId) ?? [];
    if (!runOrder.includes(chunk.runId)) {
      runOrder.push(chunk.runId);
      this.sessionRunOrder.set(chunk.sessionId, runOrder);
    }
    return { ...stored };
  }

  readChunks(sessionId: string, runId: string, afterChunk = 0, maxBytes = 32 * 1024): ChunkPage {
    const all = (this.chunks.get(runId) ?? []).filter(
      (item) => item.sessionId === sessionId && item.chunkIndex >= afterChunk,
    );
    return paginateChunks(all, afterChunk, maxBytes);
  }

  deleteSessionData(sessionId: string): void {
    for (let index = this.events.length - 1; index >= 0; index -= 1) {
      if (this.events[index]?.aggregateId === sessionId) {
        this.eventIds.delete(this.events[index]!.eventId);
        this.events.splice(index, 1);
      }
    }
    this.sequences.delete(sessionId);
    this.snapshots.delete(sessionId);
    const runOrder = this.sessionRunOrder.get(sessionId) ?? [];
    for (const runId of runOrder) {
      this.chunks.delete(runId);
    }
    this.sessionRunOrder.delete(sessionId);
    for (const [key, record] of this.idempotencyRecords.entries()) {
      if (record.sessionId === sessionId) this.idempotencyRecords.delete(key);
    }
  }

  saveIdempotency(record: Omit<StoredIdempotencyRecord, "createdAt">): void {
    if (!this.idempotencyRecords.has(record.idempotencyKey)) {
      this.idempotencyRecords.set(record.idempotencyKey, { ...record, createdAt: new Date().toISOString() });
    }
  }

  listIdempotency(): StoredIdempotencyRecord[] {
    return [...this.idempotencyRecords.values()].map((record) => ({ ...record }));
  }

  saveDevice(record: StoredDeviceRecord): void {
    this.deviceRecords.set(record.deviceId, {
      ...record,
      scopes: [...record.scopes],
    });
  }

  listDevices(): StoredDeviceRecord[] {
    return [...this.deviceRecords.values()]
      .map((record) => ({ ...record, scopes: [...record.scopes] }))
      .sort((left, right) => left.deviceId.localeCompare(right.deviceId));
  }

  compactBodies(options: { keepLatestRunsPerSession: number }): number {
    const keep = Math.max(0, Math.floor(options.keepLatestRunsPerSession));
    let pruned = 0;
    for (const [sessionId, runOrder] of this.sessionRunOrder.entries()) {
      if (runOrder.length <= keep) continue;
      const removeCount = runOrder.length - keep;
      const toRemove = runOrder.splice(0, removeCount);
      for (const runId of toRemove) {
        const list = this.chunks.get(runId);
        if (list) {
          pruned += list.length;
          this.chunks.delete(runId);
        }
      }
      this.sessionRunOrder.set(sessionId, runOrder);
    }
    return pruned;
  }
}

/**
 * Synchronous SQLite event store for the single-user deployment.
 *
 * It uses Node's built-in node:sqlite module and deliberately keeps the same
 * small interface as the in-memory store used by contract tests. The event
 * table is the source of truth; snapshots are only a recovery optimization.
 */
export class SqliteEventStore implements EventStoreLike {
  private readonly database: any;
  private readonly encryptionKey: Buffer | undefined;

  constructor(filename: string, options: { encryptionKey?: Buffer } = {}) {
    if (options.encryptionKey !== undefined) {
      if (options.encryptionKey.length !== 32) {
        throw new ProtocolError("INVALID_ENVELOPE", "encryptionKey must be 32 bytes");
      }
      this.encryptionKey = options.encryptionKey;
    } else if (process.env.CCRF_BODY_KEY) {
      this.encryptionKey = createHash("sha256").update(process.env.CCRF_BODY_KEY).digest();
    } else {
      this.encryptionKey = undefined;
    }
    const getBuiltinModule = (process as unknown as { getBuiltinModule?: (name: string) => unknown }).getBuiltinModule;
    const sqlite = getBuiltinModule?.("node:sqlite") as { DatabaseSync?: new (path: string) => any } | undefined;
    if (!sqlite?.DatabaseSync) {
      throw new ProtocolError("UNKNOWN", "Node built-in SQLite support is unavailable", { required: "node:sqlite" });
    }
    this.database = new sqlite.DatabaseSync(filename);
    this.database.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA foreign_keys = ON;
      CREATE TABLE IF NOT EXISTS events (
        event_id TEXT PRIMARY KEY,
        aggregate_id TEXT NOT NULL,
        sequence INTEGER NOT NULL,
        generation INTEGER NOT NULL,
        type TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        UNIQUE (aggregate_id, sequence)
      );
      CREATE TABLE IF NOT EXISTS snapshots (
        aggregate_id TEXT PRIMARY KEY,
        sequence INTEGER NOT NULL,
        generation INTEGER NOT NULL,
        state_json TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS run_bodies (
        session_id TEXT NOT NULL,
        run_id TEXT NOT NULL,
        chunk_index INTEGER NOT NULL,
        role TEXT NOT NULL,
        cipher_blob TEXT NOT NULL,
        bytes INTEGER NOT NULL,
        digest TEXT NOT NULL,
        created_at TEXT NOT NULL,
        PRIMARY KEY (run_id, chunk_index)
      );
      CREATE INDEX IF NOT EXISTS idx_run_bodies_session ON run_bodies (session_id, run_id, chunk_index);
      CREATE TABLE IF NOT EXISTS devices (
        device_id TEXT PRIMARY KEY,
        label TEXT NOT NULL,
        scopes_json TEXT NOT NULL,
        issued_at INTEGER NOT NULL,
        expires_at INTEGER NOT NULL,
        revoked_at INTEGER,
        credential_hash_hex TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS idempotency_keys (
        idempotency_key TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        run_id TEXT NOT NULL,
        request_fingerprint TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_idempotency_session ON idempotency_keys (session_id);
    `);
  }

  append(event: Omit<StoredEvent, "sequence" | "createdAt">): StoredEvent {
    this.database.exec("BEGIN IMMEDIATE;");
    try {
      const existing = this.database.prepare(
        "SELECT event_id, aggregate_id, sequence, generation, type, payload_json, created_at FROM events WHERE event_id = ?",
      ).get(event.eventId);
      if (existing) {
        const same = existing.aggregate_id === event.aggregateId
          && existing.generation === event.generation
          && existing.type === event.type
          && existing.payload_json === JSON.stringify(event.payload);
        this.database.exec("COMMIT;");
        if (!same) throw new ProtocolError("IDEMPOTENCY_CONFLICT", "Event id was reused with different content");
        return this.rowToEvent(existing);
      }
      const sequenceRow = this.database.prepare(
        "SELECT COALESCE(MAX(sequence), 0) AS sequence FROM events WHERE aggregate_id = ?",
      ).get(event.aggregateId);
      const sequence = Number(sequenceRow.sequence) + 1;
      const createdAt = new Date().toISOString();
      this.database.prepare(
        "INSERT INTO events (event_id, aggregate_id, sequence, generation, type, payload_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
      ).run(event.eventId, event.aggregateId, sequence, event.generation, event.type, JSON.stringify(event.payload), createdAt);
      this.database.exec("COMMIT;");
      return { ...event, sequence, createdAt };
    } catch (error) {
      try { this.database.exec("ROLLBACK;"); } catch { /* preserve the original failure */ }
      if (error instanceof ProtocolError) throw error;
      throw new ProtocolError("UNKNOWN", "Event store write failed");
    }
  }

  appendEnvelope<T>(aggregateId: string, envelope: Envelope<T>, type: string): StoredEvent {
    return this.append({
      eventId: envelope.requestId,
      aggregateId,
      generation: envelope.generation,
      type,
      payload: envelope.payload,
    });
  }

  readAfter(aggregateId: string, cursor = 0): StoredEvent[] {
    const rows = this.database.prepare(
      "SELECT event_id, aggregate_id, sequence, generation, type, payload_json, created_at FROM events WHERE aggregate_id = ? AND sequence > ? ORDER BY sequence",
    ).all(aggregateId, cursor);
    return rows.map((row: any) => this.rowToEvent(row));
  }

  latestSequence(aggregateId: string): number {
    const row = this.database.prepare(
      "SELECT COALESCE(MAX(sequence), 0) AS sequence FROM events WHERE aggregate_id = ?",
    ).get(aggregateId);
    return Number(row.sequence);
  }

  saveSnapshot(snapshot: Omit<Snapshot, "createdAt">): Snapshot {
    const createdAt = new Date().toISOString();
    this.database.prepare(
      `INSERT INTO snapshots (aggregate_id, sequence, generation, state_json, created_at)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(aggregate_id) DO UPDATE SET sequence=excluded.sequence,
       generation=excluded.generation, state_json=excluded.state_json, created_at=excluded.created_at`,
    ).run(snapshot.aggregateId, snapshot.sequence, snapshot.generation, JSON.stringify(snapshot.state), createdAt);
    return { ...snapshot, createdAt };
  }

  getSnapshot(aggregateId: string): Snapshot | undefined {
    const row = this.database.prepare(
      "SELECT aggregate_id, sequence, generation, state_json, created_at FROM snapshots WHERE aggregate_id = ?",
    ).get(aggregateId);
    return row ? this.rowToSnapshot(row) : undefined;
  }

  exportState(): StoreState {
    const rows = this.database.prepare(
      "SELECT event_id, aggregate_id, sequence, generation, type, payload_json, created_at FROM events ORDER BY rowid",
    ).all();
    const snapshots = this.database.prepare(
      "SELECT aggregate_id, sequence, generation, state_json, created_at FROM snapshots ORDER BY aggregate_id",
    ).all();
    return {
      events: rows.map((row: any) => this.rowToEvent(row)),
      snapshots: snapshots.map((row: any) => this.rowToSnapshot(row)),
    };
  }

  importState(state: StoreState): void {
    this.database.exec("BEGIN IMMEDIATE;");
    try {
      this.database.exec("DELETE FROM events; DELETE FROM snapshots;");
      const insertEvent = this.database.prepare(
        "INSERT INTO events (event_id, aggregate_id, sequence, generation, type, payload_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
      );
      for (const event of state.events) {
        insertEvent.run(event.eventId, event.aggregateId, event.sequence, event.generation, event.type, JSON.stringify(event.payload), event.createdAt);
      }
      const insertSnapshot = this.database.prepare(
        "INSERT INTO snapshots (aggregate_id, sequence, generation, state_json, created_at) VALUES (?, ?, ?, ?, ?)",
      );
      for (const snapshot of state.snapshots) {
        insertSnapshot.run(snapshot.aggregateId, snapshot.sequence, snapshot.generation, JSON.stringify(snapshot.state), snapshot.createdAt);
      }
      this.database.exec("COMMIT;");
    } catch (error) {
      try { this.database.exec("ROLLBACK;"); } catch { /* preserve the original failure */ }
      throw new ProtocolError("UNKNOWN", "SQLite state import failed");
    }
  }

  close(): void {
    this.database.close();
  }

  appendChunk(chunk: Omit<StoredChunk, "createdAt">): StoredChunk {
    this.database.exec("BEGIN IMMEDIATE;");
    try {
      const existing = this.database.prepare(
        "SELECT session_id, run_id, chunk_index, role, cipher_blob, bytes, digest, created_at FROM run_bodies WHERE run_id = ? AND chunk_index = ?",
      ).get(chunk.runId, chunk.chunkIndex);
      if (existing) {
        const same = existing.session_id === chunk.sessionId && existing.role === chunk.role && existing.digest === chunk.digest;
        this.database.exec("COMMIT;");
        if (!same) throw new ProtocolError("IDEMPOTENCY_CONFLICT", "Chunk index was reused with different content");
        return this.rowToChunk(existing);
      }
      const createdAt = new Date().toISOString();
      const blob = this.encryptBody(chunk.text);
      this.database.prepare(
        "INSERT INTO run_bodies (session_id, run_id, chunk_index, role, cipher_blob, bytes, digest, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
      ).run(chunk.sessionId, chunk.runId, chunk.chunkIndex, chunk.role, blob, chunk.bytes, chunk.digest, createdAt);
      this.database.exec("COMMIT;");
      return { ...chunk, createdAt };
    } catch (error) {
      try { this.database.exec("ROLLBACK;"); } catch { /* preserve the original failure */ }
      if (error instanceof ProtocolError) throw error;
      throw new ProtocolError("UNKNOWN", "Body store write failed");
    }
  }

  readChunks(sessionId: string, runId: string, afterChunk = 0, maxBytes = 32 * 1024): ChunkPage {
    const rows = this.database.prepare(
      "SELECT session_id, run_id, chunk_index, role, cipher_blob, bytes, digest, created_at FROM run_bodies WHERE session_id = ? AND run_id = ? AND chunk_index >= ? ORDER BY chunk_index",
    ).all(sessionId, runId, afterChunk);
    const decoded = rows.map((row: any) => this.rowToChunk(row));
    return paginateChunks(decoded, afterChunk, maxBytes);
  }

  deleteSessionData(sessionId: string): void {
    this.database.exec("BEGIN IMMEDIATE;");
    try {
      this.database.prepare("DELETE FROM events WHERE aggregate_id = ?").run(sessionId);
      this.database.prepare("DELETE FROM snapshots WHERE aggregate_id = ?").run(sessionId);
      this.database.prepare("DELETE FROM run_bodies WHERE session_id = ?").run(sessionId);
      this.database.prepare("DELETE FROM idempotency_keys WHERE session_id = ?").run(sessionId);
      this.database.exec("COMMIT;");
    } catch {
      try { this.database.exec("ROLLBACK;"); } catch { /* preserve the original failure */ }
      throw new ProtocolError("UNKNOWN", "Failed to delete session data");
    }
  }

  saveIdempotency(record: Omit<StoredIdempotencyRecord, "createdAt">): void {
    this.database.prepare(
      `INSERT INTO idempotency_keys (idempotency_key, session_id, run_id, request_fingerprint, created_at)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(idempotency_key) DO NOTHING`,
    ).run(record.idempotencyKey, record.sessionId, record.runId, record.requestFingerprint, new Date().toISOString());
  }

  listIdempotency(): StoredIdempotencyRecord[] {
    const rows = this.database.prepare(
      "SELECT idempotency_key, session_id, run_id, request_fingerprint, created_at FROM idempotency_keys ORDER BY rowid",
    ).all() as Array<Record<string, unknown>>;
    return rows.map((row) => ({
      idempotencyKey: String(row.idempotency_key),
      sessionId: String(row.session_id),
      runId: String(row.run_id),
      requestFingerprint: String(row.request_fingerprint),
      createdAt: String(row.created_at),
    }));
  }

  saveDevice(record: StoredDeviceRecord): void {
    this.database.prepare(
      `INSERT INTO devices (device_id, label, scopes_json, issued_at, expires_at, revoked_at, credential_hash_hex)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(device_id) DO UPDATE SET
         label=excluded.label,
         scopes_json=excluded.scopes_json,
         issued_at=excluded.issued_at,
         expires_at=excluded.expires_at,
         revoked_at=excluded.revoked_at,
         credential_hash_hex=excluded.credential_hash_hex`,
    ).run(
      record.deviceId,
      record.label,
      JSON.stringify([...record.scopes]),
      record.issuedAt,
      record.expiresAt,
      record.revokedAt ?? null,
      record.credentialHashHex,
    );
  }

  listDevices(): StoredDeviceRecord[] {
    const rows = this.database.prepare(
      "SELECT device_id, label, scopes_json, issued_at, expires_at, revoked_at, credential_hash_hex FROM devices ORDER BY device_id",
    ).all() as Array<Record<string, unknown>>;
    return rows.map((row) => {
      const parsedScopes = JSON.parse(String(row.scopes_json));
      const scopes = Array.isArray(parsedScopes) ? parsedScopes.map((item) => String(item)) : [];
      const revokedAt = typeof row.revoked_at === "number" ? row.revoked_at : undefined;
      return {
        deviceId: String(row.device_id),
        label: String(row.label),
        scopes,
        issuedAt: Number(row.issued_at),
        expiresAt: Number(row.expires_at),
        ...(revokedAt === undefined ? {} : { revokedAt }),
        credentialHashHex: String(row.credential_hash_hex),
      };
    });
  }

  compactBodies(options: { keepLatestRunsPerSession: number }): number {
    const keep = Math.max(0, Math.floor(options.keepLatestRunsPerSession));
    this.database.exec("BEGIN IMMEDIATE;");
    try {
      const sessions = this.database.prepare("SELECT DISTINCT session_id FROM run_bodies").all() as Array<{ session_id: string }>;
      let pruned = 0;
      const selectRuns = this.database.prepare(
        "SELECT run_id FROM run_bodies WHERE session_id = ? GROUP BY run_id ORDER BY MAX(rowid) DESC",
      );
      const deleteRun = this.database.prepare("DELETE FROM run_bodies WHERE session_id = ? AND run_id = ?");
      for (const row of sessions) {
        const runs = selectRuns.all(row.session_id) as Array<{ run_id: string }>;
        for (const stale of runs.slice(keep)) {
          const result = deleteRun.run(row.session_id, stale.run_id);
          pruned += Number(result.changes ?? 0);
        }
      }
      this.database.exec("COMMIT;");
      return pruned;
    } catch {
      try { this.database.exec("ROLLBACK;"); } catch { /* preserve the original failure */ }
      throw new ProtocolError("UNKNOWN", "Body compaction failed");
    }
  }

  private encryptBody(text: string): string {
    if (!this.encryptionKey) {
      return `plain:${Buffer.from(text, "utf8").toString("base64")}`;
    }
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", this.encryptionKey, iv);
    const encrypted = Buffer.concat([cipher.update(text, "utf8"), cipher.final()]);
    const tag = cipher.getAuthTag();
    return `enc:v1:${Buffer.concat([iv, tag, encrypted]).toString("base64")}`;
  }

  private decryptBody(blob: string): string {
    if (blob.startsWith("enc:v1:")) {
      if (!this.encryptionKey) {
        throw new ProtocolError("UNKNOWN", "Encrypted run body cannot be decrypted without encryption key");
      }
      const raw = Buffer.from(blob.slice("enc:v1:".length), "base64");
      if (raw.length < 28) throw new ProtocolError("UNKNOWN", "Encrypted run body is truncated");
      const iv = raw.subarray(0, 12);
      const tag = raw.subarray(12, 28);
      const encrypted = raw.subarray(28);
      const decipher = createDecipheriv("aes-256-gcm", this.encryptionKey, iv);
      decipher.setAuthTag(tag);
      return Buffer.concat([decipher.update(encrypted), decipher.final()]).toString("utf8");
    }
    if (blob.startsWith("plain:")) {
      return Buffer.from(blob.slice("plain:".length), "base64").toString("utf8");
    }
    return blob;
  }

  private rowToChunk(row: any): StoredChunk {
    return {
      sessionId: String(row.session_id),
      runId: String(row.run_id),
      chunkIndex: Number(row.chunk_index),
      role: row.role === "prompt" ? "prompt" : "output",
      text: this.decryptBody(String(row.cipher_blob)),
      bytes: Number(row.bytes),
      digest: String(row.digest),
      createdAt: String(row.created_at),
    };
  }

  private rowToEvent(row: any): StoredEvent {
    return {
      eventId: String(row.event_id),
      aggregateId: String(row.aggregate_id),
      sequence: Number(row.sequence),
      generation: Number(row.generation),
      type: String(row.type),
      payload: JSON.parse(String(row.payload_json)),
      createdAt: String(row.created_at),
    };
  }

  private rowToSnapshot(row: any): Snapshot {
    return {
      aggregateId: String(row.aggregate_id),
      sequence: Number(row.sequence),
      generation: Number(row.generation),
      state: JSON.parse(String(row.state_json)),
      createdAt: String(row.created_at),
    };
  }
}

function paginateChunks(all: StoredChunk[], cursor: number, maxBytes: number): ChunkPage {
  const limit = Math.max(1, maxBytes);
  const chunks: StoredChunk[] = [];
  let totalBytes = 0;
  for (const chunk of all) {
    if (chunks.length > 0 && totalBytes + chunk.bytes > limit) {
      return {
        chunks,
        nextCursor: chunks[chunks.length - 1]!.chunkIndex + 1,
        hasMore: true,
      };
    }
    chunks.push(chunk);
    totalBytes += chunk.bytes;
  }
  const last = chunks[chunks.length - 1];
  return {
    chunks,
    nextCursor: last ? last.chunkIndex + 1 : cursor,
    hasMore: false,
  };
}
