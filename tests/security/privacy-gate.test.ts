import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

test("public_scan.py passes with zero production secrets, IPs, user paths, or legacy references", () => {
  const output = execFileSync("python3", ["-B", "security/verification/public_scan.py"], {
    cwd: REPO_ROOT,
    encoding: "utf8",
  });
  assert.match(output, /^PUBLIC_SCAN_OK files=\d+/);
});

test("release_gate.py passes privacy, xattr, artifact, and identity checks", () => {
  const output = execFileSync("python3", ["-B", "security/verification/release_gate.py", "--allow-dirty"], {
    cwd: REPO_ROOT,
    encoding: "utf8",
  });
  assert.match(output, /^RELEASE_GATE_OK files=\d+ commits=\d+/);
});

test("full reachable git history contains no personal paths, private keys, non-placeholder authors, or legacy terms", () => {
  if (!existsSync(resolve(REPO_ROOT, ".git"))) return;

  const identities = execFileSync("git", ["-C", REPO_ROOT, "log", "--format=%an|%ae|%cn|%ce", "--all"], {
    encoding: "utf8",
  }).trim().split(/\r?\n/).filter(Boolean);
  assert.ok(identities.length >= 1, "expected at least one commit");
  for (const row of identities) {
    assert.equal(row, "CC Relay Forge|noreply@example.invalid|CC Relay Forge|noreply@example.invalid");
  }

  const patch = execFileSync("git", ["-C", REPO_ROOT, "log", "--all", "-p"], {
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });

  const macPath = new RegExp(`${["/User", "s/"].join("")}[A-Za-z0-9._-]+`, "g");
  const linuxPath = new RegExp(`${["/ho", "me/"].join("")}[A-Za-z0-9._-]+`, "g");
  const privateKey = new RegExp(`BEGIN (?:OPENSSH|RSA|EC|DSA|[A-Z0-9 ]+) ${["PRIVATE", "KEY"].join(" ")}`, "g");
  const legacyBrand = new RegExp(
    `\\b(?:${[
      ["desk", "tunnel"].join(""),
      ["cc-", "desk-", "tunnel"].join(""),
      ["cc", "desk"].join(""),
      ["sun", "168567"].join(""),
    ].join("|")})\\b`,
    "i",
  );

  assert.equal(legacyBrand.test(patch), false, "git history must not contain legacy third-party brand terms");

  for (const line of patch.split(/\r?\n/)) {
    if (line.includes("re.compile(")) continue;
    const macMatches = (line.match(macPath) ?? []).filter((item) => !item.endsWith("/example"));
    const linuxMatches = (line.match(linuxPath) ?? []).filter((item) => !item.endsWith("/example"));
    assert.deepEqual(macMatches, [], `unexpected macOS path in git history: ${line}`);
    assert.deepEqual(linuxMatches, [], `unexpected Linux path in git history: ${line}`);
    assert.equal(privateKey.test(line), false, `unexpected private key marker in git history: ${line}`);
  }
});
