//! Keep the last good national gauge and dam lists, and use them when the build cannot fetch new ones.
//!
//! Usage: flood national-keep <national_dir> <good_dir>
//!
//! Run right after `flood national`. The Bureau's gauge service can refuse or time out connections from the
//! build machine; `flood national` then writes empty lists and the site loses its gauges and dams without any
//! error. This command makes that outage visible and survivable:
//!
//! - When the gauge service answered (meta.json has gauges and no `gaugeSource`), it copies the gauge and
//!   dam files and meta.json into <good_dir>, to be kept between builds (an Actions cache).
//! - When it did not (no gauges), and <good_dir> holds a good copy, it copies that copy's gauge and dam files
//!   back into <national_dir> and records in meta.json how old they are (`stale`), keeping the fetch errors.
//!   Readings are never restored: an old reading is worse than none.
//! - Otherwise it changes nothing.
//!
//! A gauge list rebuilt from the flood class feed (`gaugeSource`, see `flood gauges-fallback`) is never saved as
//! the good copy: it is smaller than the real one. Run `flood gauges-fallback` after this command, so it only
//! acts when there was no good copy to restore.

use crate::util::*;
use serde_json::{json, Value};
use std::path::Path;

/// The files that make up the gauge and dam lists. meta.json and readings.json are handled separately.
pub const LIST_FILES: [&str; 6] = ["gauges.geojson", "gauges.min.json", "gauges-core.min.json", "gauges-river.min.json", "storages.geojson", "stations.json"];

fn read_meta(dir: &Path) -> Option<Value> {
    serde_json::from_slice(&std::fs::read(dir.join("meta.json")).ok()?).ok()
}

fn copy_lists(from: &Path, to: &Path) -> R<usize> {
    std::fs::create_dir_all(to).map_err(|e| format!("{}: {e}", to.display()))?;
    let mut n = 0;
    for f in LIST_FILES {
        let src = from.join(f);
        if src.exists() {
            std::fs::copy(&src, to.join(f)).map_err(|e| format!("{}: {e}", src.display()))?;
            n += 1;
        }
    }
    Ok(n)
}

pub fn run(national: &str, good: &str) -> R<String> {
    let (national, good) = (Path::new(national), Path::new(good));
    let meta = read_meta(national).ok_or_else(|| format!("{}/meta.json: missing or unreadable", national.display()))?;
    let have = meta["gauges"].as_u64().unwrap_or(0);
    if have > 0 && meta["gaugeSource"].is_null() {
        let n = copy_lists(national, good)?;
        std::fs::copy(national.join("meta.json"), good.join("meta.json")).map_err(|e| format!("meta.json: {e}"))?;
        return Ok(format!("National keep: saved {have} gauges and {} storages ({n} files) as the last good copy", meta["storages"].as_u64().unwrap_or(0)));
    }
    if have > 0 {
        return Ok(format!("National keep: {have} gauges from a fallback source; not saved, and nothing to restore"));
    }
    let Some(gm) = read_meta(good).filter(|m| m["gauges"].as_u64().unwrap_or(0) > 0) else {
        return Ok("National keep: the gauge service gave nothing and there is no good copy to restore".into());
    };
    let n = copy_lists(good, national)?;
    let mut m = meta;
    m["gauges"] = gm["gauges"].clone();
    m["gaugeKinds"] = gm["gaugeKinds"].clone();
    m["storages"] = gm["storages"].clone();
    m["stale"] = json!({"gaugesFrom": gm["fetched"], "reason": "the Bureau's gauge service could not be reached, so the gauge and dam lists are the last good copy"});
    write_json_indent(national.join("meta.json"), &m, 1)?;
    Ok(format!("National keep: the gauge service gave nothing; restored {} gauges and {} storages from {} ({n} files)", gm["gauges"], gm["storages"], gm["fetched"].as_str().unwrap_or("an unknown date")))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn dir(tag: &str) -> std::path::PathBuf {
        let d = std::env::temp_dir().join(format!("national-keep-{}-{tag}", std::process::id()));
        std::fs::remove_dir_all(&d).ok();
        std::fs::create_dir_all(&d).unwrap();
        d
    }
    fn write(d: &Path, name: &str, body: &str) { std::fs::write(d.join(name), body).unwrap(); }
    fn good_site(d: &Path) {
        write(d, "gauges-core.min.json", r#"{"rows":[1,2,3]}"#);
        write(d, "gauges-river.min.json", r#"{"rows":[4]}"#);
        write(d, "storages.geojson", r#"{"features":[1]}"#);
        write(d, "meta.json", r#"{"fetched":"2026-11-03T22:21:37+00:00","gauges":3839,"gaugeKinds":{"river":2357},"storages":303,"errors":[]}"#);
    }
    fn empty_site(d: &Path) {
        write(d, "gauges-core.min.json", r#"{"rows":[]}"#);
        write(d, "storages.geojson", r#"{"features":[]}"#);
        write(d, "readings.json", r#"{"level":{}}"#);
        write(d, "meta.json", r#"{"fetched":"2026-11-09T21:00:00+00:00","gauges":0,"gaugeKinds":{},"storages":0,"errors":["gauge layer 2: timeout: connect"]}"#);
    }

    #[test]
    fn a_good_fetch_is_saved_as_the_last_good_copy() {
        let (n, g) = (dir("save-n"), dir("save-g").join("good"));
        good_site(&n);
        let msg = run(n.to_str().unwrap(), g.to_str().unwrap()).unwrap();
        assert!(msg.contains("saved 3839 gauges and 303 storages"), "{msg}");
        assert_eq!(std::fs::read_to_string(g.join("gauges-core.min.json")).unwrap(), r#"{"rows":[1,2,3]}"#);
        assert!(g.join("meta.json").exists());
    }

    #[test]
    fn an_outage_restores_the_good_copy_marks_it_stale_and_keeps_the_errors_and_new_readings() {
        let (n, g) = (dir("out-n"), dir("out-g"));
        good_site(&g);
        empty_site(&n);
        let msg = run(n.to_str().unwrap(), g.to_str().unwrap()).unwrap();
        assert!(msg.contains("restored 3839 gauges and 303 storages"), "{msg}");
        assert_eq!(std::fs::read_to_string(n.join("gauges-core.min.json")).unwrap(), r#"{"rows":[1,2,3]}"#);
        assert_eq!(std::fs::read_to_string(n.join("readings.json")).unwrap(), r#"{"level":{}}"#, "readings are never restored");
        let m = read_meta(&n).unwrap();
        assert_eq!((m["gauges"].as_u64(), m["storages"].as_u64()), (Some(3839), Some(303)));
        assert_eq!(m["fetched"], "2026-11-09T21:00:00+00:00", "this build's own time");
        assert_eq!(m["stale"]["gaugesFrom"], "2026-11-03T22:21:37+00:00");
        assert_eq!(m["errors"], json!(["gauge layer 2: timeout: connect"]));
        assert!(m["gaugeSource"].is_null(), "a restored copy is not a fallback");
    }

    #[test]
    fn an_outage_with_no_good_copy_changes_nothing() {
        let (n, g) = (dir("none-n"), dir("none-g").join("absent"));
        empty_site(&n);
        let before = std::fs::read_to_string(n.join("meta.json")).unwrap();
        let msg = run(n.to_str().unwrap(), g.to_str().unwrap()).unwrap();
        assert!(msg.contains("no good copy"), "{msg}");
        assert_eq!(std::fs::read_to_string(n.join("meta.json")).unwrap(), before);
    }

    #[test]
    fn a_good_copy_with_no_gauges_is_not_used() {
        let (n, g) = (dir("zero-n"), dir("zero-g"));
        empty_site(&n);
        write(&g, "meta.json", r#"{"gauges":0}"#);
        write(&g, "gauges-core.min.json", r#"{"rows":[]}"#);
        assert!(run(n.to_str().unwrap(), g.to_str().unwrap()).unwrap().contains("no good copy"));
    }

    #[test]
    fn a_fallback_gauge_list_is_never_saved_as_the_good_copy() {
        let (n, g) = (dir("fb-n"), dir("fb-g").join("good"));
        good_site(&n);
        write(&n, "meta.json", r#"{"gauges":1747,"gaugeSource":"the Bureau's flood class feed"}"#);
        let msg = run(n.to_str().unwrap(), g.to_str().unwrap()).unwrap();
        assert!(msg.contains("fallback source"), "{msg}");
        assert!(!g.exists(), "nothing was saved");
    }
}
