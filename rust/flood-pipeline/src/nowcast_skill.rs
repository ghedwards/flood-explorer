//! `flood nowcast-skill`: how well does the radar forecast beat "no movement" on an archive of real frames?
//!
//! Reads a folder in the same format the broker serves (broker/README.md): `radar.json` plus one
//! little-endian `f32` mm/h file per frame, NaN where nothing was measured. Frames are split into runs
//! of consecutive, evenly spaced frames; a gap in time starts a new run, and a frame with a missing
//! cell makes the origins that need it count as skipped. The scoring itself is
//! `flood_core::nowcast::score` (tested on synthetic storms); this command only reads the archive and
//! writes the report. It fetches nothing and the archive must be data you have the right to use.
use crate::util::*;
use flood_core::nowcast::{score, SkillReport};
use flood_core::radar::RadarGrid;
use serde_json::{json, Value};
use std::path::Path;

/// The knobs of a scoring run.
pub struct Options { pub history: usize, pub max_lead: usize, pub thresholds: Vec<f32>, pub max_speed_m_s: f64 }

impl Default for Options {
    fn default() -> Self { Options { history: 4, max_lead: 12, thresholds: vec![1.0, 5.0, 10.0], max_speed_m_s: 25.0 } }
}

/// A radar archive: its grid in the radar's own coordinates (north-up, rows stepping south) and frames with their times (s).
pub struct Archive { pub grid: RadarGrid, pub source: String, pub crs: String, pub frames: Vec<(f64, Vec<f32>)> }

pub fn read_archive(dir: &Path) -> R<Archive> {
    let m = read_json(dir.join("radar.json"))?;
    let g = &m["grid"];
    let dim = |k: &str| g[k].as_u64().filter(|v| (2..=10_000).contains(v)).map(|v| v as usize).ok_or_else(|| format!("radar.json grid needs \"{k}\""));
    let num = |k: &str| g[k].as_f64().filter(|v| v.is_finite()).ok_or_else(|| format!("radar.json grid needs \"{k}\""));
    let (w, h) = (dim("w")?, dim("h")?);
    // RadarGrid counts y southward; the manifest gives the top edge's northing
    let grid = RadarGrid { w, h, x0: num("x0")?, y0: -num("y0")?, dx: num("dx")?, dy: num("dy")? };
    let mut frames = Vec::new();
    for f in m["frames"].as_array().ok_or("radar.json needs \"frames\"")? {
        let time = f["time"].as_str().and_then(|s| parse_iso(s, 0)).ok_or("every frame needs an ISO time")?;
        let name = f["file"].as_str().filter(|n| !n.is_empty() && !n.starts_with('.') && n.chars().all(|c| c.is_ascii_alphanumeric() || "._-".contains(c))).ok_or("every frame needs a plain file name")?;
        let bytes = std::fs::read(dir.join(name)).map_err(|e| format!("frame {name}: {e}"))?;
        if bytes.len() != w * h * 4 { return Err(format!("frame {name} is not {w} x {h} f32 values")); }
        #[allow(clippy::chunks_exact_to_as_chunks)]
        let values: Vec<f32> = bytes.chunks_exact(4).map(|b| f32::from_le_bytes([b[0], b[1], b[2], b[3]])).collect();
        frames.push((time, values));
    }
    if frames.windows(2).any(|p| p[1].0 <= p[0].0) { return Err("frames must be listed oldest first with no repeated times".into()); }
    Ok(Archive { grid, source: m["source"].as_str().unwrap_or("").to_string(), crs: m["crs"].as_str().unwrap_or("").to_string(), frames })
}

/// The commonest gap between consecutive frames (s), and the runs of frames that keep it (within a second).
pub fn runs(frames: &[(f64, Vec<f32>)]) -> R<(f64, Vec<Vec<usize>>)> {
    if frames.len() < 2 { return Err("an archive needs at least two frames".into()); }
    let mut counts: Vec<(i64, usize)> = Vec::new();
    for p in frames.windows(2) {
        let d = (p[1].0 - p[0].0).round() as i64;
        match counts.iter_mut().find(|(k, _)| *k == d) { Some(c) => c.1 += 1, None => counts.push((d, 1)) }
    }
    let step = counts.iter().max_by_key(|(d, n)| (*n, -*d)).map(|(d, _)| *d as f64).unwrap();
    let mut out: Vec<Vec<usize>> = vec![vec![0]];
    for i in 1..frames.len() {
        if ((frames[i].0 - frames[i - 1].0) - step).abs() <= 1.0 { out.last_mut().unwrap().push(i); } else { out.push(vec![i]); }
    }
    Ok((step, out))
}

fn num_or_null(v: f64) -> Value { if v.is_finite() { json!((v * 1e4).round() / 1e4) } else { Value::Null } }

pub fn report_json(a: &Archive, step_s: f64, run_lengths: &[usize], r: &SkillReport, o: &Options) -> Value {
    json!({
        "source": a.source, "crs": a.crs, "frames": a.frames.len(), "stepSeconds": step_s, "runs": run_lengths,
        "history": o.history, "maxSpeedMs": o.max_speed_m_s,
        "originsUsed": r.origins_used, "originsDry": r.origins_dry, "originsGappy": r.origins_gappy, "motionReliableShare": num_or_null(r.motion_reliable_share),
        "leads": r.leads.iter().map(|l| json!({
            "leadMinutes": l.lead_s / 60.0, "cases": l.cases, "rmseNowcast": num_or_null(l.rmse_nowcast), "rmsePersistence": num_or_null(l.rmse_persistence),
            "skill": num_or_null(l.skill), "biasRatio": num_or_null(l.bias_ratio),
            "thresholds": l.thresholds.iter().map(|t| json!({"mmPerHour": t.mm_h, "csiNowcast": num_or_null(t.csi_nowcast), "csiPersistence": num_or_null(t.csi_persistence), "pod": num_or_null(t.pod), "far": num_or_null(t.far)})).collect::<Vec<_>>(),
        })).collect::<Vec<_>>(),
        "note": "skill > 0 beats keeping the latest frame; this scores the rain field only, not flooding",
    })
}

/// Score an archive, optionally writing the JSON report to `out`; returns a short text summary.
pub fn run(dir: &str, o: &Options, out: Option<&str>) -> R<String> {
    let a = read_archive(Path::new(dir))?;
    let (step, groups) = runs(&a.frames)?;
    let usable: Vec<Vec<Vec<f32>>> = groups.iter().filter(|g| g.len() > o.history).map(|g| g.iter().map(|i| a.frames[*i].1.clone()).collect()).collect();
    if usable.is_empty() { return Err(format!("no run of {} or more consecutive frames {} s apart in {} frames", o.history + 1, step, a.frames.len())); }
    let refs: Vec<&[Vec<f32>]> = usable.iter().map(|v| v.as_slice()).collect();
    let r = score(&refs, &a.grid, step, o.history, o.max_lead, &o.thresholds, o.max_speed_m_s)?;
    let report = report_json(&a, step, &groups.iter().map(Vec::len).collect::<Vec<_>>(), &r, o);
    if let Some(path) = out { write_json_indent(path, &report, 2)?; }
    let mut s = format!("{} frames, {} runs, step {} s: {} origins scored ({} dry, {} with gaps), motion found for {}\n", a.frames.len(), groups.len(), step, r.origins_used, r.origins_dry, r.origins_gappy,
        if r.motion_reliable_share.is_finite() { format!("{:.0}%", r.motion_reliable_share * 100.0) } else { "none".into() });
    for l in &r.leads {
        s.push_str(&format!("  +{:>3.0} min: skill {:>6} (rmse {:.2} vs persistence {:.2} mm/h), bias {:>5}, {} cases\n", l.lead_s / 60.0,
            if l.skill.is_finite() { format!("{:.2}", l.skill) } else { "n/a".into() }, l.rmse_nowcast, l.rmse_persistence, if l.bias_ratio.is_finite() { format!("{:.2}", l.bias_ratio) } else { "n/a".into() }, l.cases));
    }
    Ok(s.trim_end().to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn bundle(dir: &Path, times: &[&str], f: impl Fn(usize, usize, usize) -> f32) {
        let (w, h) = (40usize, 40usize);
        let mut frames = Vec::new();
        for (k, t) in times.iter().enumerate() {
            let mut b = Vec::new();
            for y in 0..h { for x in 0..w { b.extend_from_slice(&f(k, x, y).to_le_bytes()); } }
            std::fs::write(dir.join(format!("f{k}.f32")), b).unwrap();
            frames.push(json!({"time": t, "file": format!("f{k}.f32")}));
        }
        let m = json!({"source": "Synthetic archive", "attribution": "x", "licence": "x", "crs": "EPSG:28356", "grid": {"w": w, "h": h, "x0": 0, "y0": 40000, "dx": 1000, "dy": 1000}, "frames": frames});
        std::fs::write(dir.join("radar.json"), m.to_string()).unwrap();
    }
    fn blob(k: usize, x: usize, y: usize) -> f32 {
        let (cx, cy) = (8.0 + 1.5 * k as f64, 20.0);
        (30.0 * (-(((x as f64 + 0.5) - cx).powi(2) + ((y as f64 + 0.5) - cy).powi(2)) / (2.0 * 3.0 * 3.0)).exp()) as f32
    }
    fn temp(name: &str) -> std::path::PathBuf {
        let d = std::env::temp_dir().join(format!("flood-skill-{name}-{}", std::process::id())); std::fs::create_dir_all(&d).unwrap(); d
    }
    const TIMES: [&str; 10] = ["2026-11-08T05:00:00Z", "2026-11-08T05:10:00Z", "2026-11-08T05:20:00Z", "2026-11-08T05:30:00Z", "2026-11-08T05:40:00Z", "2026-11-08T05:50:00Z",
        "2026-11-08T06:00:00Z", "2026-11-08T06:10:00Z", "2026-11-08T06:20:00Z", "2026-11-08T06:30:00Z"];

    #[test]
    fn it_scores_an_archive_and_writes_a_report() {
        let dir = temp("ok"); bundle(&dir, &TIMES, blob);
        let out = dir.join("report.json");
        let o = Options { history: 3, max_lead: 3, thresholds: vec![5.0], max_speed_m_s: 25.0 };
        let text = run(dir.to_str().unwrap(), &o, Some(out.to_str().unwrap())).unwrap();
        assert!(text.contains("10 frames, 1 runs, step 600 s") && text.contains("+ 10 min"), "{text}");
        let v = read_json(&out).unwrap();
        assert_eq!(v["source"], "Synthetic archive"); assert_eq!(v["leads"].as_array().unwrap().len(), 3);
        assert!(v["leads"][0]["skill"].as_f64().unwrap() > 0.7, "{}", v["leads"][0]);
        assert!(v["originsUsed"].as_u64().unwrap() >= 5 && v["motionReliableShare"].as_f64().unwrap() > 0.99);
        assert_eq!(v["leads"][0]["thresholds"][0]["mmPerHour"], 5.0);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_time_gap_splits_runs_and_short_archives_are_refused() {
        let dir = temp("gap");
        let times = ["2026-11-08T05:00:00Z", "2026-11-08T05:10:00Z", "2026-11-08T05:20:00Z", "2026-11-08T05:30:00Z", "2026-11-08T07:00:00Z", "2026-11-08T07:10:00Z", "2026-11-08T07:20:00Z", "2026-11-08T07:30:00Z"];
        bundle(&dir, &times, blob);
        let a = read_archive(&dir).unwrap();
        let (step, groups) = runs(&a.frames).unwrap();
        assert_eq!(step, 600.0); assert_eq!(groups, vec![vec![0, 1, 2, 3], vec![4, 5, 6, 7]], "the 90-minute gap starts a new run");
        // runs of 4 are too short for 4 history frames plus a frame to score against
        let e = run(dir.to_str().unwrap(), &Options::default(), None).unwrap_err();
        assert!(e.contains("no run of 5"), "{e}");
        let one = temp("one"); bundle(&one, &TIMES[..1], blob);
        assert!(run(one.to_str().unwrap(), &Options::default(), None).is_err());
        for d in [&dir, &one] { let _ = std::fs::remove_dir_all(d); }
    }

    #[test]
    fn a_bad_archive_is_an_error_not_a_score() {
        let dir = temp("bad"); bundle(&dir, &TIMES[..3], blob);
        std::fs::write(dir.join("f1.f32"), [0u8; 12]).unwrap();
        assert!(read_archive(&dir).err().unwrap().contains("not 40 x 40"));
        std::fs::write(dir.join("radar.json"), "{}").unwrap();
        assert!(read_archive(&dir).is_err());
        let _ = std::fs::remove_dir_all(&dir);
        assert!(run("/no/such/folder", &Options::default(), None).is_err());
    }
}
