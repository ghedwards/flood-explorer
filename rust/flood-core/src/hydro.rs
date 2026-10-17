//! Terrain analysis: sea, depression filling, D8 routing, accumulation,
//! streams, main stem and gauge placement.

use crate::grid::Grid;
use crate::util::*;

/// The result of analysing one terrain grid; every model run uses it.
#[derive(Clone, Debug, Default)]
pub struct Analysis {
    pub w: usize,
    pub h: usize,
    pub cell: f64,
    pub n: usize,
    pub dem: Vec<f32>,
    pub valid: Vec<u8>,
    pub ocean: Vec<u8>,
    /// depression-filled surface (priority-flood routing only)
    pub filled: Option<Vec<f64>>,
    /// downstream-first order of cells (receiver before donors)
    pub order: Vec<i32>,
    pub n_order: usize,
    pub rec: Vec<i32>,
    pub rec_dist: Vec<f32>,
    pub acc: Vec<f64>,
    pub chain: Vec<f64>,
    pub stream: Vec<u8>,
    pub recv_stream: Vec<i32>,
    pub main_outlet: i32,
    pub default_gauge: i32,
    pub stream_area_km2: f64,
    pub routed_by_pointers: bool,
}

struct Routed {
    rec: Vec<i32>,
    rec_dist: Vec<f32>,
    order: Vec<i32>,
    n_order: usize,
    filled: Option<Vec<f64>>,
}

fn touches_boundary(x: usize, y: usize, w: usize, h: usize, valid: &[u8]) -> bool {
    if x == 0 || y == 0 || x == w - 1 || y == h - 1 {
        return true;
    }
    for k in 0..4 {
        let n = (y as i64 + DY[k]) as usize * w + (x as i64 + DX[k]) as usize;
        if valid[n] == 0 {
            return true;
        }
    }
    false
}

/// Run the terrain analysis once per grid (stream threshold in km²).
pub fn analyse(g: &Grid, stream_area_km2: f64) -> Analysis {
    let (w, h, cell) = (g.w, g.h, g.cell);
    let n = w * h;
    let valid = g.valid.clone().unwrap_or_else(|| vec![1u8; n]);
    let dem = &g.dem;

    // sea: cells <= 0 m connected to the edge or to nodata
    let mut ocean = vec![0u8; n];
    let mut q = vec![0usize; n];
    let (mut qh, mut qt) = (0, 0);
    for y in 0..h {
        for x in 0..w {
            let i = y * w + x;
            if valid[i] != 0 && dem[i] <= 0.0 && touches_boundary(x, y, w, h, &valid) {
                ocean[i] = 1;
                q[qt] = i;
                qt += 1;
            }
        }
    }
    while qh < qt {
        let c = q[qh];
        qh += 1;
        let (cx, cy) = ((c % w) as i64, (c / w) as i64);
        for k in 0..4 {
            let (nx, ny) = (cx + DX[k], cy + DY[k]);
            if nx < 0 || ny < 0 || nx >= w as i64 || ny >= h as i64 {
                continue;
            }
            let nn = ny as usize * w + nx as usize;
            if ocean[nn] == 0 && valid[nn] != 0 && dem[nn] <= 0.0 {
                ocean[nn] = 1;
                q[qt] = nn;
                qt += 1;
            }
        }
    }

    let routed = match &g.d8 {
        Some(codes) => route_from_pointers(codes, w, h, cell, &valid),
        None => route_by_priority_flood(dem, w, h, cell, &valid),
    };
    let Routed { rec, rec_dist, order, n_order, filled } = routed;

    let mut acc = vec![0f64; n];
    for j in (0..n_order).rev() {
        let c = order[j] as usize;
        acc[c] += 1.0 + g.inflow.as_ref().map_or(0.0, |f| f[c] as f64);
        if rec[c] >= 0 {
            let r = rec[c] as usize;
            acc[r] += acc[c];
        }
    }
    let mut chain = vec![0f64; n];
    for &cell_index in order.iter().take(n_order) {
        let c = cell_index as usize;
        chain[c] = if rec[c] >= 0 { chain[rec[c] as usize] + rec_dist[c] as f64 } else { 0.0 };
    }

    let cell_area_km2 = (cell * cell) / 1e6;
    let thresh = stream_area_km2 / cell_area_km2;
    let mut stream = vec![0u8; n];
    for c in 0..n {
        if valid[c] != 0 && acc[c] >= thresh {
            stream[c] = 1;
        }
    }
    let mut recv_stream = vec![-1i32; n];
    for &cell_index in order.iter().take(n_order) {
        let c = cell_index as usize;
        if stream[c] != 0 {
            recv_stream[c] = c as i32;
        } else if rec[c] >= 0 {
            recv_stream[c] = recv_stream[rec[c] as usize];
        }
    }
    let (mut main_outlet, mut main_acc) = (-1i32, -1f64);
    for c in 0..n {
        if stream[c] != 0 && rec[c] < 0 && acc[c] > main_acc {
            main_acc = acc[c];
            main_outlet = c as i32;
        }
    }
    let mut a = Analysis {
        w,
        h,
        cell,
        n,
        dem: dem.clone(),
        valid,
        ocean,
        filled,
        order,
        n_order,
        rec,
        rec_dist,
        acc,
        chain,
        stream,
        recv_stream,
        main_outlet,
        default_gauge: -1,
        stream_area_km2,
        routed_by_pointers: g.d8.is_some(),
    };
    a.default_gauge = default_gauge(&a);
    a
}

/// Priority-flood depression filling (Barnes 2014, epsilon) then
/// steepest-descent D8, for terrain without precomputed flow directions.
fn route_by_priority_flood(dem: &[f32], w: usize, h: usize, cell: f64, valid: &[u8]) -> Routed {
    let n = w * h;
    let mut filled: Vec<f64> = dem.iter().map(|&v| v as f64).collect();
    let mut closed = vec![0u8; n];
    let mut heap = MinHeap::new(n);
    for i in 0..n {
        if valid[i] == 0 {
            closed[i] = 1;
        }
    }
    for y in 0..h {
        for x in 0..w {
            let i = y * w + x;
            if valid[i] == 0 {
                continue;
            }
            if touches_boundary(x, y, w, h, valid) {
                closed[i] = 1;
                heap.push(filled[i], i as i32);
            }
        }
    }
    let mut order = vec![0i32; n];
    let mut n_order = 0;
    const EPS: f64 = 1e-5;
    while heap.n > 0 {
        let c = heap.pop() as usize;
        order[n_order] = c as i32;
        n_order += 1;
        let (cx, cy) = ((c % w) as i64, (c / w) as i64);
        for k in 0..8 {
            let (nx, ny) = (cx + DX[k], cy + DY[k]);
            if nx < 0 || ny < 0 || nx >= w as i64 || ny >= h as i64 {
                continue;
            }
            let nn = ny as usize * w + nx as usize;
            if closed[nn] != 0 {
                continue;
            }
            closed[nn] = 1;
            if filled[nn] <= filled[c] {
                filled[nn] = filled[c] + EPS;
            }
            heap.push(filled[nn], nn as i32);
        }
    }
    let mut rec = vec![-1i32; n];
    let mut rec_dist = vec![0f32; n];
    for c in 0..n {
        if valid[c] == 0 {
            continue;
        }
        let (cx, cy) = ((c % w) as i64, (c / w) as i64);
        let (mut best, mut bn, mut bd) = (0f64, -1i32, 0f64);
        for k in 0..8 {
            let (nx, ny) = (cx + DX[k], cy + DY[k]);
            if nx < 0 || ny < 0 || nx >= w as i64 || ny >= h as i64 {
                continue;
            }
            let nn = ny as usize * w + nx as usize;
            if valid[nn] == 0 {
                continue;
            }
            let s = (filled[c] - filled[nn]) / DD[k];
            if s > best {
                best = s;
                bn = nn as i32;
                bd = DD[k];
            }
        }
        rec[c] = bn;
        rec_dist[c] = (bd * cell) as f32;
    }
    Routed { rec, rec_dist, order, n_order, filled: Some(filled) }
}

// Whitebox / GeoLibre D8 pointer codes (esri_pntr = false):
//   64 128   1        NW  N  NE
//   32   0   2   =>    W  .   E      0 = no outflow, other = nodata
//   16   8   4        SW  S  SE
const WBT_CODES: [i16; 8] = [1, 2, 4, 8, 16, 32, 64, 128];
const WBT_DX: [i64; 8] = [1, 1, 1, 0, -1, -1, -1, 0];
const WBT_DY: [i64; 8] = [-1, 0, 1, 1, 1, 0, -1, -1];

fn route_from_pointers(codes: &[i16], w: usize, h: usize, cell: f64, valid: &[u8]) -> Routed {
    let n = w * h;
    let mut rec = vec![-1i32; n];
    let mut rec_dist = vec![0f32; n];
    for c in 0..n {
        if valid[c] == 0 {
            continue;
        }
        let code = codes[c];
        let k = match WBT_CODES.iter().position(|&x| x == code) {
            Some(k) => k,
            None => continue,
        };
        let (cx, cy) = ((c % w) as i64, (c / w) as i64);
        let (nx, ny) = (cx + WBT_DX[k], cy + WBT_DY[k]);
        if nx < 0 || ny < 0 || nx >= w as i64 || ny >= h as i64 {
            continue;
        }
        let nn = ny as usize * w + nx as usize;
        if valid[nn] == 0 {
            continue;
        }
        rec[c] = nn as i32;
        rec_dist[c] = ((if WBT_DX[k] != 0 && WBT_DY[k] != 0 { SQRT2 } else { 1.0 }) * cell) as f32;
    }
    let (order, n_order) = topo_order(&rec, valid, n);
    let valid_count = valid.iter().map(|&v| v as usize).sum::<usize>();
    if n_order < valid_count {
        // break cycles: cells never released become outlets
        let mut indeg = vec![0i32; n];
        for c in 0..n {
            if rec[c] >= 0 {
                indeg[rec[c] as usize] += 1;
            }
        }
        // replay Kahn's algorithm to find the cells left with indegree > 0
        let mut up = Vec::with_capacity(n);
        for c in 0..n {
            if valid[c] != 0 && indeg[c] == 0 {
                up.push(c);
            }
        }
        let mut head = 0;
        while head < up.len() {
            let c = up[head];
            head += 1;
            let r = rec[c];
            if r >= 0 {
                indeg[r as usize] -= 1;
                if indeg[r as usize] == 0 {
                    up.push(r as usize);
                }
            }
        }
        for c in 0..n {
            if valid[c] != 0 && indeg[c] > 0 {
                rec[c] = -1;
            }
        }
        let (order, n_order) = topo_order(&rec, valid, n);
        return Routed { rec, rec_dist, order, n_order, filled: None };
    }
    Routed { rec, rec_dist, order, n_order, filled: None }
}

/// Downstream-first order from receivers (Kahn's algorithm, reversed).
fn topo_order(rec: &[i32], valid: &[u8], n: usize) -> (Vec<i32>, usize) {
    let mut indeg = vec![0i32; n];
    for c in 0..n {
        if rec[c] >= 0 {
            indeg[rec[c] as usize] += 1;
        }
    }
    let mut up: Vec<i32> = Vec::with_capacity(n);
    for c in 0..n {
        if valid[c] != 0 && indeg[c] == 0 {
            up.push(c as i32);
        }
    }
    let mut head = 0;
    while head < up.len() {
        let c = up[head] as usize;
        head += 1;
        let r = rec[c];
        if r >= 0 {
            indeg[r as usize] -= 1;
            if indeg[r as usize] == 0 {
                up.push(r);
            }
        }
    }
    let k = up.len();
    up.reverse();
    (up, k)
}

/// Receivers as Whitebox D8 codes (-32768 for no data, 0 for an outlet).
pub fn encode_whitebox_d8(a: &Analysis) -> Vec<i16> {
    let mut out = vec![0i16; a.n];
    for (c, code) in out.iter_mut().enumerate() {
        if a.valid[c] == 0 {
            *code = -32768;
            continue;
        }
        let r = a.rec[c];
        if r < 0 {
            continue;
        }
        let dx = (r as i64 % a.w as i64) - (c as i64 % a.w as i64);
        let dy = (r as i64 / a.w as i64) - (c as i64 / a.w as i64);
        for k in 0..8 {
            if WBT_DX[k] == dx && WBT_DY[k] == dy {
                *code = WBT_CODES[k];
                break;
            }
        }
    }
    out
}

fn main_donor(a: &Analysis, c: usize) -> i32 {
    let (cx, cy) = ((c % a.w) as i64, (c / a.w) as i64);
    let (mut best, mut b_acc) = (-1i32, -1f64);
    for k in 0..8 {
        let (nx, ny) = (cx + DX[k], cy + DY[k]);
        if nx < 0 || ny < 0 || nx >= a.w as i64 || ny >= a.h as i64 {
            continue;
        }
        let nn = ny as usize * a.w + nx as usize;
        if a.rec[nn] == c as i32 && a.stream[nn] != 0 && a.acc[nn] > b_acc {
            b_acc = a.acc[nn];
            best = nn as i32;
        }
    }
    best
}

/// The main stem from its headwater down to the main outlet.
pub fn main_stem(a: &Analysis) -> Vec<i32> {
    if a.main_outlet < 0 {
        return Vec::new();
    }
    let mut up = Vec::new();
    let mut c = a.main_outlet;
    while c >= 0 {
        up.push(c);
        c = main_donor(a, c as usize);
    }
    up.reverse();
    up
}

fn default_gauge(a: &Analysis) -> i32 {
    let stem = main_stem(a);
    if stem.is_empty() {
        return -1;
    }
    let l = a.chain[stem[0] as usize];
    let (mut best, mut bd) = (stem[0], f64::INFINITY);
    for &c in &stem {
        let d = (a.chain[c as usize] - 0.45 * l).abs();
        if d < bd {
            bd = d;
            best = c;
        }
    }
    best
}

/// Snap a cell to the nearest stream cell within r cells whose flow
/// accumulation is at least min_acc (0: any stream).
pub fn snap_to_stream(a: &Analysis, x: i64, y: i64, r: i64, min_acc: f64) -> i32 {
    let rr = if r == 0 { 10 } else { r };
    let floor = if min_acc.is_nan() { 0.0 } else { min_acc };
    let (mut best, mut bd) = (-1i32, f64::INFINITY);
    for dy in -rr..=rr {
        for dx in -rr..=rr {
            let (nx, ny) = (x + dx, y + dy);
            if nx < 0 || ny < 0 || nx >= a.w as i64 || ny >= a.h as i64 {
                continue;
            }
            let nn = ny as usize * a.w + nx as usize;
            if a.stream[nn] == 0 || a.acc[nn] < floor {
                continue;
            }
            let d = (dx * dx + dy * dy) as f64 - a.acc[nn].log10() * 0.01;
            if d < bd {
                bd = d;
                best = nn as i32;
            }
        }
    }
    best
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::grid::sample_terrain;

    #[test]
    fn sample_river_reaches_the_sea_with_a_gauge_on_it() {
        let a = analyse(&sample_terrain(), 4.0);
        assert!(a.main_outlet >= 0 && a.default_gauge >= 0);
        assert_eq!(a.stream[a.default_gauge as usize], 1);
        let stem = main_stem(&a);
        assert!(a.chain[stem[0] as usize] > 20000.0);
        let mut c = a.default_gauge;
        let mut sea = false;
        while c >= 0 {
            if a.ocean[c as usize] != 0 {
                sea = true;
            }
            c = a.rec[c as usize];
        }
        assert!(sea);
    }

    #[test]
    fn every_cell_drains_and_pointers_reproduce_routing() {
        let g = sample_terrain();
        let a = analyse(&g, 4.0);
        assert_eq!(a.n_order, a.n);
        let codes = encode_whitebox_d8(&a);
        let mut g2 = g.clone();
        g2.d8 = Some(codes);
        let b = analyse(&g2, 4.0);
        assert_eq!(a.rec, b.rec);
        assert_eq!(b.n_order, a.n);
        for c in (0..a.n).step_by(97) {
            assert!((a.acc[c] - b.acc[c]).abs() < 1e-6);
            assert!((a.chain[c] - b.chain[c]).abs() < 1e-3);
        }
    }
}

/// Compute a simple D8 flow-direction pointer (0-7 for the 8 neighbours,
/// 255 for no flow). This is a first-cut port; it does not yet reproduce
/// Whitebox's flat-resolution or least-cost breach behaviour.
pub fn d8_pointer_simple(dem: &[f32], w: usize, h: usize, nodata: f32) -> Vec<u8> {
    let n = w * h;
    let mut out = vec![255u8; n];
    // neighbour offsets (E, SE, S, SW, W, NW, N, NE) -> codes 1,2,4,8,16,32,64,128
    let nbrs: [(i64, i64, u8); 8] = [
        (1, 0, 1), (1, 1, 2), (0, 1, 4), (-1, 1, 8),
        (-1, 0, 16), (-1, -1, 32), (0, -1, 64), (1, -1, 128),
    ];
    for y in 0..h {
        for x in 0..w {
            let i = y * w + x;
            if !dem[i].is_finite() || dem[i] == nodata { continue; }
            let mut best_slope = 0.0f64;
            let mut best_code = 255u8;
            for &(dx, dy, code) in &nbrs {
                let nx = x as i64 + dx;
                let ny = y as i64 + dy;
                if nx < 0 || ny < 0 || nx >= w as i64 || ny >= h as i64 { continue; }
                let j = ny as usize * w + nx as usize;
                if !dem[j].is_finite() || dem[j] == nodata { continue; }
                let dist = if dx.abs() == 1 && dy.abs() == 1 { 1.414 } else { 1.0 };
                let slope = (dem[i] as f64 - dem[j] as f64) / (dist * 1.0); // cell size normalized
                if slope > best_slope {
                    best_slope = slope;
                    best_code = code;
                }
            }
            out[i] = best_code;
        }
    }
    out
}

#[cfg(test)]
mod d8_simple_tests {
    use super::*;
    #[test]
    fn slopes_downhill() {
        // 3x3: centre high, all neighbours lower to the east
        let mut dem = vec![5.0f32; 9];
        dem[5] = 2.0;
        let d = d8_pointer_simple(&dem, 3, 3, -9999.0);
        assert_eq!(d[4], 1); // east
    }
}
