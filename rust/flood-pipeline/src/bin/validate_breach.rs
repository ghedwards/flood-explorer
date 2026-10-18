// Breach parity check: flood-core's `breach_depressions_wbt` run on the
// reference dem.tif (max_dist=60, fill_deps=true) vs dem_breached.tif from
// whitebox_next_gen breach_depressions_least_cost.
// Run from the repo root after generating reference rasters in work/brisbane/.
#![allow(clippy::needless_range_loop)] // diagnostic binary: index loops are clearer here
use flood_core::hydro::breach_depressions_wbt;
use flood_pipeline::geo::read_geotiff;
use std::io::Write;
use std::path::Path;

fn main() {
    let read = |p: &str| read_geotiff(&std::fs::read(Path::new(p)).unwrap()).unwrap();
    let dem = read("work/brisbane/dem.tif");          // breach input
    let breached = read("work/brisbane/dem_breached.tif"); // reference output
    let (w, h) = (dem.w, dem.h);
    assert_eq!((breached.w, breached.h), (w, h));
    let nodata = dem.nodata.unwrap_or(f64::NAN);

    let cand = breach_depressions_wbt(&dem.data, w, h, nodata, dem.dx, f64::INFINITY, 60, false, true);

    let mut total = 0usize; let mut exact = 0usize; let mut diff_count = 0usize;
    let mut maxerr = 0f64; let mut maxerr_at = 0usize;
    for i in 0..w * h {
        if !dem.data[i].is_finite() || dem.data[i] == nodata || breached.data[i].is_nan() || breached.data[i] == nodata { continue; }
        total += 1;
        let diff = (cand[i] - breached.data[i]).abs();
        if diff < 1e-9 { exact += 1; } else { diff_count += 1; }
        if diff > maxerr { maxerr = diff; maxerr_at = i; }
    }
    println!("Breach parity: <1e-9 {}/{} = {:.3}% | differing: {} | maxerr: {:.3e} at cell {} (ref {:.4}, cand {:.4})",
             exact, total, 100.0 * exact as f64 / total as f64, diff_count, maxerr, maxerr_at, breached.data[maxerr_at], cand[maxerr_at]);
    std::io::stdout().flush().ok();
}
