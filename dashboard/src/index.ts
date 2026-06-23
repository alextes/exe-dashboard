// exe-dashboard — dashboard server entrypoint.
//
// Scrapes each configured target VM's agent, keeps recent samples, and serves a
// password-gated UI showing CPU/mem/disk + HTTP request metrics.
//
// STATUS: stub. See ../SPEC.md for the design and ../SPEC.md#roadmap for build order.
// Milestone 2: login + session cookie, request-counting middleware (self HTTP
// metrics), local agent scrape, minimal HTML UI.

const port = Number(process.env.PORT ?? 8080);
const password = process.env.DASHBOARD_PASSWORD ?? "password"; // local dev default; real value set via env in prod

function main(): void {
  // TODO(milestone 2): start the HTTP server, mount /login + session middleware,
  // scrape targets, render the UI.
  console.log(`exe-dashboard: not implemented yet. Intended port: ${port}`);
  console.log(`Login password is configured (${password.length} chars). See ../SPEC.md.`);
}

main();
