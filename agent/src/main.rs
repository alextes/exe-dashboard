//! exe-agent — metrics agent for exe-dashboard.
//!
//! Deployed to each exe.dev VM. Exposes:
//!   GET /metrics  -> JSON per ../../SPEC.md#metrics-schema
//!   GET /healthz  -> 200 OK
//!
//! Binds to 127.0.0.1:9099 by default; the dashboard scrapes over SSH.

use serde::Serialize;
use std::env;
use std::io::{BufRead, BufReader, Write};
use std::net::{TcpListener, TcpStream};
use std::thread;
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use sysinfo::{Disks, System};

const DEFAULT_BIND: &str = "127.0.0.1:9099";

#[derive(Serialize)]
struct Metrics {
    schema: u8,
    vm: String,
    ts: u64,
    uptime_s: u64,
    cpu: CpuMetrics,
    mem: MemMetrics,
    disk: Vec<DiskMetrics>,
    http: HttpMetrics,
}

#[derive(Serialize)]
struct CpuMetrics {
    usage_pct: f32,
    cores: usize,
    load_avg: [f64; 3],
}

#[derive(Serialize)]
struct MemMetrics {
    total_bytes: u64,
    used_bytes: u64,
    used_pct: f64,
}

#[derive(Serialize)]
struct DiskMetrics {
    mount: String,
    total_bytes: u64,
    used_bytes: u64,
    used_pct: f64,
}

#[derive(Serialize)]
struct HttpMetrics {
    source: &'static str,
    total_requests: u64,
    window_s: u64,
    requests_in_window: u64,
    rps: f64,
}

struct Response {
    status: &'static str,
    content_type: &'static str,
    body: Vec<u8>,
}

fn main() -> std::io::Result<()> {
    let bind = env::var("AGENT_BIND").unwrap_or_else(|_| DEFAULT_BIND.to_string());
    let listener = TcpListener::bind(&bind)?;

    println!("exe-agent listening on http://{bind}");

    for stream in listener.incoming() {
        match stream {
            Ok(stream) => {
                thread::spawn(|| {
                    if let Err(err) = handle_connection(stream) {
                        eprintln!("failed to handle request: {err}");
                    }
                });
            }
            Err(err) => eprintln!("failed to accept connection: {err}"),
        }
    }

    Ok(())
}

fn handle_connection(mut stream: TcpStream) -> std::io::Result<()> {
    let request_line = read_request_line(&mut stream)?;
    let response = response_for_request_line(request_line.as_deref());
    write_response(&mut stream, response)
}

fn read_request_line(stream: &mut TcpStream) -> std::io::Result<Option<String>> {
    stream.set_read_timeout(Some(Duration::from_secs(5)))?;

    let mut reader = BufReader::new(stream);
    let mut request_line = String::new();
    let bytes = reader.read_line(&mut request_line)?;

    if bytes == 0 {
        Ok(None)
    } else {
        Ok(Some(request_line.trim_end().to_string()))
    }
}

fn response_for_request_line(request_line: Option<&str>) -> Response {
    let Some(request_line) = request_line else {
        return plain_response("400 Bad Request", "missing request line\n");
    };

    let mut parts = request_line.split_whitespace();
    let Some(method) = parts.next() else {
        return plain_response("400 Bad Request", "missing method\n");
    };
    let Some(path) = parts.next() else {
        return plain_response("400 Bad Request", "missing path\n");
    };

    match (method, path) {
        ("GET", "/healthz") => plain_response("200 OK", "ok\n"),
        ("GET", "/metrics") => metrics_response(),
        ("GET", _) => plain_response("404 Not Found", "not found\n"),
        _ => plain_response("405 Method Not Allowed", "method not allowed\n"),
    }
}

fn metrics_response() -> Response {
    match serde_json::to_vec_pretty(&collect_metrics()) {
        Ok(mut body) => {
            body.push(b'\n');
            Response {
                status: "200 OK",
                content_type: "application/json",
                body,
            }
        }
        Err(err) => plain_response(
            "500 Internal Server Error",
            &format!("failed to serialize metrics: {err}\n"),
        ),
    }
}

fn plain_response(status: &'static str, body: &str) -> Response {
    Response {
        status,
        content_type: "text/plain; charset=utf-8",
        body: body.as_bytes().to_vec(),
    }
}

fn write_response(stream: &mut TcpStream, response: Response) -> std::io::Result<()> {
    write!(
        stream,
        "HTTP/1.1 {}\r\nContent-Type: {}\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
        response.status,
        response.content_type,
        response.body.len()
    )?;
    stream.write_all(&response.body)
}

fn collect_metrics() -> Metrics {
    let mut system = System::new_all();
    system.refresh_all();

    thread::sleep(sysinfo::MINIMUM_CPU_UPDATE_INTERVAL);
    system.refresh_cpu_usage();
    system.refresh_memory();

    let disks = Disks::new_with_refreshed_list();
    let load_avg = System::load_average();
    let total_memory = system.total_memory();
    let used_memory = system.used_memory();

    Metrics {
        schema: 1,
        vm: vm_name(),
        ts: now_unix_seconds(),
        uptime_s: System::uptime(),
        cpu: CpuMetrics {
            usage_pct: system.global_cpu_usage(),
            cores: system.cpus().len(),
            load_avg: [load_avg.one, load_avg.five, load_avg.fifteen],
        },
        mem: MemMetrics {
            total_bytes: total_memory,
            used_bytes: used_memory,
            used_pct: pct(used_memory, total_memory),
        },
        disk: disks
            .iter()
            .map(|disk| {
                let total = disk.total_space();
                let used = total.saturating_sub(disk.available_space());

                DiskMetrics {
                    mount: disk.mount_point().to_string_lossy().into_owned(),
                    total_bytes: total,
                    used_bytes: used,
                    used_pct: pct(used, total),
                }
            })
            .collect(),
        http: HttpMetrics {
            source: "none",
            total_requests: 0,
            window_s: 60,
            requests_in_window: 0,
            rps: 0.0,
        },
    }
}

fn vm_name() -> String {
    env::var("AGENT_VM_NAME")
        .ok()
        .filter(|name| !name.trim().is_empty())
        .or_else(System::host_name)
        .unwrap_or_else(|| "unknown".to_string())
}

fn now_unix_seconds() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs()
}

fn pct(used: u64, total: u64) -> f64 {
    if total == 0 {
        0.0
    } else {
        (used as f64 / total as f64) * 100.0
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::Value;

    #[test]
    fn healthz_returns_ok() {
        let response = response_for_request_line(Some("GET /healthz HTTP/1.1"));

        assert_eq!(response.status, "200 OK");
        assert_eq!(response.content_type, "text/plain; charset=utf-8");
        assert_eq!(response.body, b"ok\n");
    }

    #[test]
    fn metrics_returns_schema_v1_json() {
        let response = response_for_request_line(Some("GET /metrics HTTP/1.1"));

        assert_eq!(response.status, "200 OK");
        assert_eq!(response.content_type, "application/json");

        let parsed: Value = serde_json::from_slice(&response.body).expect("valid metrics JSON");
        assert_eq!(parsed["schema"], 1);
        assert!(parsed["vm"].as_str().is_some_and(|vm| !vm.is_empty()));
        assert!(parsed["ts"].as_u64().is_some_and(|ts| ts > 0));
        assert!(parsed["uptime_s"].as_u64().is_some());
        assert!(parsed["cpu"]["usage_pct"].as_f64().is_some());
        assert!(parsed["cpu"]["cores"]
            .as_u64()
            .is_some_and(|cores| cores > 0));
        assert_eq!(parsed["cpu"]["load_avg"].as_array().map(Vec::len), Some(3));
        assert!(parsed["mem"]["total_bytes"].as_u64().is_some());
        assert!(parsed["mem"]["used_bytes"].as_u64().is_some());
        assert!(parsed["disk"].as_array().is_some());
        assert_eq!(parsed["http"]["source"], "none");
    }

    #[test]
    fn unsupported_routes_and_methods_get_errors() {
        assert_eq!(
            response_for_request_line(Some("GET /missing HTTP/1.1")).status,
            "404 Not Found"
        );
        assert_eq!(
            response_for_request_line(Some("POST /metrics HTTP/1.1")).status,
            "405 Method Not Allowed"
        );
        assert_eq!(response_for_request_line(None).status, "400 Bad Request");
    }
}
