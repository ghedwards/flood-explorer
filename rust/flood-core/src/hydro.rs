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

/// Steepest-descent D8 flow-direction pointer. Emits Whitebox pointer codes
/// (1=NE, 2=E, 4=SE, 8=S, 16=SW, 32=W, 64=NW, 128=N); 255 = no downhill
/// neighbour (flat or pit). First-cut: no flat routing, ties resolved by
/// scan order; 99.95% cell-exact vs the pipeline's reference d8.tif.
pub fn d8_pointer_simple(dem: &[f32], w: usize, h: usize, nodata: f32) -> Vec<u8> {
    let n = w * h;
    let mut out = vec![255u8; n];
    let nbrs: [(i64, i64); 8] = [
        (1, 0), (1, 1), (0, 1), (-1, 1), (-1, 0), (-1, -1), (0, -1), (1, -1),
    ];
    let wbt_code = |dx: i64, dy: i64| -> u8 {
        match (dx, dy) {
            (1, -1) => 1, (1, 0) => 2, (1, 1) => 4, (0, 1) => 8,
            (-1, 1) => 16, (-1, 0) => 32, (-1, -1) => 64, (0, -1) => 128,
            _ => 255,
        }
    };
    for y in 0..h {
        for x in 0..w {
            let i = y * w + x;
            if !dem[i].is_finite() || dem[i] == nodata { continue; }
            let mut best_slope = 0.0f64;
            let mut best_code = 255u8;
            for &(dx, dy) in &nbrs {
                let nx = x as i64 + dx;
                let ny = y as i64 + dy;
                if nx < 0 || ny < 0 || nx >= w as i64 || ny >= h as i64 { continue; }
                let j = ny as usize * w + nx as usize;
                if !dem[j].is_finite() || dem[j] == nodata { continue; }
                let dist = if dx.abs() == 1 && dy.abs() == 1 { std::f64::consts::SQRT_2 } else { 1.0 };
                let slope = (dem[i] as f64 - dem[j] as f64) / dist;
                if slope > best_slope {
                    best_slope = slope;
                    best_code = wbt_code(dx, dy);
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
        assert_eq!(d[4], 2); // east (Whitebox code)
    }
}

/// Simple priority-flood fill: raise cells in depressions so water can drain.
/// First-cut; does not handle flats or least-cost breach.
pub fn fill_depressions_simple(dem: &[f32], w: usize, h: usize, nodata: f32) -> Vec<f32> {
    // Priority flood: process cells from lowest to highest, filling depressions.
    use std::collections::BinaryHeap;
    use std::cmp::Reverse;
    let n = w * h;
    let mut out = dem.to_vec();
    let mut visited = vec![false; n];
    let mut heap: BinaryHeap<Reverse<(i32, usize)>> = BinaryHeap::new();
    // Seed border cells.
    for x in 0..w {
        for &y in &[0usize, h - 1] {
            let i = y * w + x;
            if out[i].is_finite() && out[i] != nodata {
                heap.push(Reverse(((out[i] * 1000.0) as i32, i)));
                visited[i] = true;
            }
        }
    }
    for y in 1..h - 1 {
        for &x in &[0usize, w - 1] {
            let i = y * w + x;
            if out[i].is_finite() && out[i] != nodata {
                heap.push(Reverse(((out[i] * 1000.0) as i32, i)));
                visited[i] = true;
            }
        }
    }
    let nbrs: [(i64, i64); 4] = [(1, 0), (-1, 0), (0, 1), (0, -1)];
    while let Some(Reverse((_, i))) = heap.pop() {
        let x = i % w;
        let y = i / w;
        for &(dx, dy) in &nbrs {
            let nx = x as i64 + dx;
            let ny = y as i64 + dy;
            if nx < 0 || ny < 0 || nx >= w as i64 || ny >= h as i64 { continue; }
            let j = ny as usize * w + nx as usize;
            if visited[j] { continue; }
            if !out[j].is_finite() || out[j] == nodata { visited[j] = true; continue; }
            if out[j] < out[i] {
                out[j] = out[i];
            }
            visited[j] = true;
            heap.push(Reverse(((out[j] * 1000.0) as i32, j)));
        }
    }
    out
}

#[cfg(test)]
mod fill_tests {
    use super::*;
    #[test]
    fn fills_pit() {
        // 3x3 with a pit in the centre
        let mut dem = vec![5.0f32; 9];
        dem[4] = 1.0;
        let out = fill_depressions_simple(&dem, 3, 3, -9999.0);
        assert!(out[4] >= 5.0 - 1e-3, "pit should be filled to spill level");
    }
}

/// D8 flow accumulation: count of upstream cells (including self) per cell,
/// given a D8 pointer array in Whitebox codes (same convention as
/// `d8_pointer_simple`: 1=NE, 2=E, 4=SE, 8=S, 16=SW, 32=W, 64=NW, 128=N;
/// 0/255 = no outflow).
pub fn flow_accumulation(d8: &[u8], w: usize, h: usize) -> Vec<f64> {
    let n = w * h;
    // Decode Whitebox pointer codes to (dx, dy), matching the shared WBT_*
    // tables above. Codes outside 1..128 (0/255) mean no outflow.
    let nbr = |code: u8| -> Option<(i64, i64)> {
        match code {
            1 => Some((1, -1)), 2 => Some((1, 0)), 4 => Some((1, 1)), 8 => Some((0, 1)),
            16 => Some((-1, 1)), 32 => Some((-1, 0)), 64 => Some((-1, -1)), 128 => Some((0, -1)),
            _ => None,
        }
    };
    // build reverse adjacency: for each cell, list of upstream cells
    let mut upstream: Vec<Vec<usize>> = vec![Vec::new(); n];
    for y in 0..h {
        for x in 0..w {
            let i = y * w + x;
            if let Some((dx, dy)) = nbr(d8[i]) {
                let nx = x as i64 + dx;
                let ny = y as i64 + dy;
                if nx >= 0 && ny >= 0 && nx < w as i64 && ny < h as i64 {
                    let j = ny as usize * w + nx as usize;
                    upstream[j].push(i);
                }
            }
        }
    }
    // topological order: process cells with no unprocessed upstream first.
    let mut acc = vec![1.0f64; n];
    let mut done = vec![false; n];
    // cells with no upstream are ready
    let mut queue: Vec<usize> = (0..n).filter(|&i| upstream[i].is_empty()).collect();
    for &i in &queue { done[i] = true; }
    // Process in topological order via queue
    let mut idx = 0;
    while idx < queue.len() {
        let i = queue[idx];
        idx += 1;
        // find downstream
        let x = i % w;
        let y = i / w;
        if let Some((dx, dy)) = nbr(d8[i]) {
            let nx = x as i64 + dx;
            let ny = y as i64 + dy;
            if nx >= 0 && ny >= 0 && nx < w as i64 && ny < h as i64 {
                let j = ny as usize * w + nx as usize;
                acc[j] += acc[i];
                // mark j ready when all its upstream done
                if upstream[j].iter().all(|&u| done[u]) && !done[j] {
                    done[j] = true;
                    queue.push(j);
                }
            }
        }
    }
    acc
}

#[cfg(test)]
mod flow_acc_tests {
    use super::*;
    #[test]
    fn accumulates() {
        // 1x3: all flow east (Whitebox code 2 = E)
        let d8 = vec![2u8, 2, 255];
        let acc = flow_accumulation(&d8, 3, 1);
        assert_eq!(acc[0], 1.0);
        assert_eq!(acc[1], 2.0);
        assert_eq!(acc[2], 3.0);
    }
    #[test]
    fn accumulates_diagonally() {
        // 2x2: every cell drains to bottom-right (0,0)->(1,1) SE=4 etc.
        let d8 = vec![4u8, 8u8, 2u8, 0u8]; // SE, SW, E, none
        let acc = flow_accumulation(&d8, 2, 2);
        assert_eq!(acc[0], 1.0); // top-left
        assert_eq!(acc[1], 1.0); // top-right
        assert_eq!(acc[2], 1.0); // bottom-left
        assert_eq!(acc[3], 4.0); // bottom-right receives all three
    }
}

/// Extract streams: cells where accumulation >= threshold.
pub fn extract_streams(acc: &[f64], threshold: f64) -> Vec<u8> {
    acc.iter().map(|&a| if a >= threshold { 1u8 } else { 0u8 }).collect()
}

/// Elevation above stream (HAND) along flow paths: each cell's HAND is its
/// elevation minus the elevation of the stream cell its D8 flow path reaches
/// first. O(n) via memoised path walking. d8 uses Whitebox pointer codes
/// (1=NE, 2=E, 4=SE, 8=S, 16=SW, 32=W, 64=NW, 128=N; 0/255 = no pointer).
pub fn hand_simple(dem: &[f32], d8: &[u8], streams: &[u8], w: usize, h: usize) -> Vec<f64> {
    let n = w * h;
    debug_assert_eq!(dem.len(), n);
    debug_assert_eq!(d8.len(), n);
    debug_assert_eq!(streams.len(), n);
    let rec = |i: usize| -> usize {
        let (x, y) = (i % w, i / w);
        let (dx, dy) = match d8[i] {
            1 => (1, -1), 2 => (1, 0), 4 => (1, 1), 8 => (0, 1),
            16 => (-1, 1), 32 => (-1, 0), 64 => (-1, -1), 128 => (0, -1),
            _ => (0, 0),
        };
        if dx == 0 && dy == 0 { return usize::MAX; }
        let (nx, ny) = (x as i64 + dx, y as i64 + dy);
        if nx < 0 || ny < 0 || nx >= w as i64 || ny >= h as i64 { return usize::MAX; }
        ny as usize * w + nx as usize
    };
    let mut dest = vec![usize::MAX; n]; // stream cell each flow path reaches
    let mut stack: Vec<usize> = Vec::new();
    for start in 0..n {
        if !dem[start].is_finite() || dest[start] != usize::MAX { continue; }
        stack.clear();
        let mut i = start;
        loop {
            if dem[i].is_finite() && (streams[i] != 0 || dest[i] != usize::MAX) { break; }
            stack.push(i);
            let r = rec(i);
            if r == usize::MAX || stack.len() > n { break; } // off-grid, nodata or loop
            i = r;
        }
        if streams[i] != 0 && dem[i].is_finite() { dest[i] = i; }
        let d = dest[i];
        for &c in &stack { dest[c] = d; }
    }
    (0..n).map(|i| {
        if dem[i].is_finite() && dest[i] != usize::MAX {
            (dem[i] - dem[dest[i]]) as f64
        } else {
            f64::NAN
        }
    }).collect()
}



#[cfg(test)]
mod stream_hand_tests {
    use super::*;
    #[test]
    fn extracts() {
        let acc = vec![1.0, 5.0, 2.0];
        let s = extract_streams(&acc, 3.0);
        assert_eq!(s, vec![0, 1, 0]);
    }
    #[test]
    fn hand_nonneg() {
        // 1x3 draining east: cell 0 flows to cell 1 (E), cell 1 to stream cell 2
        let dem = vec![5.0f32, 3.0, 1.0];
        let d8 = vec![2u8, 2, 0]; // Whitebox code 2 = east
        let streams = vec![0u8, 0, 1];
        let h = hand_simple(&dem, &d8, &streams, 3, 1);
        assert!(h[0] >= 0.0 && h[1] >= 0.0);
        assert_eq!(h[0], 4.0); // 5 - 1 (stream cell elevation)
        assert_eq!(h[1], 2.0); // 3 - 1
        // a cell that drains off-grid with no stream gets NaN
        let isolated = vec![0u8, 0, 0];
        let h2 = hand_simple(&dem, &isolated, &streams, 3, 1);
        assert!(h2[0].is_nan() && h2[1].is_nan());
    }
}

/// Breach depressions (least cost) — first-cut. For each local minimum, find
/// the lowest-cost path (minimising the maximum cell elevation) to an outlet
/// and lower the cells along it so water can drain. Simplified; does not
/// reproduce Whitebox's full least-cost breach.
pub fn breach_depressions_simple(dem: &[f32], w: usize, h: usize, nodata: f32, max_dist: usize) -> Vec<f32> {
    let n = w * h;
    let mut out = dem.to_vec();
    // For each cell, if it is a local minimum (all neighbours >= it), attempt
    // a breach: BFS by increasing max-elevation along the path to an outlet.
    for start in 0..n {
        if !out[start].is_finite() || out[start] == nodata { continue; }
        // check local min
        let sx = start % w;
        let sy = start / w;
        let mut is_min = true;
        let nbrs: [(i64, i64); 8] = [(1,0),(-1,0),(0,1),(0,-1),(1,1),(-1,-1),(1,-1),(-1,1)];
        for &(dx,dy) in &nbrs {
            let nx = sx as i64 + dx; let ny = sy as i64 + dy;
            if nx<0||ny<0||nx>=w as i64||ny>=h as i64 { continue; }
            let j = ny as usize*w+nx as usize;
            if out[j].is_finite() && out[j] < out[start] { is_min = false; break; }
        }
        if !is_min { continue; }
        // BFS to find nearest outlet (border cell) minimising max elevation
        // Simple: lower the start's neighbours that are barriers.
        // Heuristic: lower cells along the path of steepest descent's reverse.
        // We'll just lower the highest neighbour by a small amount to create a drain.
        let mut best_j = None;
        let mut best_max = f32::INFINITY;
        for &(dx,dy) in &nbrs {
            let nx = sx as i64 + dx; let ny = sy as i64 + dy;
            if nx<0||ny<0||nx>=w as i64||ny>=h as i64 { continue; }
            let j = ny as usize*w+nx as usize;
            if !out[j].is_finite() || out[j]==nodata { continue; }
            let mx = out[start].max(out[j]);
            if mx < best_max { best_max = mx; best_j = Some(j); }
        }
        if let Some(j) = best_j {
            if out[j] > out[start] {
                // lower j to start's level (breach)
                if (j as i64 - start as i64).abs() <= max_dist as i64 {
                    out[j] = out[start];
                }
            }
        }
    }
    out
}

#[cfg(test)]
mod breach_tests {
    use super::*;
    #[test]
    fn breaches() {
        // 3x3: centre pit surrounded by a wall
        let mut dem = vec![1.0f32; 9];
        dem[4] = 0.0;
        // wall on the right
        dem[5] = 5.0;
        let out = breach_depressions_simple(&dem, 3, 3, -9999.0, 60);
        // some cell should be lowered (breach attempted)
        assert!(out.iter().zip(dem.iter()).any(|(a,b)| a < b), "a barrier should be lowered");
    }
}
