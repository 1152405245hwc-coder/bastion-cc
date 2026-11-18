import { createHash, createHmac, randomInt, randomUUID, timingSafeEqual } from "node:crypto";
import { ProtocolError } from "../../../core/protocol/src/index.ts";

export type DeviceScope = "control" | "read" | "runner";

export interface EnrolledDevice {
  deviceId: string;
  label: string;
  scopes: readonly DeviceScope[];
  issuedAt: number;
  expiresAt: number;
  revokedAt?: number;
}

export interface EnrollDeviceInput {
  deviceId: string;
  label: string;
  scopes: readonly DeviceScope[];
  ttlMs?: number;
  nowMs?: number;
}

export interface PairingChallenge {
  code: string;
  deviceId: string;
  label: string;
  scopes: readonly DeviceScope[];
  expiresAt: number;
}

const VALID_SCOPES = new Set<DeviceScope>(["control", "read", "runner"]);
const DEFAULT_DEVICE_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const DEFAULT_PAIR_TTL_MS = 5 * 60 * 1000;

export class DeviceRegistry {
  private readonly devices = new Map<string, { device: EnrolledDevice; credentialHash: Buffer }>();
  private readonly pairings = new Map<string, PairingChallenge>();

  createPairingCode(input: EnrollDeviceInput): PairingChallenge {
    if (!input.deviceId || !input.label) {
      throw new ProtocolError("INVALID_ENVELOPE", "deviceId and label are required");
    }
    if (!Array.isArray(input.scopes) || input.scopes.length === 0 || input.scopes.some((s) => !VALID_SCOPES.has(s))) {
      throw new ProtocolError("INVALID_ENVELOPE", "At least one valid device scope is required");
    }
    const now = input.nowMs ?? Date.now();
    const ttlMs = input.ttlMs ?? DEFAULT_PAIR_TTL_MS;
    if (!Number.isFinite(ttlMs) || ttlMs <= 0) {
      throw new ProtocolError("INVALID_ENVELOPE", "ttlMs must be positive");
    }
    for (const [existingCode, existing] of this.pairings.entries()) {
      if (existing.expiresAt <= now) this.pairings.delete(existingCode);
    }
    let code = String(randomInt(100_000, 1_000_000));
    while (this.pairings.has(code)) {
      code = String(randomInt(100_000, 1_000_000));
    }
    const challenge: PairingChallenge = {
      code,
      deviceId: input.deviceId,
      label: input.label,
      scopes: [...new Set(input.scopes)],
      expiresAt: now + ttlMs,
    };
    this.pairings.set(code, challenge);
    return { ...challenge, scopes: [...challenge.scopes] };
  }

  redeemPairingCode(code: string, nowMs = Date.now()): { device: EnrolledDevice; credential: string } {
    const normalized = typeof code === "string" ? code.trim() : "";
    const challenge = normalized ? this.pairings.get(normalized) : undefined;
    if (!challenge) {
      throw new ProtocolError("NOT_FOUND", "Invalid or expired pairing code");
    }
    this.pairings.delete(normalized);
    if (challenge.expiresAt <= nowMs) {
      throw new ProtocolError("NOT_FOUND", "Invalid or expired pairing code");
    }
    return this.enroll({
      deviceId: challenge.deviceId,
      label: challenge.label,
      scopes: challenge.scopes,
      nowMs,
    });
  }

  enroll(input: EnrollDeviceInput): { device: EnrolledDevice; credential: string } {
    if (!input.deviceId || !input.label) {
      throw new ProtocolError("INVALID_ENVELOPE", "deviceId and label are required");
    }
    if (!Array.isArray(input.scopes) || input.scopes.length === 0 || input.scopes.some((s) => !VALID_SCOPES.has(s))) {
      throw new ProtocolError("INVALID_ENVELOPE", "At least one valid device scope is required");
    }
    const now = input.nowMs ?? Date.now();
    const ttlMs = input.ttlMs ?? DEFAULT_DEVICE_TTL_MS;
    if (!Number.isFinite(ttlMs) || ttlMs <= 0) {
      throw new ProtocolError("INVALID_ENVELOPE", "ttlMs must be positive");
    }
    const credential = `ccrf_dev_${randomUUID()}`;
    const device: EnrolledDevice = {
      deviceId: input.deviceId,
      label: input.label,
      scopes: [...new Set(input.scopes)],
      issuedAt: now,
      expiresAt: now + ttlMs,
    };
    this.devices.set(input.deviceId, {
      device,
      credentialHash: hashCredential(credential),
    });
    return { device: copyDevice(device), credential };
  }

  verify(bearerValue: string, requiredScope: DeviceScope, nowMs = Date.now()): EnrolledDevice | undefined {
    if (!bearerValue) return undefined;
    const candidateHash = hashCredential(bearerValue);
    let matched: EnrolledDevice | undefined;
    for (const entry of this.devices.values()) {
      if (timingSafeEqual(entry.credentialHash, candidateHash)) {
        matched = entry.device;
      }
    }
    if (!matched) return undefined;
    if (matched.revokedAt !== undefined && matched.revokedAt <= nowMs) return undefined;
    if (matched.issuedAt > nowMs || matched.expiresAt <= nowMs) return undefined;
    if (!matched.scopes.includes(requiredScope)) return undefined;
    return copyDevice(matched);
  }

  revoke(deviceId: string, nowMs = Date.now()): EnrolledDevice {
    const entry = this.devices.get(deviceId);
    if (!entry) throw new ProtocolError("NOT_FOUND", "Device not found", { deviceId });
    entry.device.revokedAt = nowMs;
    return copyDevice(entry.device);
  }

  list(): EnrolledDevice[] {
    return [...this.devices.values()]
      .map((entry) => copyDevice(entry.device))
      .sort((left, right) => left.deviceId.localeCompare(right.deviceId));
  }
}

export interface AuthHeaders {
  authorization?: string;
  totp?: string;
}

export interface AuthPolicy {
  bearerToken?: string;
  totpSecret?: string;
  nowMs?: number;
  totpWindow?: number;
  deviceRegistry?: DeviceRegistry;
  requiredScope?: DeviceScope;
}

/** Bearer / scoped-device plus optional RFC 6238 TOTP check. Secrets never enter error text. */
export function authorize(headers: AuthHeaders, policy: AuthPolicy): boolean {
  if (policy.totpSecret && !verifyTotp(policy.totpSecret, headers.totp ?? "", policy.nowMs ?? Date.now(), policy.totpWindow ?? 1)) {
    return false;
  }
  const hasEnrolledDevices = Boolean(policy.deviceRegistry && policy.deviceRegistry.list().length > 0);
  const authHeader = headers.authorization ?? "";
  if (policy.bearerToken || hasEnrolledDevices) {
    if (policy.bearerToken && safeEqual(authHeader, `Bearer ${policy.bearerToken}`)) {
      return true;
    }
    if (policy.deviceRegistry && authHeader.startsWith("Bearer ")) {
      const candidate = authHeader.slice("Bearer ".length);
      if (policy.deviceRegistry.verify(candidate, policy.requiredScope ?? "control", policy.nowMs)) {
        return true;
      }
    }
    return false;
  }
  return Boolean(policy.totpSecret) || !headers.authorization;
}

export function verifyTotp(secretBase32: string, code: string, nowMs: number, window: number): boolean {
  if (!/^\d{6}$/.test(code) || !Number.isInteger(window) || window < 0 || window > 3) return false;
  const keyBytes = decodeBase32(secretBase32);
  if (keyBytes.length === 0) return false;
  const counter = Math.floor(nowMs / 30_000);
  for (let offset = -window; offset <= window; offset += 1) {
    const expected = totp(keyBytes, counter + offset);
    if (safeEqual(expected, code)) return true;
  }
  return false;
}

function copyDevice(device: EnrolledDevice): EnrolledDevice {
  return {
    deviceId: device.deviceId,
    label: device.label,
    scopes: [...device.scopes],
    issuedAt: device.issuedAt,
    expiresAt: device.expiresAt,
    ...(device.revokedAt === undefined ? {} : { revokedAt: device.revokedAt }),
  };
}

function hashCredential(value: string): Buffer {
  return createHash("sha256").update(value, "utf8").digest();
}

function totp(secret: Buffer, counter: number): string {
  const message = Buffer.alloc(8);
  message.writeBigInt64BE(BigInt(Math.max(0, counter)));
  const digest = createHmac("sha1", secret).update(message).digest();
  const index = digest[digest.length - 1]! & 0x0f;
  const binary = ((digest[index]! & 0x7f) << 24) | (digest[index + 1]! << 16) | (digest[index + 2]! << 8) | digest[index + 3]!;
  return String(binary % 1_000_000).padStart(6, "0");
}

function safeEqual(left: string, right: string): boolean {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}

function decodeBase32(value: string): Buffer {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  const normalized = value.toUpperCase().replace(/=+$/, "").replace(/\s+/g, "");
  let bits = 0;
  let buffer = 0;
  const output: number[] = [];
  for (const char of normalized) {
    const digit = alphabet.indexOf(char);
    if (digit < 0) return Buffer.alloc(0);
    buffer = (buffer << 5) | digit;
    bits += 5;
    if (bits >= 8) {
      bits -= 8;
      output.push((buffer >> bits) & 0xff);
    }
  }
  return Buffer.from(output);
}
