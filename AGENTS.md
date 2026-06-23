# Working in exe-dashboard

Read [SPEC.md](SPEC.md) first — it's the design source of truth and the exe.dev
platform notes you'd otherwise have to re-research.

## What this is

A two-part usage dashboard for exe.dev VMs:
- `agent/` — a small **Rust** binary deployed to each VM that exposes metrics.
- `dashboard/` — a **TypeScript/Node** server that scrapes targets and serves a
  password-gated UI.

## Conventions

- **Keep the agent's dependency tree small** — it's copied to every VM.
- **Public repo:** never commit secrets. The login password (defaults to `password` for
  local dev) and session secret come from env vars (`DASHBOARD_PASSWORD`,
  `SESSION_SECRET`); see `.env.example`. The real prod value is set via the VM's env,
  not in code.
- **Metrics schema is a contract** between agent and dashboard — see
  [SPEC.md#metrics-schema](SPEC.md#metrics-schema). Bump `schema` if you change it.
- kebab-case for any new files/dirs; match the house style.
- Lean dashboard UI — server-rendered HTML + a little JS over a heavy SPA framework.

## Layout

```
agent/        Rust crate (Cargo.toml, src/main.rs) — the metrics agent
dashboard/    Node + TS (package.json, tsconfig.json, src/) — server + UI
SPEC.md       Architecture, schema, scrape model, deploy, roadmap
```

## Build / run (once implemented)

- Agent: `cd agent && cargo run` → serves `/metrics` on localhost.
- Dashboard: `cd dashboard && npm install && npm run dev`.

Both are currently **stubs** — start from the [roadmap](SPEC.md#roadmap).
