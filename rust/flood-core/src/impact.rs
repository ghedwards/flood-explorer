//! The flood's effect on buildings, people, workers and roads for one model run: a port of the sweep in
//! `computeScenarioImpact` (viewer/app.js) and of the prepared-network helpers beside it. The
//! caller prepares what depends only on the area and the grid once (road network as CSR adjacency, the cell
//! under each building, SA1/SA2 grids and their population shares); this does what changes with the run.

const DEEP: f64 = 0.3;
const CENTRE_DEEP: f64 = 0.15;
const HOME_DEEP: f64 = 0.15;
const BIG_DEEP: f64 = 0.5;

/// Water over a cell, counting only land that is wet (the sea is not flood).
fn depth_at(wet: &[u8], depth: &[f32], ocean: &[u8], c: i32) -> f64 {
    if c < 0 {
        return 0.0;
    }
    let c = c as usize;
    if wet[c] != 0 && ocean.get(c).copied().unwrap_or(0) == 0 {
        depth[c] as f64
    } else {
        0.0
    }
}

/// The grid's geography, to turn a position into a cell exactly as the page's `cellOf` does.
#[derive(Clone, Copy, Debug)]
pub struct Geo {
    pub west: f64,
    pub east: f64,
    pub south: f64,
    pub north: f64,
    pub w: usize,
    pub h: usize,
}

impl Geo {
    pub fn cell_of(&self, lat: f64, lon: f64) -> i32 {
        let x = (((lon - self.west) / (self.east - self.west)) * self.w as f64).floor();
        let y = (((self.north - lat) / (self.north - self.south)) * self.h as f64).floor();
        if x < 0.0 || y < 0.0 || x >= self.w as f64 || y >= self.h as f64 {
            -1
        } else {
            (y as usize * self.w + x as usize) as i32
        }
    }
}

pub struct RunRoads {
    /// per edge: 1 if any of its five samples is under more than 0.3 m of water
    pub closed: Vec<u8>,
    /// per road node: 1 if its cell is under more than 0.3 m
    pub wet: Vec<u8>,
    /// per evacuation centre: 1 if its cell is under more than 0.15 m
    pub flooded: Vec<u8>,
}

/// Which road edges, road nodes and evacuation centres are flooded in a run. `sample` holds five cells per
/// edge (-1 outside the grid).
pub fn prepare_run(sample: &[i32], node_cell: &[i32], centre_cell: &[i32], wet: &[u8], depth: &[f32], ocean: &[u8]) -> RunRoads {
    let deep = |c: i32| c >= 0 && wet[c as usize] != 0 && ocean.get(c as usize).copied().unwrap_or(0) == 0 && depth[c as usize] as f64 >= DEEP;
    let closed = sample.chunks(5).map(|s| s.iter().any(|&c| deep(c)) as u8).collect();
    let wet_nodes = node_cell.iter().map(|&c| deep(c) as u8).collect();
    let flooded = centre_cell.iter().map(|&c| (c >= 0 && wet[c as usize] != 0 && depth[c as usize] as f64 >= CENTRE_DEEP) as u8).collect();
    RunRoads { closed, wet: wet_nodes, flooded }
}

pub struct ImpactIn<'a> {
    pub geo: Geo,
    pub cell_m: f64,
    // the run
    pub wet: &'a [u8],
    pub depth: &'a [f32],
    pub ocean: &'a [u8],
    // buildings
    pub b_cell: &'a [i32],
    pub is_home: &'a [u8],
    pub is_work: &'a [u8],
    /// nearest road node per building (-1 none)
    pub b_node: &'a [i32],
    // road network: CSR adjacency, edge ends, node on the edge of the model, joined to it when nothing is flooded
    pub off: &'a [i32],
    pub to: &'a [i32],
    pub edge: &'a [i32],
    pub edge_u: &'a [i32],
    pub edge_v: &'a [i32],
    pub exit: &'a [u8],
    pub dry_reach: &'a [u8],
    // this run's flooded roads (prepare_run)
    pub closed: &'a [u8],
    pub road_wet: &'a [u8],
    // people: SA1 grid (-1 outside), each area's population share inside the model, and its land cells
    pub sa1_grid: &'a [i32],
    pub sa1_pop: &'a [f64],
    pub sa1_land: &'a [f64],
    // workers: SA2 grid and each area's workers inside the model
    pub sa2_grid: &'a [i32],
    pub sa2_workers: &'a [f64],
    // road geometry: points of every road, with road r's points at road_off[r]..road_off[r + 1]
    pub road_lat: &'a [f64],
    pub road_lon: &'a [f64],
    pub road_off: &'a [i32],
}

#[derive(Default)]
pub struct ImpactOut {
    pub b_depth: Vec<f32>,
    pub b_flood: Vec<u8>,
    pub b_wet: i32,
    pub b_deep: i32,
    pub h_wet: i32,
    pub work_wet: i32,
    pub cut_edges: Vec<i32>,
    pub island_edges: Vec<i32>,
    pub isolated_b: i32,
    pub iso: Vec<u8>,
    pub people: f64,
    pub people_isolated: f64,
    pub workers: f64,
    pub workers_all: f64,
    pub road_cut_km: Vec<f64>,
    pub road_km: f64,
}

#[allow(clippy::needless_range_loop)]
pub fn impact_sweep(a: &ImpactIn) -> ImpactOut {
    let n_b = a.b_cell.len();
    let mut o = ImpactOut { b_depth: vec![0.0; n_b], b_flood: vec![0; n_b], iso: vec![0; n_b], ..Default::default() };
    // buildings
    for i in 0..n_b {
        let z = depth_at(a.wet, a.depth, a.ocean, a.b_cell[i]);
        o.b_depth[i] = z as f32;
        // (the page keeps the depth as a Float32 and compares the float, as here)
        let z = o.b_depth[i] as f64;
        if z >= HOME_DEEP {
            o.b_wet += 1;
            o.b_flood[i] = 1;
            if a.is_home[i] != 0 {
                o.h_wet += 1;
            }
            if a.is_work[i] != 0 {
                o.work_wet += 1;
            }
            if z >= BIG_DEEP {
                o.b_deep += 1;
            }
        }
    }
    // roads: edges under water, and the dry road nodes still joined to the edge of the model
    let n_nodes = a.road_wet.len();
    if n_nodes > 0 {
        let mut reach = vec![0u8; n_nodes];
        let mut q: Vec<i32> = Vec::with_capacity(n_nodes);
        for n in 0..n_nodes {
            if a.exit[n] != 0 && a.road_wet[n] == 0 {
                reach[n] = 1;
                q.push(n as i32);
            }
        }
        let mut h = 0;
        while h < q.len() {
            let u = q[h] as usize;
            h += 1;
            for p in a.off[u] as usize..a.off[u + 1] as usize {
                let m = a.to[p] as usize;
                if reach[m] == 0 && a.closed[a.edge[p] as usize] == 0 {
                    reach[m] = 1;
                    q.push(m as i32);
                }
            }
        }
        for k in 0..a.closed.len() {
            if a.closed[k] != 0 {
                o.cut_edges.push(k as i32);
            } else if reach[a.edge_u[k] as usize] == 0 || reach[a.edge_v[k] as usize] == 0 {
                o.island_edges.push(k as i32);
            }
        }
        // dry buildings whose nearest road node is cut off from the edge, though the whole network joins it
        for i in 0..n_b {
            if o.b_flood[i] != 0 {
                continue;
            }
            let b = a.b_node[i];
            if b >= 0 {
                let b = b as usize;
                if a.road_wet[b] == 0 && reach[b] == 0 && a.dry_reach[b] != 0 {
                    o.iso[i] = 1;
                    o.isolated_b += 1;
                }
            }
        }
    }
    // people: each SA1's population spread over its buildings (or its land)
    if !a.sa1_pop.is_empty() {
        let ns = a.sa1_pop.len();
        let (mut tot, mut hit, mut wet_l, mut iso) = (vec![0.0f64; ns], vec![0.0f64; ns], vec![0.0f64; ns], vec![0.0f64; ns]);
        for i in 0..n_b {
            let s = if a.b_cell[i] >= 0 { a.sa1_grid[a.b_cell[i] as usize] } else { -1 };
            if s >= 0 {
                tot[s as usize] += 1.0;
                if o.b_flood[i] != 0 {
                    hit[s as usize] += 1.0;
                }
                if o.iso[i] != 0 {
                    iso[s as usize] += 1.0;
                }
            }
        }
        for (c, &s) in a.sa1_grid.iter().enumerate() {
            if s >= 0 && a.ocean.get(c).copied().unwrap_or(0) == 0 && depth_at(a.wet, a.depth, a.ocean, c as i32) >= HOME_DEEP {
                wet_l[s as usize] += 1.0;
            }
        }
        for s in 0..ns {
            let share = if tot[s] > 0.0 { hit[s] / tot[s] } else if a.sa1_land[s] != 0.0 { wet_l[s] / a.sa1_land[s] } else { 0.0 };
            o.people += a.sa1_pop[s] * share;
            if tot[s] > 0.0 {
                o.people_isolated += a.sa1_pop[s] * (iso[s] / tot[s]);
            }
        }
    }
    // workers: each SA2's workers spread over its mapped workplaces (or all its buildings if none are mapped)
    if !a.sa2_workers.is_empty() {
        let ns = a.sa2_workers.len();
        let (mut wt, mut wh, mut bt, mut bh) = (vec![0.0f64; ns], vec![0.0f64; ns], vec![0.0f64; ns], vec![0.0f64; ns]);
        for i in 0..n_b {
            let s = if a.b_cell[i] >= 0 { a.sa2_grid[a.b_cell[i] as usize] } else { -1 };
            if s < 0 {
                continue;
            }
            let s = s as usize;
            bt[s] += 1.0;
            if o.b_flood[i] != 0 {
                bh[s] += 1.0;
            }
            if a.is_work[i] != 0 {
                wt[s] += 1.0;
                if o.b_flood[i] != 0 {
                    wh[s] += 1.0;
                }
            }
        }
        for s in 0..ns {
            let w = a.sa2_workers[s];
            o.workers_all += w;
            o.workers += w * if wt[s] >= 3.0 { wh[s] / wt[s] } else if bt[s] > 0.0 { bh[s] / bt[s] } else { 0.0 };
        }
    }
    // roads: length under more than 0.3 m of water (impassable to cars)
    let n_roads = a.road_off.len().saturating_sub(1);
    o.road_cut_km = vec![0.0; n_roads];
    for r in 0..n_roads {
        let (from, to) = (a.road_off[r] as usize, a.road_off[r + 1] as usize);
        let mut cut = 0.0;
        for k in from + 1..to {
            let (la0, lo0, la1, lo1) = (a.road_lat[k - 1], a.road_lon[k - 1], a.road_lat[k], a.road_lon[k]);
            let dx = (lo1 - lo0) * (la0 * std::f64::consts::PI / 180.0).cos();
            let dy = la1 - la0;
            let len = (dx * dx + dy * dy).sqrt() * 111.32;
            o.road_km += len;
            let steps = ((len * 1000.0) / a.cell_m).ceil().max(1.0) as usize;
            let mut wet_steps = 0usize;
            for t in 0..steps {
                let f = (t as f64 + 0.5) / steps as f64;
                let c = a.geo.cell_of(la0 + (la1 - la0) * f, lo0 + (lo1 - lo0) * f);
                if depth_at(a.wet, a.depth, a.ocean, c) >= DEEP {
                    wet_steps += 1;
                }
            }
            cut += len * wet_steps as f64 / steps as f64;
        }
        o.road_cut_km[r] = cut;
    }
    o
}

/// The nearest road node to each building, searched among the nodes in the 3x3 buckets of 0.002 degrees around it
/// with longitude scaled by 0.9 (-1 where there is none). Ties go to the bucket met first, then the lower node.
pub fn building_nodes(node_lat: &[f64], node_lon: &[f64], bx: &[f64], by: &[f64]) -> Vec<i32> {
    const HS: f64 = 0.002;
    let cell = |v: f64| (v / HS).floor() as i64;
    let keys: Vec<(i64, i64)> = (0..node_lat.len()).map(|n| (cell(node_lat[n]), cell(node_lon[n]))).collect();
    if keys.is_empty() {
        return vec![-1; bx.len()];
    }
    // the buckets as a dense grid over the nodes' extent (with a one-bucket margin for the 3x3 look), nodes in
    // ascending order within each: a bucket's list is csr[start[b]..start[b + 1]]
    let (ky0, ky1) = (keys.iter().map(|k| k.0).min().unwrap() - 1, keys.iter().map(|k| k.0).max().unwrap() + 1);
    let (kx0, kx1) = (keys.iter().map(|k| k.1).min().unwrap() - 1, keys.iter().map(|k| k.1).max().unwrap() + 1);
    let (rows, cols) = ((ky1 - ky0 + 1) as usize, (kx1 - kx0 + 1) as usize);
    let slot = |ky: i64, kx: i64| -> Option<usize> {
        if ky < ky0 || ky > ky1 || kx < kx0 || kx > kx1 {
            None
        } else {
            Some((ky - ky0) as usize * cols + (kx - kx0) as usize)
        }
    };
    let mut start = vec![0u32; rows * cols + 1];
    for &(ky, kx) in &keys {
        start[slot(ky, kx).unwrap() + 1] += 1;
    }
    for i in 0..rows * cols {
        start[i + 1] += start[i];
    }
    let mut fill = start.clone();
    let mut csr = vec![0u32; keys.len()];
    for (n, &(ky, kx)) in keys.iter().enumerate() {
        let b = slot(ky, kx).unwrap();
        csr[fill[b] as usize] = n as u32;
        fill[b] += 1;
    }
    (0..bx.len())
        .map(|i| {
            let (ky, kx) = (cell(by[i]), cell(bx[i]));
            let (mut best, mut bd) = (-1i32, f64::INFINITY);
            for dy in -1..=1 {
                for dx in -1..=1 {
                    if let Some(b) = slot(ky + dy, kx + dx) {
                        for &n in &csr[start[b] as usize..start[b + 1] as usize] {
                            let n = n as usize;
                            let dlat = node_lat[n] - by[i];
                            let dlon = (node_lon[n] - bx[i]) * 0.9;
                            let dd = dlat * dlat + dlon * dlon;
                            if dd < bd {
                                bd = dd;
                                best = n as i32;
                            }
                        }
                    }
                }
            }
            best
        })
        .collect()
}
