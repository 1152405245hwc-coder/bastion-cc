# Deployment templates

Everything under this directory is optional, version-bound deployment material. Replace placeholders in a private overlay and validate the target host before installation.

- `macos/compat`: isolated OAuth browser wrapper (`claude-us-browser`) and dedicated SOCKS5 LaunchAgent template.
- `server`: private environment template for the public HTTP server.
- `vps`: firewall/NAT protection, safe reboot, notification, BBR/fq, zram, journald and unattended-upgrades templates.

Real addresses, usernames, keys, tokens, certificates, session databases and filled environment files stay outside Git.
