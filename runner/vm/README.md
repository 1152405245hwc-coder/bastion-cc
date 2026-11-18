# VM runner boundary

The VM runner currently exposes **plan builders only**. It does not start a hypervisor, execute a guest, or claim isolation is verified. Every plan is marked `unsupported` and requires an immutable `sha256:` image digest plus a signature and signer identifier.

Launch plans enforce capability binding (device, session, runner, audience), workspace roots, command allowlisting, and `network: none`. The resulting plan includes default-deny network setup, capability binding, and an ephemeral VM. Snapshot, rollback, and destroy are represented as explicit plans so an implementation can later be audited without silently adding side effects.
