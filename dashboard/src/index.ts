import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";

const port = Number(process.env.PORT ?? 8080);
const password = process.env.DASHBOARD_PASSWORD ?? "password";
const sessionSecretFromEnv = process.env.SESSION_SECRET;
const sessionSecret = sessionSecretFromEnv ?? randomBytes(32).toString("base64url");
const agentMetricsUrl = process.env.AGENT_METRICS_URL ?? "http://127.0.0.1:9099/metrics";
const scrapeIntervalMs = Number(process.env.SCRAPE_INTERVAL_MS ?? 10_000);
const historyLimit = Number(process.env.HISTORY_LIMIT ?? 120);
const sessionCookie = "exe_dashboard_session";
const sessionMaxAgeSeconds = 7 * 24 * 60 * 60;

type Metrics = {
  schema: 1;
  vm: string;
  ts: number;
  uptime_s: number;
  cpu: {
    usage_pct: number;
    cores: number;
    load_avg: [number, number, number];
  };
  mem: {
    total_bytes: number;
    used_bytes: number;
    used_pct: number;
  };
  disk: Array<{
    mount: string;
    total_bytes: number;
    used_bytes: number;
    used_pct: number;
  }>;
  http: {
    source: "self" | "access_log" | "none";
    total_requests: number;
    window_s: number;
    requests_in_window: number;
    rps: number;
  };
};

type TargetState = {
  name: string;
  samples: Metrics[];
  lastError?: string;
};

const targets = new Map<string, TargetState>([
  ["self", { name: "victor-omnibus", samples: [] }],
]);

const requestTimes: number[] = [];
let totalRequests = 0;

if (!sessionSecretFromEnv) {
  console.warn("SESSION_SECRET is not set; using an ephemeral local-dev signing secret.");
}

startScraper();

const server = createServer((req, res) => {
  void handleRequest(req, res).catch((err: unknown) => {
    console.error("request failed", err);
    sendText(res, 500, "internal server error\n");
  });
});

server.listen(port, () => {
  console.log(`exe-dashboard listening on http://127.0.0.1:${port}`);
});

async function handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
  countRequest();

  const method = req.method ?? "GET";
  const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);

  if ((method === "GET" || method === "HEAD") && url.pathname === "/favicon.svg") {
    sendSvg(res, 200, faviconSvg());
    return;
  }

  if (method === "GET" && url.pathname === "/login") {
    sendHtml(res, 200, renderLoginPage(url.searchParams.has("error")));
    return;
  }

  if (method === "POST" && url.pathname === "/login") {
    const body = await readRequestBody(req);
    const form = new URLSearchParams(body);

    if (constantTimeEquals(form.get("password") ?? "", password)) {
      res.statusCode = 303;
      res.setHeader("Set-Cookie", buildSessionCookie());
      res.setHeader("Location", "/");
      res.end();
    } else {
      res.statusCode = 303;
      res.setHeader("Location", "/login?error=1");
      res.end();
    }
    return;
  }

  if (!isAuthenticated(req)) {
    res.statusCode = 303;
    res.setHeader("Location", "/login");
    res.end();
    return;
  }

  if (method === "POST" && url.pathname === "/logout") {
    res.statusCode = 303;
    res.setHeader("Set-Cookie", clearSessionCookie());
    res.setHeader("Location", "/login");
    res.end();
    return;
  }

  if (method === "GET" && url.pathname === "/healthz") {
    sendText(res, 200, "ok\n");
    return;
  }

  if (method === "GET" && url.pathname === "/") {
    sendHtml(res, 200, renderDashboard());
    return;
  }

  if (method === "GET" && url.pathname === "/targets") {
    sendHtml(res, 200, renderTargets());
    return;
  }

  sendText(res, 404, "not found\n");
}

function startScraper(): void {
  void scrapeSelfTarget();
  setInterval(() => {
    void scrapeSelfTarget();
  }, scrapeIntervalMs).unref();
}

async function scrapeSelfTarget(): Promise<void> {
  const target = targets.get("self");
  if (!target) return;

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 4_000);
    const response = await fetch(agentMetricsUrl, { signal: controller.signal });
    clearTimeout(timeout);

    if (!response.ok) {
      throw new Error(`agent returned HTTP ${response.status}`);
    }

    const metrics = coerceMetrics(await response.json());
    metrics.vm = target.name;
    metrics.http = buildSelfHttpMetrics();

    target.samples.push(metrics);
    target.samples.splice(0, Math.max(0, target.samples.length - historyLimit));
    target.lastError = undefined;
  } catch (err) {
    target.lastError = err instanceof Error ? err.message : String(err);
  }
}

function buildSelfHttpMetrics(): Metrics["http"] {
  const windowS = 60;
  const cutoff = Date.now() - windowS * 1_000;

  while (requestTimes.length > 0 && requestTimes[0] < cutoff) {
    requestTimes.shift();
  }

  return {
    source: "self",
    total_requests: totalRequests,
    window_s: windowS,
    requests_in_window: requestTimes.length,
    rps: requestTimes.length / windowS,
  };
}

function countRequest(): void {
  totalRequests += 1;
  requestTimes.push(Date.now());
}

function coerceMetrics(value: unknown): Metrics {
  const metrics = value as Metrics;

  if (!metrics || metrics.schema !== 1) {
    throw new Error("agent returned unsupported metrics schema");
  }

  return metrics;
}

function renderDashboard(): string {
  return html(`<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>exe-dashboard</title>
  <link rel="icon" href="/favicon.svg" type="image/svg+xml">
  <style>${dashboardCss()}</style>
</head>
<body>
  <header class="topbar">
    <div>
      <p class="eyebrow">exe.dev usage</p>
      <h1>VM Dashboard</h1>
    </div>
    <form method="post" action="/logout">
      <button type="submit" title="Log out" aria-label="Log out">Log out</button>
    </form>
  </header>
  <main class="shell">
    <section class="targets">${renderTargets()}</section>
  </main>
  <script>${dashboardScript()}</script>
</body>
</html>`);
}

function renderTargets(): string {
  return Array.from(targets.values()).map(renderTarget).join("");
}

function renderTarget(target: TargetState): string {
  const latest = target.samples.at(-1);

  if (!latest) {
    return `<article class="target">
      <div class="target-head">
        <div>
          <h2>${escapeHtml(target.name)}</h2>
          <p>No samples yet</p>
        </div>
        <span class="status warn">waiting</span>
      </div>
      <p class="empty">${escapeHtml(target.lastError ?? `Waiting for ${agentMetricsUrl}`)}</p>
    </article>`;
  }

  const disk = latest.disk[0];
  const cpuSeries = target.samples.map((sample) => sample.cpu.usage_pct);
  const memSeries = target.samples.map((sample) => sample.mem.used_pct);
  const rpsSeries = target.samples.map((sample) => sample.http.rps);

  return `<article class="target">
    <div class="target-head">
      <div>
        <h2>${escapeHtml(latest.vm)}</h2>
        <p><span class="sample-age" data-sample-ts="${latest.ts}">${escapeHtml(formatAge(latest.ts))}</span> · ${latest.cpu.cores} cores · uptime ${escapeHtml(formatDuration(latest.uptime_s))}</p>
      </div>
      <span class="status ok">online</span>
    </div>
    <div class="metrics">
      ${renderGauge("CPU", latest.cpu.usage_pct, `${latest.cpu.usage_pct.toFixed(1)}%`, cpuSeries, "blue")}
      ${renderGauge("Memory", latest.mem.used_pct, `${latest.mem.used_pct.toFixed(1)}%`, memSeries, "green")}
      ${renderGauge("Disk", disk?.used_pct ?? 0, disk ? `${formatBytes(disk.used_bytes)} / ${formatBytes(disk.total_bytes)}` : "n/a", target.samples.map((sample) => sample.disk[0]?.used_pct ?? 0), "amber")}
      ${renderGauge("Requests", Math.min(latest.http.rps * 10, 100), `${latest.http.rps.toFixed(2)} rps`, rpsSeries, "rose")}
    </div>
    <div class="details">
      <dl>
        <div><dt>Total requests</dt><dd>${latest.http.total_requests.toLocaleString()}</dd></div>
        <div><dt>Last ${latest.http.window_s}s</dt><dd>${latest.http.requests_in_window.toLocaleString()}</dd></div>
        <div><dt>Load avg</dt><dd>${latest.cpu.load_avg.map((load) => load.toFixed(2)).join(" / ")}</dd></div>
        <div><dt>HTTP source</dt><dd>${latest.http.source}</dd></div>
      </dl>
    </div>
    ${target.lastError ? `<p class="stale">Last scrape error: ${escapeHtml(target.lastError)}</p>` : ""}
  </article>`;
}

function dashboardScript(): string {
  return `
const refreshMs = ${Math.max(scrapeIntervalMs, 5_000)};

function formatAgeFromSeconds(ts) {
  const ageSeconds = Math.max(0, Math.round(Date.now() / 1000 - ts));
  if (ageSeconds < 2) return "just now";
  if (ageSeconds < 60) return ageSeconds + "s ago";
  if (ageSeconds < 3600) return Math.floor(ageSeconds / 60) + "m ago";
  return Math.floor(ageSeconds / 3600) + "h ago";
}

function tickSampleAges() {
  for (const node of document.querySelectorAll("[data-sample-ts]")) {
    const ts = Number(node.getAttribute("data-sample-ts"));
    if (Number.isFinite(ts)) {
      node.textContent = formatAgeFromSeconds(ts);
    }
  }
}

tickSampleAges();
setInterval(tickSampleAges, 1000);
setInterval(async () => {
  try {
    const response = await fetch("/targets", {
      cache: "no-store",
      credentials: "same-origin",
      headers: { "X-Requested-With": "fetch" },
    });

    if (response.redirected && response.url.includes("/login")) {
      location.href = "/login";
      return;
    }

    if (!response.ok) return;

    const targets = document.querySelector(".targets");
    if (!targets) return;

    targets.innerHTML = await response.text();
    tickSampleAges();
  } catch {
    // Keep the last rendered sample visible until the next refresh succeeds.
  }
}, refreshMs);
`;
}

function renderGauge(
  label: string,
  pct: number,
  value: string,
  series: number[],
  tone: "blue" | "green" | "amber" | "rose",
): string {
  const boundedPct = clamp(pct, 0, 100);

  return `<section class="metric ${tone}">
    <div class="metric-row">
      <span>${escapeHtml(label)}</span>
      <strong>${escapeHtml(value)}</strong>
    </div>
    <div class="bar"><span style="width: ${boundedPct}%"></span></div>
    ${renderSparkline(series)}
  </section>`;
}

function renderSparkline(values: number[]): string {
  if (values.length < 2) {
    return `<svg class="spark" viewBox="0 0 120 28" role="img" aria-label="sparkline"></svg>`;
  }

  const max = Math.max(...values, 1);
  const min = Math.min(...values, 0);
  const range = Math.max(max - min, 1);
  const points = values
    .map((value, index) => {
      const x = (index / Math.max(values.length - 1, 1)) * 120;
      const y = 26 - ((value - min) / range) * 24;
      return `${x.toFixed(1)},${y.toFixed(1)}`;
    })
    .join(" ");

  return `<svg class="spark" viewBox="0 0 120 28" role="img" aria-label="sparkline"><polyline points="${points}"></polyline></svg>`;
}

function renderLoginPage(hasError: boolean): string {
  return html(`<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Login · exe-dashboard</title>
  <link rel="icon" href="/favicon.svg" type="image/svg+xml">
  <style>${dashboardCss()}</style>
</head>
<body class="login-body">
  <main class="login-panel">
    <p class="eyebrow">exe.dev usage</p>
    <h1>VM Dashboard</h1>
    <form method="post" action="/login">
      <label for="password">Password</label>
      <input id="password" name="password" type="password" autocomplete="current-password" autofocus>
      ${hasError ? '<p class="form-error">Password did not match.</p>' : ""}
      <button type="submit">Log in</button>
    </form>
  </main>
</body>
</html>`);
}

function faviconSvg(): string {
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64">
  <rect width="64" height="64" rx="14" fill="#172026"/>
  <path d="M16 38c5 0 5-12 10-12s5 12 10 12 5-12 12-12" fill="none" stroke="#f5f7f8" stroke-width="6" stroke-linecap="round" stroke-linejoin="round"/>
  <circle cx="48" cy="26" r="4" fill="#2f6fed"/>
</svg>`;
}

function dashboardCss(): string {
  return `
:root {
  color-scheme: light;
  --bg: #f5f7f8;
  --ink: #172026;
  --muted: #65717a;
  --line: #d9e0e4;
  --panel: #ffffff;
  --blue: #2f6fed;
  --green: #15845c;
  --amber: #b7791f;
  --rose: #c24161;
}
* { box-sizing: border-box; }
body {
  margin: 0;
  background: var(--bg);
  color: var(--ink);
  font: 14px/1.5 Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
}
.topbar {
  align-items: center;
  background: var(--panel);
  border-bottom: 1px solid var(--line);
  display: flex;
  justify-content: space-between;
  min-height: 76px;
  padding: 14px clamp(18px, 4vw, 44px);
}
h1, h2, p { margin: 0; }
h1 { font-size: 24px; font-weight: 750; }
h2 { font-size: 18px; font-weight: 750; }
.eyebrow {
  color: var(--muted);
  font-size: 12px;
  font-weight: 700;
  letter-spacing: 0;
  text-transform: uppercase;
}
button {
  appearance: none;
  background: var(--ink);
  border: 0;
  border-radius: 6px;
  color: white;
  cursor: pointer;
  font: inherit;
  font-weight: 700;
  min-height: 38px;
  padding: 8px 14px;
}
.shell { padding: clamp(18px, 4vw, 44px); }
.targets { display: grid; gap: 18px; }
.target {
  background: var(--panel);
  border: 1px solid var(--line);
  border-radius: 8px;
  padding: 18px;
}
.target-head {
  align-items: start;
  display: flex;
  gap: 16px;
  justify-content: space-between;
  margin-bottom: 18px;
}
.target-head p, .empty, .stale { color: var(--muted); }
.status {
  border-radius: 999px;
  font-size: 12px;
  font-weight: 800;
  padding: 4px 9px;
}
.status.ok { background: #dff7eb; color: #0f6846; }
.status.warn { background: #fff3cf; color: #805500; }
.metrics {
  display: grid;
  gap: 12px;
  grid-template-columns: repeat(4, minmax(0, 1fr));
}
.metric {
  border: 1px solid var(--line);
  border-radius: 8px;
  padding: 12px;
}
.metric-row {
  align-items: baseline;
  display: flex;
  gap: 10px;
  justify-content: space-between;
}
.metric-row span { color: var(--muted); font-weight: 700; }
.metric-row strong { font-size: 16px; white-space: nowrap; }
.bar {
  background: #edf1f3;
  border-radius: 999px;
  height: 8px;
  margin: 10px 0 8px;
  overflow: hidden;
}
.bar span {
  display: block;
  height: 100%;
}
.metric.blue .bar span, .metric.blue polyline { background: var(--blue); stroke: var(--blue); }
.metric.green .bar span, .metric.green polyline { background: var(--green); stroke: var(--green); }
.metric.amber .bar span, .metric.amber polyline { background: var(--amber); stroke: var(--amber); }
.metric.rose .bar span, .metric.rose polyline { background: var(--rose); stroke: var(--rose); }
.spark {
  display: block;
  height: 28px;
  width: 100%;
}
.spark polyline {
  fill: none;
  stroke-linecap: round;
  stroke-linejoin: round;
  stroke-width: 2.5;
}
.details {
  border-top: 1px solid var(--line);
  margin-top: 16px;
  padding-top: 14px;
}
dl {
  display: grid;
  gap: 10px;
  grid-template-columns: repeat(4, minmax(0, 1fr));
  margin: 0;
}
dt { color: var(--muted); font-size: 12px; font-weight: 700; }
dd { font-size: 15px; font-weight: 750; margin: 0; }
.stale { margin-top: 12px; }
.login-body {
  align-items: center;
  display: grid;
  min-height: 100vh;
  padding: 20px;
  place-items: center;
}
.login-panel {
  background: var(--panel);
  border: 1px solid var(--line);
  border-radius: 8px;
  max-width: 380px;
  padding: 24px;
  width: 100%;
}
.login-panel h1 { margin-bottom: 20px; }
label {
  color: var(--muted);
  display: block;
  font-weight: 700;
  margin-bottom: 6px;
}
input {
  border: 1px solid var(--line);
  border-radius: 6px;
  font: inherit;
  min-height: 42px;
  padding: 8px 10px;
  width: 100%;
}
.login-panel button { margin-top: 12px; width: 100%; }
.form-error {
  color: #b42318;
  font-weight: 700;
  margin-top: 8px;
}
@media (max-width: 900px) {
  .metrics, dl { grid-template-columns: repeat(2, minmax(0, 1fr)); }
}
@media (max-width: 560px) {
  .topbar { align-items: start; flex-direction: column; }
  .metrics, dl { grid-template-columns: 1fr; }
  .target-head { flex-direction: column; }
}
`;
}

function isAuthenticated(req: IncomingMessage): boolean {
  const cookie = parseCookies(req.headers.cookie ?? "")[sessionCookie];
  if (!cookie) return false;

  const [issuedAtRaw, signature] = cookie.split(".");
  const issuedAt = Number(issuedAtRaw);

  if (!Number.isFinite(issuedAt)) return false;
  if (Date.now() - issuedAt > sessionMaxAgeSeconds * 1_000) return false;

  const expected = signSession(issuedAtRaw);
  return constantTimeEquals(signature ?? "", expected);
}

function buildSessionCookie(): string {
  const issuedAt = Date.now().toString();
  const value = `${issuedAt}.${signSession(issuedAt)}`;
  return `${sessionCookie}=${value}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${sessionMaxAgeSeconds}${secureCookieSuffix()}`;
}

function clearSessionCookie(): string {
  return `${sessionCookie}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${secureCookieSuffix()}`;
}

function secureCookieSuffix(): string {
  return process.env.COOKIE_SECURE === "true" || process.env.NODE_ENV === "production"
    ? "; Secure"
    : "";
}

function signSession(value: string): string {
  return createHmac("sha256", sessionSecret).update(value).digest("base64url");
}

function constantTimeEquals(actual: string, expected: string): boolean {
  const actualBuffer = Buffer.from(actual);
  const expectedBuffer = Buffer.from(expected);

  if (actualBuffer.length !== expectedBuffer.length) {
    return false;
  }

  return timingSafeEqual(actualBuffer, expectedBuffer);
}

function parseCookies(header: string): Record<string, string> {
  return Object.fromEntries(
    header
      .split(";")
      .map((part) => part.trim())
      .filter(Boolean)
      .map((part) => {
        const [name, ...rest] = part.split("=");
        return [name, rest.join("=")];
      }),
  );
}

async function readRequestBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];

  for await (const chunk of req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }

  return Buffer.concat(chunks).toString("utf8");
}

function sendHtml(res: ServerResponse, status: number, body: string): void {
  res.statusCode = status;
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.end(body);
}

function sendText(res: ServerResponse, status: number, body: string): void {
  res.statusCode = status;
  res.setHeader("Content-Type", "text/plain; charset=utf-8");
  res.end(body);
}

function sendSvg(res: ServerResponse, status: number, body: string): void {
  res.statusCode = status;
  res.setHeader("Content-Type", "image/svg+xml; charset=utf-8");
  res.setHeader("Cache-Control", "public, max-age=86400");
  res.end(body);
}

function html(value: string): string {
  return value;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

function escapeHtml(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");
}

function formatAge(ts: number): string {
  const ageSeconds = Math.max(0, Math.round(Date.now() / 1_000 - ts));
  if (ageSeconds < 2) return "just now";
  if (ageSeconds < 60) return `${ageSeconds}s ago`;
  if (ageSeconds < 3_600) return `${Math.floor(ageSeconds / 60)}m ago`;
  return `${Math.floor(ageSeconds / 3_600)}h ago`;
}

function formatDuration(seconds: number): string {
  const days = Math.floor(seconds / 86_400);
  const hours = Math.floor((seconds % 86_400) / 3_600);
  if (days > 0) return `${days}d ${hours}h`;
  return `${hours}h ${Math.floor((seconds % 3_600) / 60)}m`;
}

function formatBytes(bytes: number): string {
  const units = ["B", "KB", "MB", "GB", "TB"];
  let value = bytes;
  let unitIndex = 0;

  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024;
    unitIndex += 1;
  }

  return `${value.toFixed(unitIndex === 0 ? 0 : 1)} ${units[unitIndex]}`;
}
