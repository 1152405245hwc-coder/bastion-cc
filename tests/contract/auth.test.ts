import test from "node:test";
import assert from "node:assert/strict";
import { authorize, DeviceRegistry, verifyTotp } from "../../server/auth/src/index.ts";

test("TOTP verifies RFC 6238-compatible six digit code", () => {
  const seed = "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ";
  assert.equal(verifyTotp(seed, "287082", 59_000, 0), true);
  assert.equal(verifyTotp(seed, "000000", 59_000, 0), false);
});

test("auth policy requires bearer and optional TOTP without exposing secrets", () => {
  const seed = "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ";
  assert.equal(authorize({ authorization: "Bearer token", totp: "287082" }, { bearerToken: "token", totpSecret: seed, nowMs: 59_000, totpWindow: 0 }), true);
  assert.equal(authorize({ authorization: "Bearer token" }, { bearerToken: "token", totpSecret: seed, nowMs: 59_000, totpWindow: 0 }), false);
});

test("DeviceRegistry enforces scoped credentials, expiry, and revocation", () => {
  const registry = new DeviceRegistry();
  const now = 1_000_000;
  const { device, credential } = registry.enroll({
    deviceId: "dev-phone",
    label: "Mobile Web",
    scopes: ["read"],
    ttlMs: 60_000,
    nowMs: now,
  });
  assert.equal(device.deviceId, "dev-phone");
  assert.equal(JSON.stringify(registry.list()).includes(credential), false);

  assert.ok(authorize({ authorization: `Bearer ${credential}` }, { deviceRegistry: registry, requiredScope: "read", nowMs: now + 1000 }));
  assert.equal(authorize({ authorization: `Bearer ${credential}` }, { deviceRegistry: registry, requiredScope: "control", nowMs: now + 1000 }), false);
  assert.equal(authorize({ authorization: `Bearer ${credential}` }, { deviceRegistry: registry, requiredScope: "read", nowMs: now + 70_000 }), false);

  registry.revoke("dev-phone", now + 2000);
  assert.equal(authorize({ authorization: `Bearer ${credential}` }, { deviceRegistry: registry, requiredScope: "read", nowMs: now + 3000 }), false);
});

test("DeviceRegistry issues single-use 6-digit pairing codes with expiry", () => {
  const registry = new DeviceRegistry();
  const now = 2_000_000;
  const challenge = registry.createPairingCode({
    deviceId: "cli-laptop",
    label: "Mac CLI",
    scopes: ["control", "read"],
    ttlMs: 30_000,
    nowMs: now,
  });
  assert.match(challenge.code, /^\d{6}$/);

  const redeemed = registry.redeemPairingCode(challenge.code, now + 5000);
  assert.equal(redeemed.device.deviceId, "cli-laptop");
  assert.ok(redeemed.credential.startsWith("ccrf_dev_"));
  assert.ok(authorize({ authorization: `Bearer ${redeemed.credential}` }, { deviceRegistry: registry, requiredScope: "control", nowMs: now + 6000 }));

  assert.throws(() => registry.redeemPairingCode(challenge.code, now + 7000), /Invalid or expired pairing code/);

  const expired = registry.createPairingCode({
    deviceId: "phone-late",
    label: "Late Phone",
    scopes: ["read"],
    ttlMs: 1000,
    nowMs: now,
  });
  assert.throws(() => registry.redeemPairingCode(expired.code, now + 2000), /Invalid or expired pairing code/);
});
