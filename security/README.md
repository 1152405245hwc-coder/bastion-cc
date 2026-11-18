# Security & Verification

Read-only verification utilities protecting release hygiene and deployment network boundaries:

- `verification/public_scan.py`: scans tracked/working files for IP literals, private keys, user paths, long numeric IDs, and forbidden patterns before publication.
- `verification/release_gate.py`: verifies clean Git worktree, generic commit identity across all reachable commits, absence of runtime/key artifacts, extended attributes, and secret shapes.
- `verification/network_check.py`: fail-closed verifier for HTTP proxy HTTPS egress, direct HTTPS baseline, DNS resolution, IPv4/IPv6/UDP reachability, and Linux Docker POSTROUTING MASQUERADE rules.
