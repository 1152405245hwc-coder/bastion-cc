# Contributing

## Before opening a change

Run `npm run check`, `python3 security/verification/public_scan.py` and the relevant Python syntax checks. If the change touches protocol, storage, runner permissions, deployment templates or release gates, add a focused contract or recovery test.

Do not commit filled environment files, session databases, screenshots, logs, certificates, private keys, provider tokens, service addresses or local paths. Use the placeholders in `deploy/` and keep real deployment overlays outside the checkout.

## Design rules

- Keep control, history and execution traffic separate.
- Make retries idempotent and represent uncertain side effects as `unknown`.
- Treat the server as a trust root and runners as capability-scoped outbound clients.
- Keep provider-specific authentication behind an adapter.
- Do not add a retry, fallback or silent downgrade without a test demonstrating the reachable failure it addresses.

## Pull requests

Describe the invariant changed, the failure it prevents, and the exact checks run. A compatibility change must include its supported version and an explicit error for unsupported behavior.
