# Threat model

## Assets

- provider credentials and model requests;
- workspace files and command output;
- session history, approvals and drafts;
- capability tokens, leases and release artifacts.

## Threats

- stolen service or device token;
- replayed command or approval;
- confused deputy across devices or sessions;
- stale response after a session switch;
- workspace path traversal or symlink escape;
- slow consumer exhausting memory;
- malicious or unsigned upgrade;
- logs, notifications or public releases leaking secrets.

## Required controls

- capability tokens bind device, session, runner, audience, nonce, expiry and scope;
- revoked tokens and leases fail closed;
- canonicalize workspace paths and reject escapes;
- default-deny command, network and credential scopes;
- idempotency keys prevent duplicate side effects;
- unknown outcomes require query or human confirmation;
- logs and notifications omit bodies, tokens and full paths;
- releases require signatures, checksums, SBOM and a clean-clone privacy gate.

The server remains a trust root. A compromised server can observe provider traffic and session metadata.
