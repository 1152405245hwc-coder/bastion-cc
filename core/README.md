# Core

The core packages contain pure protocol, event and capability rules. They do not open sockets, spawn processes, read deployment files or authenticate a provider.

- `protocol`: envelopes, negotiation and public error codes.
- `events`: event replay contracts used by the compatibility tests.
- `capabilities`: workspace, command and network scope checks.
