# Public deployment profile

This repository contains reusable policies and templates. It does not contain a production address, domain, user name, OAuth state, certificate, private key, bot token, chat ID or session database.

## Local control server

The HTTP entry point binds to `127.0.0.1` by default. A non-loopback bind fails unless `CCRF_AUTH_TOKEN` is present. Store the token in a private environment file with mode `0600`; never put it in a command recorded in shell history or in a unit file.

```sh
install -d -m 700 .local
umask 077
export CCRF_EVENT_DB="$PWD/.local/events.sqlite"
npm run start:server
```

The server limits JSON body size, bounds request headers and idle keep-alive time, redacts prompt bodies from run and event responses, disables caching, and returns explicit errors. It does not trust `HTTP_PROXY` or `HTTPS_PROXY` for its control listener. For a public/mobile entry point, set both `CCRF_AUTH_TOKEN` and `CCRF_TOTP_SECRET`; clients send the short-lived code in `X-CCRF-TOTP`.

## macOS OAuth isolation

`deploy/macos/compat/bin/claude-us-browser` keeps the dedicated browser profile, timezone/locale, SOCKS5 proxy, WebRTC restrictions and fail-closed resolver rule together. The resolver rule is intentional: if the SOCKS path is unavailable, hostname resolution must not silently fall back to local DNS. The native Electron desktop shell routes Claude OAuth URLs directly through `clients/desktop/src/link-router.mjs` without external binary patching.

## VPS hardening

- Install the named nftables table after replacing placeholders, and keep the `keep-docker.conf` drop-in. The drop-in deletes only the project's table; it must not flush the ruleset that Docker uses for MASQUERADE.
- Keep the notification sidecar read-only and run it as the database owner (`1000:1000` in the reference deployment). The environment file stays outside Git with mode `0600`.
- Run the safe reboot gate in dry-run mode first. It defers when package locks, certificate renewal, Claude processes, Docker inspection or active runs are unknown.
- Keep BBR/fq, zstd zram, journald limits and unattended upgrades as host policy. They are deployment choices, not protocol assumptions.
- The public templates include persistent BBR module loading, a 100 MiB journald cap and unattended-upgrades with automatic hard reboot disabled. Apply them only after reviewing the host's package policy.

## Backups and rollback

Back up the SQLite database, deployment configuration and release manifest to a private `0700` directory before upgrades. Use an atomic replacement or a separate release directory, keep the previous manifest, and route traffic back to the previous server if health, cursor recovery or runner attachment fails.
