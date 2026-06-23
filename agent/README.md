# exe-agent

The Rust metrics agent. One small binary per exe.dev VM. Exposes CPU/mem/disk (and
optionally HTTP-from-logs) metrics over a localhost HTTP endpoint for the dashboard to
scrape. See [../SPEC.md](../SPEC.md) for the full design and metric schema.

## Run (stub)

```sh
cargo run            # prints intended bind address; not implemented yet
```

## Endpoints (planned)

- `GET /metrics` — JSON, see [SPEC.md#metrics-schema](../SPEC.md#metrics-schema)
- `GET /healthz` — liveness

## Notes

- Bind to `127.0.0.1` (env `AGENT_BIND`, default `127.0.0.1:9099`); the dashboard
  scrapes over SSH so the port is never publicly exposed.
- Keep dependencies minimal — this binary ships to every VM.
