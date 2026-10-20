//! `flood`: Flood Explorer's data pipeline.
//!
//! Each subcommand replaces one of the former Python scripts in pipeline/,
//! with the same arguments and outputs:
//!
//!   flood national <out_dir>
//!   flood floodinfo <out_dir>
//!   flood events <config/events.json> <gauges.geojson> <out.json>
//!   flood sealevels <events.json> <sea.json>
//!   flood sealevels merge <events.json> <sea.json> <out.json>
//!   flood ratings <viewer/app.js> <gauges.geojson> <out.json> [--km 12] [--max 250]
//!   flood tides <out.json>
//!   flood workers <out.json>
//!   flood levees <out.geojson>
//!   flood osm <viewer/app.js> <out_dir> [--max N] [--days D]
//!   flood waterhistory <national_dir> [previous.json]
//!   flood floodhub <config.json> <data_dir>
//!   flood council <out_dir>
//!   flood dea <out_dir>
//!   flood dem <config.json> <work_dir>
//!   flood hydrology <config.json> <work_dir>
//!   flood compare-hydrology <left_dir> <right_dir>
//!   flood tool <list|tool-id> [--key=value ...]
//!   flood export <config.json> <work_dir> <data_dir>
//!   flood config <config.json> <key>
//!   flood status <site_dir> <log>...
//!
//! Module implementations live in the `flood_pipeline` library (src/lib.rs);
//! this binary is a thin command-line wrapper over it.

use flood_pipeline::*;

use util::R;

fn opt(args: &[String], name: &str) -> Option<String> {
    args.iter().position(|a| a == name).and_then(|i| args.get(i + 1)).cloned()
}

fn usage() -> String {
    let doc = include_str!("main.rs");
    doc.lines().take_while(|l| l.starts_with("//!")).map(|l| l.trim_start_matches("//!").trim_start_matches(' ')).collect::<Vec<_>>().join("\n")
}

fn run(args: &[String]) -> R<String> {
    let a = |i: usize| -> R<&str> { args.get(i).map(|s| s.as_str()).ok_or_else(usage) };
    match args.first().map(|s| s.as_str()) {
        Some("national") => national::run(a(1)?, &national::http_json),
        Some("floodinfo") => floodinfo::run(a(1)?, &floodinfo::http_text, Some(&flood_feeds::flood_warnings), Some(&flood_feeds::flood_classes)),
        Some("events") => events::run(a(1)?, a(2)?, a(3)?, &national::kiwis),
        Some("sealevels") if args.get(1).map(|s| s.as_str()) == Some("merge") => sealevels::merge(a(2)?, a(3)?, a(4)?),
        Some("sealevels") => sealevels::run(a(1)?, a(2)?),
        Some("ratings") => {
            let near = opt(args, "--km").and_then(|v| v.parse().ok()).unwrap_or(12.0);
            let max = opt(args, "--max").and_then(|v| v.parse().ok()).unwrap_or(250);
            ratings::run(a(1)?, a(2)?, a(3)?, near, max, &national::kiwis)
        }
        Some("tides") => Ok(tides::run(a(1)?).unwrap_or_else(|e| format!("Tides: unavailable ({})", util::clip(&e, 300)))),
        Some("workers") => Ok(workers::run(a(1)?).unwrap_or_else(|e| format!("Workers: unavailable ({})", util::clip(&e, 300)))),
        Some("levees") => levees::run(a(1)?, &levees::get),
        Some("osm") => {
            let max = opt(args, "--max").and_then(|v| v.parse().ok()).unwrap_or(12);
            let days = opt(args, "--days").and_then(|v| v.parse().ok()).unwrap_or(30.0);
            osm::run(a(1)?, a(2)?, max, days, 1500.0, &osm::overpass, &|s| std::thread::sleep(std::time::Duration::from_secs_f64(s)))
        }
        Some("waterhistory") => waterhistory::run(a(1)?, args.get(2).map(|s| s.as_str()).unwrap_or(""), &waterhistory::get),
        Some("floodhub") => floodhub::run(a(1)?, a(2)?, None),
        Some("council") => council::run(a(1)?),
        Some("dea") => dea::run(a(1)?),
        Some("dem") => dem::run(a(1)?, a(2)?),
        Some("hydrology") => hydrology::run(a(1)?, a(2)?),
        Some("compare-hydrology") => compare::run(a(1)?, a(2)?),
        Some("tool") => hydrology::tool(&args[1..]),
        Some("export") => export::run(a(1)?, a(2)?, a(3)?),
        Some("config") => {
            let cfg = util::read_json(a(1)?)?;
            Ok(util::py_str(cfg.get(a(2)?).ok_or_else(|| format!("no {} in {}", a(2).unwrap_or(""), a(1).unwrap_or("")))?))
        }
        Some("status") => status::run(a(1)?, &args[2..]),
        _ => Err(usage()),
    }
}

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    match run(&args) {
        Ok(msg) => {
            if !msg.is_empty() {
                println!("{}", msg);
            }
        }
        Err(e) => {
            eprintln!("{}", e);
            std::process::exit(1);
        }
    }
}
