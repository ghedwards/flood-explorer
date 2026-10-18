// HAND parity check: flood-core's flow-path `hand_simple` vs the
// whitebox_next_gen reference raster from `flood hydrology` (hand.tif).
// Run from the repo root after generating reference rasters in work/brisbane/.
#![allow(clippy::needless_range_loop)] // diagnostic binary: index loops are clearer here
use flood_core::hydro::hand_simple;
use flood_pipeline::geo::read_geotiff;
use std::io::Write;
use std::path::Path;

fn main() {
    let read = |p: &str| read_geotiff(&std::fs::read(Path::new(p)).unwrap()).unwrap();
    let dem = read("work/brisbane/dem_cond.tif");
    let d8 = read("work/brisbane/d8.tif");
    let strm = read("work/brisbane/streams.tif");
    let hr = read("work/brisbane/hand.tif");
    let (w, h) = (dem.w, dem.h);
    assert_eq!((d8.w, d8.h, strm.w, strm.h, hr.w, hr.h), (w, h, w, h, w, h));

    let demf: Vec<f32> = dem.data.iter().map(|&v| v as f32).collect();
    let d8u: Vec<u8> = d8.data.iter().map(|&v| v as u8).collect();
    let strm_u: Vec<u8> = strm.data.iter().map(|&v| if v != 0.0 { 1u8 } else { 0 }).collect();
    let cand = hand_simple(&demf, &d8u, &strm_u, w, h);

    let mut matched = 0usize; let mut total = 0usize; let mut close = 0usize;
    let mut maxerr = 0f64; let mut nones = 0usize;
    for i in 0..w * h {
        if !demf[i].is_finite() || hr.data[i].is_nan() { continue; }
        total += 1;
        if cand[i].is_nan() { nones += 1; continue; }
        let diff = (cand[i] - hr.data[i]).abs();
        if diff > maxerr { maxerr = diff; }
        if diff < 0.25 { matched += 1; }
        if diff < 1.0 { close += 1; }
    }
    println!("HAND parity: exact(<0.25m) {}/{} = {:.2}% | <1m: {:.2}% | unmatched-by-impl: {} | maxerr: {:.2}",
             matched, total, 100.0 * matched as f64 / total as f64,
             100.0 * close as f64 / total as f64, nones, maxerr);
    std::io::stdout().flush().ok();
}
