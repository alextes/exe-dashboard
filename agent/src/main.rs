//! exe-agent — metrics agent for exe-dashboard.
//!
//! Deployed to each exe.dev VM. Exposes the metrics the dashboard scrapes:
//!   GET /metrics  -> JSON per ../../SPEC.md#metrics-schema (CPU/mem/disk/http)
//!   GET /healthz  -> 200 OK
//!
//! Binds to 127.0.0.1 by default; the dashboard scrapes over SSH (see SPEC.md).
//!
//! STATUS: stub. See the roadmap in ../../SPEC.md — start with sysinfo-backed
//! CPU/mem/disk and a minimal HTTP server.

fn main() {
    // TODO(milestone 1): read AGENT_BIND (default 127.0.0.1:9099), start an HTTP
    // server, and serve /metrics + /healthz. Collect system metrics with `sysinfo`.
    let bind = std::env::var("AGENT_BIND").unwrap_or_else(|_| "127.0.0.1:9099".to_string());
    println!("exe-agent: not implemented yet. Intended bind: {bind}");
    println!("See ../../SPEC.md for the design and metrics schema.");
}
