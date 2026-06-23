# exe-dashboard — Spec

A usage dashboard for [exe.dev](https://exe.dev) VMs. This document is the source of
truth for the design. It is written so a fresh session (human or agent) can pick up
and build from here without re-researching exe.dev.

## Goals

1. Report **CPU / memory / disk** usage for a VM.
2. Report **HTTP request** metrics — how many requests the VM's public service is
   handling.
3. Start by reporting on **`victor-omnibus`** (the VM that will host the dashboard),
   then make it trivial to add other VMs as targets.
4. A **minimal login page** gating the dashboard. The password is read from an env var
   (defaults to `password` for local dev; the real prod value is set via env, never
   committed). See [Auth](#auth-login).
5. Whatever the mechanism, it must generalize to metrics collected from **other VMs**.
   A small deployable binary that makes the exact metrics scrapable is acceptable and
   is the chosen approach.

## Non-goals (for now)

- Alerting / paging.
- Long-term metric retention or a real TSDB (start with in-memory recent samples).
- Multi-user auth, roles, SSO. One shared password is enough.

---

## Platform facts (exe.dev)

These shaped the design — confirm against https://exe.dev/docs/all if anything looks off.

- VMs are **full Ubuntu 24.04 VMs** (Cloud Hypervisor), with **systemd** and **root**.
  Long-running daemons are fine. Persistent block storage per VM.
- The interface is **SSH-native**:
  - Management API: `ssh exe.dev <command> [--json]` (e.g. `ssh exe.dev ls --json`
    lists all your VMs — useful for auto-discovering targets later).
  - Per-VM shell: `ssh <vmname>.exe.xyz`.
  - Constraints on the management API: no stdin/pty, 30s timeout, 64KB body limit.
- **Networking:** VMs are **private by default**. Ports **3000–9999** are proxied over
  HTTPS at `https://<vmname>.exe.xyz:<port>/`. A port can be made public with
  `ssh exe.dev share set-public <vmname>` / `ssh exe.dev share port <vmname> <port>`.
  exe.dev terminates TLS and proxies to the VM.
- API keys: `ssh exe.dev ssh-key generate-api-key`, scopable to commands like `ls`.

Docs: https://exe.dev/docs/all · API: https://exe.dev/docs/api · Proxy: https://exe.dev/docs/proxy

---

## Components

### `agent/` — exe-agent (Rust)

A single small binary deployed to each VM. Responsibilities:

- Serve `GET /metrics` (and `GET /healthz`) over HTTP, bound to `127.0.0.1:<port>`
  by default (default port e.g. `9099`). Private by default; see [Scrape model](#scrape-model).
- Collect and return the [metrics schema](#metrics-schema) below.

Recommended crates (final choice is the builder's): `sysinfo` for CPU/mem/disk,
a light HTTP server (`axum` or `tiny_http`), `serde`/`serde_json` for output. Keep the
dependency tree small — this binary gets copied to every VM.

System metrics come from `sysinfo`. **HTTP request metrics** are the interesting part —
see [HTTP metrics](#http-request-metrics).

Distribution: build a static-ish release binary; deploy per the [Deployment](#deployment)
section. Follow the repo's `cargo-dist` / `install.sh` convention if it grows public.

### `dashboard/` — dashboard (TypeScript/Node)

The central server. This is the thing that runs publicly on `victor-omnibus`.
Responsibilities:

- **Scrape** each configured [target](#targets--adding-vms) on an interval (e.g. 10s),
  keep a rolling window of recent samples per VM (in-memory ring buffer to start).
- **Serve the UI**: one page listing VMs with CPU/mem/disk gauges + HTTP request
  count/rate, with small sparklines. Keep it dependency-light; server-rendered HTML +
  a little JS is fine. No heavy SPA framework required.
- **Login**: see [Auth](#auth-login).
- **Self-metrics**: the dashboard counts its own inbound HTTP requests via middleware,
  so the VM hosting the dashboard reports real "requests handled" numbers even before
  any agent log-tailing exists.

Suggested stack: Node 26 + TypeScript, a minimal HTTP layer (`express`/`fastify` or
even `node:http`), `tsx`/`tsc` for dev/build. Builder's choice — keep it lean.

---

## Metrics schema

The agent returns JSON (our own format — simple, versioned). Keep it stable; the
dashboard depends on it.

```jsonc
{
  "schema": 1,
  "vm": "victor-omnibus",        // hostname / logical name
  "ts": 1750000000,              // unix seconds, sample time
  "uptime_s": 123456,
  "cpu": {
    "usage_pct": 12.5,           // overall, 0..100
    "cores": 4,
    "load_avg": [0.30, 0.25, 0.20]
  },
  "mem": {
    "total_bytes": 8589934592,
    "used_bytes": 3221225472,
    "used_pct": 37.5
  },
  "disk": [
    { "mount": "/", "total_bytes": 53687091200, "used_bytes": 21474836480, "used_pct": 40.0 }
  ],
  "http": {
    "source": "self|access_log|none",
    "total_requests": 10342,     // cumulative since agent/dashboard start (or log epoch)
    "window_s": 60,
    "requests_in_window": 87,    // requests in the last window_s
    "rps": 1.45
  }
}
```

Notes:
- `total_requests` is a monotonic counter; the dashboard derives rates from deltas
  between samples (robust to the agent's own window).
- Bytes everywhere (no pre-formatting); the UI humanizes.

### HTTP request metrics

"How many requests is it handling" — to the VM's public service. Two sources, pick per VM:

1. **`self`** — the dashboard server (Node) counts its own inbound requests via
   middleware. This is the primary source for `victor-omnibus`, since that VM *is* the
   public dashboard. No log parsing needed. Works today.
2. **`access_log`** — for other VMs running their own web service, the Rust agent tails
   that service's access log (nginx/caddy/app log), with a configurable path + format,
   and maintains the counter. This generalizes HTTP metrics to any VM.

Start with `self`; add `access_log` tailing in the agent when the first non-dashboard
VM needs HTTP numbers.

---

## Scrape model

VMs are private by default on exe.dev, which gives us two clean options. **Default to
SSH scraping**; it needs no public ports and no extra secret beyond SSH access.

- **SSH scrape (recommended):** dashboard runs `ssh <vm>.exe.xyz curl -s localhost:<port>/metrics`
  (or `ssh exe.dev exec ...`). Agent stays bound to localhost — never publicly exposed.
  Leverages exe.dev's native auth. Cost: spawning ssh per scrape (fine at fleet sizes
  of tens of VMs; pool/reuse connections if it grows).
- **Authenticated HTTP scrape (alternative):** make the agent port public
  (`ssh exe.dev share set-public`) and require `Authorization: Bearer <token>` on the
  agent. Dashboard sends the token. Avoids ssh process spawns; costs a public port +
  shared secret management.

The dashboard's scrape layer should abstract "fetch metrics for target T" so the two
transports are interchangeable per target.

---

## Targets / adding VMs

A target is `{ name, transport: "ssh"|"http", host, port, token? }`. Source it from a
gitignored `targets.json` (or env). Example:

```jsonc
[
  { "name": "victor-omnibus", "transport": "self" },                       // dashboard's own host
  { "name": "other-vm", "transport": "ssh", "host": "other-vm.exe.xyz", "port": 9099 }
]
```

Adding a VM = deploy the agent there (if not `self`) + add a target entry. Later this
can be auto-populated from `ssh exe.dev ls --json`.

---

## Auth (login)

- One shared password. Read from env `DASHBOARD_PASSWORD`, **defaulting to `password`**
  for local dev. The production value is set via env on the VM and is **never committed**,
  important because this repo is public.
- Minimal flow: `GET /login` → password form → set a signed, http-only session cookie
  → middleware gates all other routes. Use an env `SESSION_SECRET` (random) for signing.
- No user accounts, no registration. Logout clears the cookie.

See `.env.example` for the variables.

---

## Deployment

Target: `victor-omnibus` first. Follow the user's house convention (daemonized process
+ `@reboot` cron, à la `ava-deploy`) rather than hand-rolling systemd — though systemd
is available on exe.dev if preferred.

Rough shape:
- **Agent:** copy the release binary to the VM, run it as a service bound to localhost.
- **Dashboard:** run the Node server on a port in 3000–9999, then
  `ssh exe.dev share port victor-omnibus <port>` + `ssh exe.dev share set-public victor-omnibus`
  to expose the login page publicly at `https://victor-omnibus.exe.xyz:<port>/`.
- Secrets (`DASHBOARD_PASSWORD`, `SESSION_SECRET`) via env file with `0600` perms, kept
  out of git.

A dedicated deploy flow / repo can come later if secrets warrant it.

---

## Roadmap

Milestones, roughly in order:

1. **Agent MVP (Rust):** `sysinfo`-backed `GET /metrics` returning CPU/mem/disk per the
   schema; `GET /healthz`. `http.source = "none"` for now. Bind localhost.
2. **Dashboard MVP (Node):** login page + session cookie; one target (`self`); request-
   counting middleware → real HTTP metrics for the host; system metrics from a local
   agent scrape; minimal HTML UI with gauges + sparklines.
3. **Multi-target scrape:** `targets.json`, SSH-scrape transport, rolling per-VM history,
   UI lists multiple VMs.
4. **HTTP-from-logs:** agent `access_log` tailing so non-dashboard VMs report HTTP metrics.
5. **Niceties:** auto-discover targets via `ssh exe.dev ls --json`; optional SQLite for
   retention; auth-token HTTP transport; deploy script.

## Open questions

- Scrape transport default — SSH vs authenticated HTTP. Spec leans SSH; confirm when
  wiring up the second VM.
- How `victor-omnibus`'s "public dashboard" serves traffic today — is the dashboard the
  only public service, or is there another web server whose logs we should tail? Confirm
  before building `access_log`.
- Metric retention horizon for the in-memory window (how many minutes/points).
