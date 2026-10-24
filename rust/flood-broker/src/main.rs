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
use flood_broker::{http_fetch, Broker, Config};
use std::sync::Arc;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

fn now_ms() -> i64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_millis() as i64).unwrap_or(0)
}

fn main() {
    // tiny arg parse: --data-dir <path>
    let args: Vec<String> = std::env::args().collect();
    let mut data_dir_arg: Option<String> = None;
    let mut i = 1;
    while i < args.len() {
        if args[i] == "--data-dir" && i + 1 < args.len() { data_dir_arg = Some(args[i+1].clone()); i += 2; continue; }
        i += 1;
    }
    // settings file: --settings <path>, or FLOOD_SETTINGS, or ./settings.ini
    let settings_file = std::env::args().skip(1).zip(std::env::args().skip(2)).find(|(a,_)| a == "--settings").map(|(_,v)| v)
        .or_else(|| std::env::var("FLOOD_SETTINGS").ok().filter(|v| !v.trim().is_empty()))
        .unwrap_or_else(|| "settings.ini".into());
    let file_settings: std::collections::HashMap<String, String> = std::fs::read_to_string(&settings_file)
        .ok()
        .map(|txt| txt.lines().filter_map(|l| {
            let l = l.trim();
            if l.is_empty() || l.starts_with('#') || l.starts_with(';') { return None; }
            let (k, v) = l.split_once('=')?;
            Some((k.trim().to_string(), v.trim().to_string()))
        }).collect())
        .unwrap_or_default();
    let env = |k: &str| std::env::var(k).ok().filter(|v| !v.trim().is_empty())
        .or_else(|| file_settings.get(k).cloned().filter(|v| !v.trim().is_empty()));
    let origins = env("ALLOWED_ORIGINS").unwrap_or_else(|| "https://ghedwards.github.io".into());
    let cfg = Config {
        origins: origins.split(',').map(|s| s.trim().trim_end_matches('/').to_string()).filter(|s| !s.is_empty()).collect(),
        cache_ms: env("CACHE_MINUTES").and_then(|v| v.parse::<f64>().ok()).map_or(10 * 60_000, |m| (m * 60_000.0) as i64),
        refresh_ms: env("READINGS_REFRESH_MINUTES").and_then(|v| v.parse::<i64>().ok()).filter(|m| *m > 0).unwrap_or(15) * 60_000,
    };
    // readings for the whole map: in S3 when a bucket is given (Lambda),
    // in a local directory for the desktop build, otherwise in memory
    let store = match (env("READINGS_BUCKET"), data_dir_arg.or_else(|| env("FLOOD_DATA_DIR"))) {
        (Some(name), _) => Store::S3(Bucket { name, region: env("AWS_REGION").unwrap_or_else(|| "ap-southeast-2".into()) }),
        (_, Some(dir)) => Store::Local(std::path::PathBuf::from(dir)),
        _ => {
            if env("FLOOD_STORAGE").as_deref() == Some("local") {
                let dir = env("HOME").or_else(|| env("USERPROFILE")).unwrap_or_else(|| ".".into());
                Store::Local(std::path::PathBuf::from(dir).join(".flood-explorer"))
            } else {
                Store::Memory
            }
        }
    };
    let in_memory = matches!(store, Store::Memory | Store::Local(_));
    let rd = Arc::new(Readings::new(Box::new(readings::http_json), store, env("STATIONS_URL").unwrap_or_else(|| readings::STATIONS_URL.into()), Box::new(now_ms)).with_text(Box::new(readings::http_text)).with_rain_http(Box::new(readings::http_json_once)).with_ftp(Box::new(|| flood_feeds::ftp::Session::open(flood_feeds::BOM_FTP_HOST, 30).map(|s| Box::new(s) as Box<dyn flood_feeds::ftp::Dir>))).with_roads(Box::new(readings::fetch_roads)).with_emergency(Box::new(readings::fetch_emergency)));
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
    let broker = Arc::new(Broker::new(Box::new(http_fetch), Box::new(now_ms), cfg).with_readings(rd));
    flood_broker::run_server(broker, &addr, workers, trust_proxy);
}
