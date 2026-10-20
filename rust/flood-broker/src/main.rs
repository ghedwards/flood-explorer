//! flood-broker: Flood Explorer's live data broker on a socket.
//!
//! Plain HTTP/1.1, one request per connection, a fixed pool of worker
//! threads. Put a TLS proxy such as Caddy in front (the map is served over
//! HTTPS). Settings come from the environment:
//!   PORT              default 8787
//!   HOST              default 127.0.0.1
//!   ALLOWED_ORIGINS   comma-separated, default https://ghedwards.github.io
//!   CACHE_MINUTES     default 10
//!   TRUST_PROXY       "1": the client address comes from X-Forwarded-For
//!   WORKERS           default 16
//!   READINGS_REFRESH_MINUTES  default 15 (0: don't serve /v1/readings fresh)
//!   READINGS_BUCKET   S3 bucket for the shared readings file (Lambda)
//!   STATIONS_URL      the site's stations.json (which gauges to fetch)
//!
//! On AWS Lambda (AWS_LAMBDA_RUNTIME_API set) it serves a function URL
//! through the runtime API instead (see lambda.rs); built as `bootstrap`
//! for the provided.al2023 runtime.

use flood_broker::readings::{self, Readings, Store};
use flood_broker::s3::Bucket;
use flood_broker::{http_fetch, Broker, Config, Request, Response};
use std::io::{Read, Write};
use std::net::{TcpListener, TcpStream};
use std::sync::{mpsc, Arc, Mutex};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

const MAX_HEAD: usize = 16 * 1024;

fn now_ms() -> i64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_millis() as i64).unwrap_or(0)
}

fn reason(code: u16) -> &'static str {
    match code {
        200 => "OK",
        204 => "No Content",
        400 => "Bad Request",
        404 => "Not Found",
        405 => "Method Not Allowed",
        413 => "Request Header Fields Too Large",
        429 => "Too Many Requests",
        500 => "Internal Server Error",
        502 => "Bad Gateway",
        503 => "Service Unavailable",
        _ => "",
    }
}

fn write_response(s: &mut TcpStream, r: &Response) {
    let mut head = format!("HTTP/1.1 {} {}\r\nContent-Length: {}\r\nConnection: close\r\n", r.status, reason(r.status), r.body.len());
    for (k, v) in &r.headers {
        head.push_str(&format!("{}: {}\r\n", k, v));
    }
    head.push_str("\r\n");
    let _ = s.write_all(head.as_bytes());
    let _ = s.write_all(&r.body);
    let _ = s.flush();
}

fn plain(status: u16, msg: &str) -> Response {
    Response { status, headers: vec![("Content-Type".into(), "application/json; charset=utf-8".into())], body: format!("{{\"error\":\"{}\"}}", msg).into_bytes() }
}

fn serve(broker: &Broker, mut s: TcpStream, trust_proxy: bool) {
    let _ = s.set_read_timeout(Some(Duration::from_secs(10)));
    let _ = s.set_write_timeout(Some(Duration::from_secs(10)));
    let mut buf = Vec::with_capacity(2048);
    let mut chunk = [0u8; 2048];
    // read the request head (any body is ignored: GET only)
    loop {
        if buf.windows(4).any(|w| w == b"\r\n\r\n") {
            break;
        }
        if buf.len() > MAX_HEAD {
            return write_response(&mut s, &plain(413, "request too large"));
        }
        match s.read(&mut chunk) {
            Ok(0) | Err(_) => return,
            Ok(n) => buf.extend_from_slice(&chunk[..n]),
        }
    }
    let mut headers = [httparse::EMPTY_HEADER; 48];
    let mut req = httparse::Request::new(&mut headers);
    match req.parse(&buf) {
        Ok(httparse::Status::Complete(_)) => {}
        _ => return write_response(&mut s, &plain(400, "bad request")),
    }
    let h = |name: &str| req.headers.iter().find(|x| x.name.eq_ignore_ascii_case(name)).and_then(|x| std::str::from_utf8(x.value).ok()).map(str::trim);
    let peer = s.peer_addr().map(|a| a.ip().to_string()).unwrap_or_else(|_| "?".into());
    let client = if trust_proxy { h("x-forwarded-for").and_then(|v| v.split(',').next()).map(str::trim).filter(|v| !v.is_empty()).unwrap_or(&peer) } else { &peer };
    let r = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        broker.handle(&Request {
            method: req.method.unwrap_or(""),
            target: req.path.unwrap_or("/"),
            origin: h("origin"),
            client,
            gzip: h("accept-encoding").is_some_and(|v| v.split(',').any(|x| x.trim().starts_with("gzip"))),
            if_none_match: h("if-none-match"),
        })
    }))
    .unwrap_or_else(|_| plain(500, "broker error"));
    write_response(&mut s, &r);
}

fn main() {
    let env = |k: &str| std::env::var(k).ok().filter(|v| !v.trim().is_empty());
    let origins = env("ALLOWED_ORIGINS").unwrap_or_else(|| "https://ghedwards.github.io".into());
    let cfg = Config {
        origins: origins.split(',').map(|s| s.trim().trim_end_matches('/').to_string()).filter(|s| !s.is_empty()).collect(),
        cache_ms: env("CACHE_MINUTES").and_then(|v| v.parse::<f64>().ok()).map_or(10 * 60_000, |m| (m * 60_000.0) as i64),
        refresh_ms: env("READINGS_REFRESH_MINUTES").and_then(|v| v.parse::<i64>().ok()).filter(|m| *m > 0).unwrap_or(15) * 60_000,
    };
    // readings for the whole map: in S3 when a bucket is given (Lambda),
    // otherwise in memory
    let store = match env("READINGS_BUCKET") {
        Some(name) => Store::S3(Bucket { name, region: env("AWS_REGION").unwrap_or_else(|| "ap-southeast-2".into()) }),
        None => Store::Memory,
    };
    let in_memory = matches!(store, Store::Memory);
    let rd = Arc::new(Readings::new(Box::new(readings::http_json), store, env("STATIONS_URL").unwrap_or_else(|| readings::STATIONS_URL.into()), Box::new(now_ms)).with_text(Box::new(readings::http_text)).with_rain_http(Box::new(readings::http_json_once)).with_warnings(Box::new(flood_feeds::flood_warnings)).with_classes(Box::new(flood_feeds::flood_classes)));
    // on AWS Lambda (a function URL): the runtime API loop instead of a socket
    if let Some(api) = env("AWS_LAMBDA_RUNTIME_API") {
        let broker = Broker::new(Box::new(http_fetch), Box::new(now_ms), cfg).with_readings(rd);
        flood_broker::lambda::run(&api, &broker);
    }
    // on a server: refresh in the background
    let every = env("READINGS_REFRESH_MINUTES").and_then(|v| v.parse::<u64>().ok()).unwrap_or(15);
    if in_memory && every > 0 {
        let rd = rd.clone();
        std::thread::spawn(move || loop {
            match rd.refresh() {
                Ok(s) => println!("readings refreshed: {}", s),
                Err(e) => eprintln!("readings refresh failed: {}", e),
            }
            std::thread::sleep(Duration::from_secs(every * 60));
        });
    }
    let trust_proxy = env("TRUST_PROXY").as_deref() == Some("1");
    let workers = env("WORKERS").and_then(|v| v.parse::<usize>().ok()).unwrap_or(16).clamp(1, 256);
    let addr = format!("{}:{}", env("HOST").unwrap_or_else(|| "127.0.0.1".into()), env("PORT").unwrap_or_else(|| "8787".into()));
    let listener = TcpListener::bind(&addr).unwrap_or_else(|e| {
        eprintln!("flood-broker: can't listen on {}: {}", addr, e);
        std::process::exit(1);
    });
    let broker = Arc::new(Broker::new(Box::new(http_fetch), Box::new(now_ms), cfg).with_readings(rd));
    let (tx, rx) = mpsc::sync_channel::<TcpStream>(workers * 16);
    let rx = Arc::new(Mutex::new(rx));
    for _ in 0..workers {
        let (rx, broker) = (rx.clone(), broker.clone());
        std::thread::spawn(move || loop {
            let s = match rx.lock().unwrap_or_else(|e| e.into_inner()).recv() {
                Ok(s) => s,
                Err(_) => return,
            };
            serve(&broker, s, trust_proxy);
        });
    }
    println!("flood-broker listening on http://{} ({} workers, origins {})", addr, workers, origins);
    for s in listener.incoming().flatten() {
        if let Err(mpsc::TrySendError::Full(mut s)) = tx.try_send(s) {
            write_response(&mut s, &plain(503, "busy"));
        }
    }
}
