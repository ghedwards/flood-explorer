#![allow(clippy::needless_range_loop)] // diagnostic binary: index loops are clearer here
use flood_pipeline::geo::read_geotiff;
use flood_core::hydro::extract_streams;
use std::path::Path;
fn main() {
    let accref = std::fs::read(Path::new("work/brisbane/acc.tif")).unwrap();
    let streamsref = std::fs::read(Path::new("work/brisbane/streams.tif")).unwrap();
    let ar = read_geotiff(&accref).unwrap();
    let sr = read_geotiff(&streamsref).unwrap();
    let w = ar.w; let h = ar.h;
    let threshold = 625.0; // from hydrology log: extract_streams threshold=625
    let cand = extract_streams(&ar.data, threshold);
    let mut matchn=0usize; let mut total=0usize;
    for i in 0..w * h {
        if !ar.data[i].is_finite() { continue; }
        total+=1;
        let refv = if sr.data[i] == 0.0 { 0u8 } else { 1u8 };
        if cand[i] == refv { matchn+=1; }
    }
    println!("Streams match: {}/{} = {:.2}%", matchn, total, 100.0*matchn as f64/total as f64);
}
