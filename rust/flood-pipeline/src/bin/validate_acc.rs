// Flow-accumulation parity check: flood-core's `flow_accumulation` fed the
// reference D8 raster (d8.tif) vs the whitebox_next_gen reference acc.tif.
// Run from the repo root after generating reference rasters in work/brisbane/.
#![allow(clippy::needless_range_loop)] // diagnostic binary: index loops are clearer here
use flood_core::hydro::flow_accumulation;
use flood_pipeline::geo::read_geotiff;
use std::io::Write;
use std::path::Path;

fn main() {
    let read = |p: &str| read_geotiff(&std::fs::read(Path::new(p)).unwrap()).unwrap();
    let d8 = read("work/brisbane/d8.tif");
    let ar = read("work/brisbane/acc.tif");
    let (w, h) = (d8.w, d8.h);
    assert_eq!((ar.w, ar.h), (w, h));

    let d8u: Vec<u8> = d8.data.iter().map(|&v| v as u8).collect();
    let cand = flow_accumulation(&d8u, w, h);

    let mut matchn = 0usize; let mut total = 0usize; let mut maxerr = 0f64;
    for i in 0..w * h {
        if !d8.data[i].is_finite() || ar.data[i].is_nan() { continue; }
        total += 1;
        let diff = (cand[i] - ar.data[i]).abs();
        if diff > maxerr { maxerr = diff; }
        if diff < 0.5 { matchn += 1; }
    }
    println!("FlowAcc parity: {}/{} = {:.2}%, maxerr: {:.2}",
             matchn, total, 100.0 * matchn as f64 / total as f64, maxerr);
    std::io::stdout().flush().ok();
}
