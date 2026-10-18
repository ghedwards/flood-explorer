#![allow(clippy::needless_range_loop)] // diagnostic binary: index loops are clearer here
use flood_pipeline::geo::read_geotiff;
use std::path::Path;
fn main() {
    let dem = std::fs::read(Path::new("work/brisbane/dem_cond.tif")).unwrap();
    let d8ref = std::fs::read(Path::new("work/brisbane/d8.tif")).unwrap();
    let dr = read_geotiff(&dem).unwrap();
    let rr = read_geotiff(&d8ref).unwrap();
    let (w,h) = (dr.w, dr.h);
    let wbt_dx: [i64;8] = [1,1,1,0,-1,-1,-1,0];
    let wbt_dy: [i64;8] = [-1,0,1,1,1,0,-1,-1];
    let wbt_codes: [u8;8] = [1,2,4,8,16,32,64,128];
    let browser_nbrs: [(i64,i64);8] = [(1,0),(1,1),(0,1),(-1,1),(-1,0),(-1,-1),(0,-1),(1,-1)];
    let mut cand = vec![255u8; w*h];
    for y in 0..h {
        for x in 0..w {
            let i = y*w+x;
            if !dr.data[i].is_finite() { continue; }
            let mut best = 0.0f64; let mut bdx=0i64; let mut bdy=0i64;
            for &(dx,dy) in &browser_nbrs {
                let nx=x as i64+dx; let ny=y as i64+dy;
                if nx<0||ny<0||nx>=w as i64||ny>=h as i64 { continue; }
                let j=ny as usize*w+nx as usize;
                if !dr.data[j].is_finite() { continue; }
                let dist = if dx.abs()==1 && dy.abs()==1 {1.414} else {1.0};
                let slope=(dr.data[i]-dr.data[j]) as f64 / dist;
                if slope>best { best=slope; bdx=dx; bdy=dy; }
            }
            // convert (dx,dy) to Whitebox code
            let mut code = 255u8;
            for k in 0..8 {
                if wbt_dx[k]==bdx && wbt_dy[k]==bdy { code = wbt_codes[k]; break; }
            }
            cand[i]=code;
        }
    }
    let mut matchn=0usize; let mut total=0usize;
    for i in 0..w * h {
        if rr.data[i]==255.0 || !dr.data[i].is_finite() { continue; }
        total+=1;
        if cand[i]==rr.data[i] as u8 { matchn+=1; }
    }
    println!("D8 match: {}/{} = {:.2}%", matchn, total, 100.0*matchn as f64/total as f64);
}
