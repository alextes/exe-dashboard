# exe-dashboard

A minimal usage dashboard for [exe.dev](https://exe.dev) VMs.

It collects per-VM **CPU / memory / disk** usage and **HTTP request** metrics, and
renders them in a single password-protected web UI. It starts by reporting on the
VM it runs on (`victor-omnibus`) and is built so new VMs are easy to add as targets.

## Why

I run VMs on exe.dev and want one place to see how each is doing — resource usage
plus how much traffic the public-facing services are handling. exe.dev itself is
SSH-native and has no built-in fleet dashboard, so this fills that gap.

## How it works (in one breath)

- A small **Rust agent** (`agent/`) runs on each VM and exposes the metrics we care
  about over a local HTTP endpoint.
- A **TypeScript/Node dashboard** (`dashboard/`) scrapes each target VM's agent on an
  interval, keeps recent samples, and serves a minimal UI behind a password login.
- Adding a VM = deploy the agent there + add a line to the targets config.

```
  ┌──────────────┐        scrape         ┌──────────────────────┐
  │ exe-agent    │◀──────(ssh/http)──────│ dashboard (Node)     │
  │ (Rust, on    │                       │  - scrapes targets   │
  │  each VM)    │   CPU/mem/disk/http   │  - login + web UI    │
  └──────────────┘                       │  - public on a VM    │
                                         └──────────────────────┘
```

## Status

MVP work is underway:

- `agent/` serves `GET /healthz` and schema-v1 `GET /metrics` with CPU, memory, disk,
  and `http.source = "none"`.
- `dashboard/` serves a password-gated UI, scrapes the local agent, tracks its own
  inbound HTTP request metrics, and keeps recent samples in memory.

Multi-VM targets, SSH scraping, access-log HTTP metrics, and deploy automation are
still on the [roadmap](SPEC.md#roadmap).

## Layout

| Path          | What                                                          |
| ------------- | ------------------------------------------------------------- |
| `agent/`      | Rust metrics agent — one small binary deployed to each VM.    |
| `dashboard/`  | TypeScript/Node dashboard server + UI.                        |
| `SPEC.md`     | Architecture, metrics schema, scrape model, deploy, roadmap.  |
| `AGENTS.md`   | Conventions for working in this repo (read this first).       |

## Quick start

```sh
cd agent
cargo run

cd ../dashboard
npm install
npm run dev
```

The dashboard defaults to `http://127.0.0.1:8080` and the local dev password is
`password`.

## License

[MIT](LICENSE)
