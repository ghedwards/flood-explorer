// Fill-depressions parity check: flood-core's `fill_depressions_wbt` run on
// the reference dem_breached.tif vs the reference dem_cond.tif (produced by
// whitebox_next_gen `fill_depressions --fix_flats=true`).
// Run from the repo root after generating reference rasters in work/brisbane/.
#![allow(clippy::needless_range_loop)] // diagnostic binary: index loops are clearer here
use flood_core::hydro::fill_depressions_wbt;
use flood_pipeline::geo::read_geotiff;
use std::io::Write;
use std::path::Path;

fn main() {
    let read = |p: &str| read_geotiff(&std::fs::read(Path::new(p)).unwrap()).unwrap();
    let breached = read("work/brisbane/dem_breached.tif"); // fill input
    let cond = read("work/brisbane/dem_cond.tif");        // fill reference output
    let (w, h) = (breached.w, breached.h);
    assert_eq!((cond.w, cond.h), (w, h));
    // Reference call had cell 40 m in both axes and fix_flats=true.
    let nodata = breached.nodata.unwrap_or(f64::NAN);
    let cand = fill_depressions_wbt(&breached.data, w, h, nodata, breached.dx, true);

    let mut total = 0usize; let mut exact = 0usize; let mut diff_count = 0usize;
    let mut maxerr = 0f64; let mut maxerr_at = 0usize;
    for i in 0..w * h {
        if !breached.data[i].is_finite() || breached.data[i] == nodata || cond.data[i].is_nan() || cond.data[i] == nodata { continue; }
        total += 1;
        let diff = (cand[i] - cond.data[i]).abs();
        if diff < 1e-9 { exact += 1; } else { diff_count += 1; }
        if diff > maxerr { maxerr = diff; maxerr_at = i; }
    }
    println!("Fill parity: bit-exact-ish(<1e-9) {}/{} = {:.3}% | differing: {} | maxerr: {:.3e} at cell {} (ref {:.4}, cand {:.4})",
             exact, total, 100.0 * exact as f64 / total as f64, diff_count, maxerr, maxerr_at, cond.data[maxerr_at], cand[maxerr_at]);
    std::io::stdout().flush().ok();
}
