use flood_pipeline::geo::read_geotiff;
use flood_core::hydro::flow_accumulation;
use std::path::Path;
fn main() {
    let d8ref = std::fs::read(Path::new("work/brisbane/d8.tif")).unwrap();
    let accref = std::fs::read(Path::new("work/brisbane/acc.tif")).unwrap();
    let dr = read_geotiff(&d8ref).unwrap();
    let ar = read_geotiff(&accref).unwrap();
    let w = dr.w; let h = dr.h;
    // convert Whitebox d8 to browser codes? flow_accumulation takes u8 codes (Whitebox format).
    // Our flow_accumulation expects browser codes (1,2,4,...ESRI). Need Whitebox codes.
    // Whitebox codes: map to (dx,dy) then we need to feed browser codes to flow_accumulation.
    // flow_accumulation uses codes 1,2,4,8,16,32,64,128 with browser (ESRI) mapping.
    // Let's convert Whitebox codes to browser codes first.
    let wb_to_browser: std::collections::HashMap<u8,(i64,i64)> = [
        (1u8,(1i64,-1i64)),(2,(1,0)),(4,(1,1)),(8,(0,1)),
        (16,(-1,1)),(32,(-1,0)),(64,(-1,-1)),(128,(0,-1)),
    ].iter().cloned().collect();
    let browser_code = |dx:i64,dy:i64| -> u8 {
        match (dx,dy) {
            (1,0)=>1,(1,1)=>2,(0,1)=>4,(-1,1)=>8,
            (-1,0)=>16,(-1,-1)=>32,(0,-1)=>64,(1,-1)=>128,_=>255,
        }
    };
    let mut d8_browser = vec![255u8; w*h];
    for i in 0..w*h {
        if let Some(&(dx,dy)) = wb_to_browser.get(&(dr.data[i] as u8)) {
            d8_browser[i] = browser_code(dx,dy);
        }
    }
    let cand = flow_accumulation(&d8_browser, w, h);
    let mut matchn=0usize; let mut total=0usize; let mut maxerr=0f64;
    for i in 0..w*h {
        if !dr.data[i].is_finite() || ar.data[i].is_nan() { continue; }
        total+=1;
        let diff = (cand[i]-ar.data[i]).abs();
        if diff > maxerr { maxerr=diff; }
        if diff < 0.5 { matchn+=1; }
    }
    println!("FlowAcc match: {}/{} = {:.2}%, maxerr={:.2}", matchn, total, 100.0*matchn as f64/total as f64, maxerr);
}
