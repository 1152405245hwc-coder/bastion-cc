import { dirname, relative, resolve, sep } from "node:path";
import { existsSync, realpathSync } from "node:fs";
import { ProtocolError } from "../../protocol/src/index.ts";

export type NetworkScope = "none" | "allowlist" | "any";

export interface CapabilityScope {
  workspaceRoots: readonly string[];
  commands: readonly string[];
  network: NetworkScope;
  networkTargets: readonly string[];
  approval: boolean;
  credentialRefs: readonly string[];
}

export interface CapabilityToken {
  tokenId: string;
  deviceId: string;
  sessionId: string;
  runnerId: string;
  audience: string;
  nonce: string;
  issuedAt: number;
  expiresAt: number;
  scope: CapabilityScope;
  revokedAt?: number;
}

export interface CapabilityContext {
  deviceId: string;
  sessionId: string;
  runnerId: string;
  audience: string;
  now?: number;
}

export function validateCapability(token: CapabilityToken, context: CapabilityContext): void {
  const now = context.now ?? Date.now();
  if (token.deviceId !== context.deviceId || token.sessionId !== context.sessionId || token.runnerId !== context.runnerId) {
    throw new ProtocolError("CAPABILITY_DENIED", "Capability is bound to another execution context");
  }
  if (token.audience !== context.audience) {
    throw new ProtocolError("CAPABILITY_DENIED", "Capability audience mismatch");
  }
  if (token.revokedAt !== undefined && token.revokedAt <= now) {
    throw new ProtocolError("CAPABILITY_DENIED", "Capability has been revoked");
  }
  if (token.expiresAt <= now || token.issuedAt > now) {
    throw new ProtocolError("CAPABILITY_DENIED", "Capability is outside its validity window");
  }
}

function canonicalizeExistingPrefix(candidate: string): string {
  let current = resolve(candidate);
  const tail: string[] = [];
  while (!existsSync(current)) {
    const parent = dirname(current);
    if (parent === current) return resolve(candidate);
    tail.unshift(current.slice(parent.length).replace(/^[/\\]+/, ""));
    current = parent;
  }
  return resolve(realpathSync.native(current), ...tail);
}

export function assertWorkspacePath(token: CapabilityToken, candidate: string): string {
  const path = canonicalizeExistingPrefix(candidate);
  const allowed = token.scope.workspaceRoots.some((root) => {
    const normalized = canonicalizeExistingPrefix(root);
    const rel = relative(normalized, path);
    return rel === "" || (!rel.startsWith(`..${sep}`) && rel !== ".." && !rel.includes(`${sep}..${sep}`));
  });
  if (!allowed) {
    throw new ProtocolError("CAPABILITY_DENIED", "Path is outside the capability workspace roots", { candidate });
  }
  return path;
}

export function assertCommandAllowed(token: CapabilityToken, command: string): void {
  if (!token.scope.commands.includes(command) && !token.scope.commands.includes("*")) {
    throw new ProtocolError("CAPABILITY_DENIED", "Command is not included in the capability", { command });
  }
}

export function assertNetworkAllowed(token: CapabilityToken, target: string): void {
  if (token.scope.network === "none") {
    throw new ProtocolError("CAPABILITY_DENIED", "Network access is disabled", { target });
  }
  if (token.scope.network === "allowlist" && !token.scope.networkTargets.includes(target)) {
    throw new ProtocolError("CAPABILITY_DENIED", "Network target is not allowlisted", { target });
  }
}
