# Security Policy

## Trust model

The server is a trust root for its own account, session metadata and provider traffic. This project does not claim end-to-end encryption when the server runs the provider adapter.

A runner connects outbound and receives short-lived, scoped capabilities. The server must not receive ambient root, a Docker socket, an unrestricted shell, or an unbounded workspace.

## Reportable risks

Report suspected:

- capability escalation, path traversal or symlink escape;
- replay or duplicate side effects for one command;
- stale-generation responses changing current state;
- protocol downgrade or authentication bypass;
- plaintext credentials, conversation bodies or personal data in logs/events/releases;
- upgrade or migration paths that cannot roll back safely.

Do not include real tokens, private keys, service addresses, session data or screenshots in a report.

## Release requirements

Every public release must pass:

- contract and recovery tests;
- dependency and secret-shape scans;
- a clean-clone release gate;
- signed artifacts, checksums and an SBOM;
- documented migration and rollback steps.

Known failures remain visible and block release.
