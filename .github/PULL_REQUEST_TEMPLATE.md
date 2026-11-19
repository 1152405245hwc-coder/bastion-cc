## Summary
- What invariant changed or what feature/fix was added:

## Verification
- [ ] `npm run check` (runtime syntax check + Node test suite + privacy gate)
- [ ] `npm run test:python`
- [ ] `python3 -B security/verification/public_scan.py`
- [ ] `python3 -B security/verification/release_gate.py`

## Checklist
- [ ] No real secrets, private keys, hosts, local `/Users` or `/home` paths, or `.sqlite`/`.log` artifacts included
- [ ] Updated docs / capability matrix if behavior or configuration changed
