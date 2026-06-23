# dashboard

The TypeScript/Node dashboard server + UI. Scrapes each target VM's agent, keeps recent
samples, and serves a minimal password-gated view of CPU/mem/disk + HTTP request
metrics. This is the public-facing service that runs on `victor-omnibus`. See
[../SPEC.md](../SPEC.md) for the full design.

## Run

```sh
npm install
cd ../agent && cargo run
cd ../dashboard && npm run dev
```

## Config

Copy [`../.env.example`](../.env.example) to `.env` (gitignored) and set
`DASHBOARD_PASSWORD`, `SESSION_SECRET`, `PORT`. Targets come from a gitignored
`targets.json` — see [SPEC.md#targets--adding-vms](../SPEC.md#targets--adding-vms).

## Notes

- Password defaults to `password` for local dev but is read from `DASHBOARD_PASSWORD`; the prod value is set via env (never committed).
- Counts its own inbound requests via middleware → real HTTP metrics for its own host.
- Scrapes the local Rust agent at `AGENT_METRICS_URL` (default `http://127.0.0.1:9099/metrics`) every 10s.
- Keep the UI lean: server-rendered HTML + a little JS, no heavy SPA framework.
