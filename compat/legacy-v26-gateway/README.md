# Legacy v26 Compatibility Gateway

Pure protocol translation helper converting v26 message envelopes into the v1 control-plane envelope format and translating events back to v26 shape. It never opens sockets, listens on ports, or writes to legacy databases; unsupported legacy commands fail explicitly with `GatewayError("UNSUPPORTED", ...)`.
