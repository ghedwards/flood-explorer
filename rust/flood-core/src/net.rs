//! An area's road network, held by the module between calls: built once from the roads (adjacency, edge lengths,
//! each evacuation centre's nearest node), then given the grid, the buildings, the census areas and, per run, the
//! flooded roads. The route to dry land, the flood-impact sweep and the road access timeline all read it, so the
//! page sends the roads once and each later call carries only what changed. A port of the network handling that
//! was in the page's JavaScript (viewer/roadnet.js is the page's side now).

use crate::impact::{building_nodes, prepare_run, Geo, RunRoads};
use crate::util::MinHeap;

/// kilometres along an edge from `u` to `v`, with the longitude scaled at u's latitude
fn km_arc(lat: &[f64], lon: &[f64], u: usize, v: usize) -> f64 {
    let dx = (lon[v] - lon[u]) * 111.32 * (lat[u] * std::f64::consts::PI / 180.0).cos();
    let dy = (lat[v] - lat[u]) * 110.574;
    (dx * dx + dy * dy).sqrt()
}

pub struct NetGrid {
    pub geo: Geo,
    /// five cells per edge (-1 outside the grid)
    pub sample: Vec<i32>,
    pub node_cell: Vec<i32>,
    pub centre_cell: Vec<i32>,
    /// node on the edge of the model
    pub exit: Vec<u8>,
    /// node joined to the edge of the model by the whole network, flooded or not
    pub dry_reach: Vec<u8>,
    /// the distinct cells under each edge's samples: edge e's are edge_cell[edge_cell_off[e]..edge_cell_off[e + 1]]
    pub edge_cell_off: Vec<i32>,
    pub edge_cell: Vec<i32>,
    /// the inverse: the edges under each cell, in edge order
    pub cell_edge_off: Vec<i32>,
    pub cell_edge: Vec<i32>,
}

pub struct NetBuildings {
    pub b_cell: Vec<i32>,
    pub b_node: Vec<i32>,
    pub is_home: Vec<u8>,
    pub is_work: Vec<u8>,
    /// buildings per cell
    pub count: Vec<i32>,
    /// the buildings that have each node as their nearest, ascending
    pub node_off: Vec<i32>,
    pub node_list: Vec<i32>,
}

/// The census areas painted onto the grid, how much of each lies inside the model, and the roads' geometry.
#[derive(Default)]
pub struct NetCensus {
    pub sa1_grid: Vec<i32>,
    pub sa2_grid: Vec<i32>,
    /// km2 of each SA1 / SA2 inside the model, and each SA1's land cells (the sea left out)
    pub sa1_inside: Vec<f64>,
    pub sa1_land: Vec<f64>,
    pub sa2_inside: Vec<f64>,
    pub road_lat: Vec<f64>,
    pub road_lon: Vec<f64>,
    pub road_off: Vec<i32>,
}

pub struct NetRun {
    pub wet: Vec<u8>,
    pub depth: Vec<f32>,
    pub ocean: Vec<u8>,
    pub roads: RunRoads,
}

pub struct Net {
    pub lat: Vec<f64>,
    pub lon: Vec<f64>,
    pub edge_u: Vec<i32>,
    pub edge_v: Vec<i32>,
    pub edge_road: Vec<i32>,
    pub off: Vec<i32>,
    pub to: Vec<i32>,
    pub edge: Vec<i32>,
    pub road: Vec<i32>,
    pub len: Vec<f64>,
    pub centre_lat: Vec<f64>,
    pub centre_lon: Vec<f64>,
    pub centre_node: Vec<i32>,
    pub grid: Option<NetGrid>,
    pub buildings: Option<NetBuildings>,
    pub census: NetCensus,
    pub run: Option<NetRun>,
}

/// The nearest node to a point under dlat^2 + (kx * dlon)^2; the lowest index wins a tie. (-1, inf) if none.
fn nearest(lat: &[f64], lon: &[f64], at_lat: f64, at_lon: f64, kx: f64) -> (i32, f64) {
    let (mut best, mut bd) = (-1i32, f64::INFINITY);
    for n in 0..lat.len() {
        let dd = (lat[n] - at_lat).powi(2) + ((lon[n] - at_lon) * kx).powi(2);
        if dd < bd {
            bd = dd;
            best = n as i32;
        }
    }
    (best, bd)
}

impl Net {
    pub fn new(lat: Vec<f64>, lon: Vec<f64>, edge_u: Vec<i32>, edge_v: Vec<i32>, edge_road: Vec<i32>, centre_lat: Vec<f64>, centre_lon: Vec<f64>) -> Net {
        let (n_nodes, n_edges) = (lat.len(), edge_u.len());
        let mut off = vec![0i32; n_nodes + 1];
        for k in 0..n_edges {
            off[edge_u[k] as usize + 1] += 1;
            off[edge_v[k] as usize + 1] += 1;
        }
        for i in 0..n_nodes {
            off[i + 1] += off[i];
        }
        let (mut to, mut edge, mut road, mut len) = (vec![0i32; 2 * n_edges], vec![0i32; 2 * n_edges], vec![0i32; 2 * n_edges], vec![0f64; 2 * n_edges]);
        let mut at: Vec<i32> = off[..n_nodes].to_vec();
        for k in 0..n_edges {
            // edge order, u to v then v to u
            let (u, v) = (edge_u[k] as usize, edge_v[k] as usize);
            let p = at[u] as usize;
            at[u] += 1;
            to[p] = v as i32;
            edge[p] = k as i32;
            road[p] = edge_road[k];
            len[p] = km_arc(&lat, &lon, u, v);
            let p = at[v] as usize;
            at[v] += 1;
            to[p] = u as i32;
            edge[p] = k as i32;
            road[p] = edge_road[k];
            len[p] = km_arc(&lat, &lon, v, u);
        }
        let centre_node = (0..centre_lat.len()).map(|i| nearest(&lat, &lon, centre_lat[i], centre_lon[i], 1.0).0).collect();
        Net { lat, lon, edge_u, edge_v, edge_road, off, to, edge, road, len, centre_lat, centre_lon, centre_node, grid: None, buildings: None, census: NetCensus::default(), run: None }
    }

    /// The census areas: `n1` SA1s and `n2` SA2s painted on the grid (-1 outside), how much of each lies in the model,
    /// and the roads' points (road r's are road_off[r]..road_off[r + 1]).
    #[allow(clippy::too_many_arguments)]
    pub fn set_census(&mut self, sa1_grid: Vec<i32>, n1: usize, sa2_grid: Vec<i32>, n2: usize, ocean: &[u8], cell_km2: f64, road: (Vec<f64>, Vec<f64>, Vec<i32>)) {
        let (mut sa1_inside, mut sa1_land, mut sa2_inside) = (vec![0.0; n1], vec![0.0; n1], vec![0.0; n2]);
        for (c, &s) in sa1_grid.iter().enumerate() {
            if s >= 0 {
                sa1_inside[s as usize] += cell_km2;
                if ocean.get(c).copied().unwrap_or(0) == 0 {
                    sa1_land[s as usize] += 1.0;
                }
            }
        }
        for &s in &sa2_grid {
            if s >= 0 {
                sa2_inside[s as usize] += cell_km2;
            }
        }
        self.census = NetCensus { sa1_grid, sa2_grid, sa1_inside, sa1_land, sa2_inside, road_lat: road.0, road_lon: road.1, road_off: road.2 };
    }

    pub fn n_nodes(&self) -> usize {
        self.lat.len()
    }

    pub fn n_edges(&self) -> usize {
        self.edge_u.len()
    }

    /// What depends on the grid: the cells under each edge, node and centre, and which nodes are on the model's edge.
    pub fn set_grid(&mut self, geo: Geo) {
        let (n_nodes, n_edges) = (self.n_nodes(), self.n_edges());
        let mut sample = vec![-1i32; 5 * n_edges];
        for k in 0..n_edges {
            let (u, v) = (self.edge_u[k] as usize, self.edge_v[k] as usize);
            for t in 0..5 {
                let f = t as f64 / 4.0;
                sample[5 * k + t] = geo.cell_of(self.lat[u] + (self.lat[v] - self.lat[u]) * f, self.lon[u] + (self.lon[v] - self.lon[u]) * f);
            }
        }
        let (mx, my) = (((geo.east - geo.west) / geo.w as f64) * 3.0, ((geo.north - geo.south) / geo.h as f64) * 3.0);
        let node_cell: Vec<i32> = (0..n_nodes).map(|n| geo.cell_of(self.lat[n], self.lon[n])).collect();
        let exit: Vec<u8> = (0..n_nodes)
            .map(|n| (self.lat[n] < geo.south + my || self.lat[n] > geo.north - my || self.lon[n] < geo.west + mx || self.lon[n] > geo.east - mx) as u8)
            .collect();
        let centre_cell = (0..self.centre_lat.len()).map(|i| geo.cell_of(self.centre_lat[i], self.centre_lon[i])).collect();
        // joined to the edge by the whole network
        let mut dry_reach = vec![0u8; n_nodes];
        let mut q: Vec<usize> = Vec::with_capacity(n_nodes);
        for n in 0..n_nodes {
            if exit[n] != 0 {
                dry_reach[n] = 1;
                q.push(n);
            }
        }
        let mut h = 0;
        while h < q.len() {
            let u = q[h];
            h += 1;
            for p in self.off[u] as usize..self.off[u + 1] as usize {
                let m = self.to[p] as usize;
                if dry_reach[m] == 0 {
                    dry_reach[m] = 1;
                    q.push(m);
                }
            }
        }
        // the distinct cells under each edge, and the edges under each cell
        let n_cells = geo.w * geo.h;
        let (mut edge_cell_off, mut edge_cell) = (vec![0i32; n_edges + 1], Vec::<i32>::new());
        for e in 0..n_edges {
            let from = edge_cell.len();
            for t in 0..5 {
                let c = sample[5 * e + t];
                if c >= 0 && !edge_cell[from..].contains(&c) {
                    edge_cell.push(c);
                }
            }
            edge_cell_off[e + 1] = edge_cell.len() as i32;
        }
        let mut cell_edge_off = vec![0i32; n_cells + 1];
        for &c in &edge_cell {
            cell_edge_off[c as usize + 1] += 1;
        }
        for c in 0..n_cells {
            cell_edge_off[c + 1] += cell_edge_off[c];
        }
        let mut fill: Vec<i32> = cell_edge_off[..n_cells].to_vec();
        let mut cell_edge = vec![0i32; edge_cell.len()];
        for e in 0..n_edges {
            for &c in &edge_cell[edge_cell_off[e] as usize..edge_cell_off[e + 1] as usize] {
                let c = c as usize;
                cell_edge[fill[c] as usize] = e as i32;
                fill[c] += 1;
            }
        }
        self.grid = Some(NetGrid { geo, sample, node_cell, centre_cell, exit, dry_reach, edge_cell_off, edge_cell, cell_edge_off, cell_edge });
        self.buildings = None;
        self.run = None;
    }

    /// The buildings: each one's cell, its nearest road node, buildings per cell, and the buildings by node.
    pub fn set_buildings(&mut self, bx: &[f64], by: &[f64], is_home: Vec<u8>, is_work: Vec<u8>) -> Result<(), String> {
        let g = self.grid.as_ref().ok_or("the grid is not set")?;
        let n_b = bx.len();
        let b_cell: Vec<i32> = (0..n_b).map(|i| g.geo.cell_of(by[i], bx[i])).collect();
        let b_node = building_nodes(&self.lat, &self.lon, bx, by);
        let mut count = vec![0i32; g.geo.w * g.geo.h];
        for &c in &b_cell {
            if c >= 0 {
                count[c as usize] += 1;
            }
        }
        let n_nodes = self.n_nodes();
        let mut node_off = vec![0i32; n_nodes + 1];
        for &b in &b_node {
            if b >= 0 {
                node_off[b as usize + 1] += 1;
            }
        }
        for n in 0..n_nodes {
            node_off[n + 1] += node_off[n];
        }
        let mut fill: Vec<i32> = node_off[..n_nodes].to_vec();
        let mut node_list = vec![0i32; node_off[n_nodes] as usize];
        for (i, &b) in b_node.iter().enumerate() {
            if b >= 0 {
                node_list[fill[b as usize] as usize] = i as i32;
                fill[b as usize] += 1;
            }
        }
        self.buildings = Some(NetBuildings { b_cell, b_node, is_home, is_work, count, node_off, node_list });
        Ok(())
    }

    /// A run's water, and with it which roads, nodes and centres are flooded.
    pub fn set_run(&mut self, wet: Vec<u8>, depth: Vec<f32>, ocean: Vec<u8>) -> Result<(), String> {
        let g = self.grid.as_ref().ok_or("the grid is not set")?;
        let roads = prepare_run(&g.sample, &g.node_cell, &g.centre_cell, &wet, &depth, &ocean);
        self.run = Some(NetRun { wet, depth, ocean, roads });
        Ok(())
    }

    /// The shortest dry route from a spot to the edge of the model and to the nearest dry evacuation centre.
    pub fn route(&self, at_lat: f64, at_lon: f64) -> Result<Route, String> {
        let g = self.grid.as_ref().ok_or("the grid is not set")?;
        let run = self.run.as_ref().ok_or("no run is set")?;
        let (closed, wet, flooded) = (&run.roads.closed, &run.roads.wet, &run.roads.flooded);
        let (start, dd) = nearest(&self.lat, &self.lon, at_lat, at_lon, (at_lat * std::f64::consts::PI / 180.0).cos());
        let start_km = dd.sqrt() * 111.0;
        let mut r = Route { start_km, centres: self.centre_node.len() as i32, centres_flooded: flooded.iter().filter(|&&f| f != 0).count() as i32, ..Default::default() };
        if start < 0 || start_km > 0.5 {
            r.none = true;
            return Ok(r);
        }
        let n_nodes = self.n_nodes();
        // the centre at each node (a later centre at the same node replaces an earlier one), if dry
        let mut centre_at = vec![-1i32; n_nodes];
        let mut any_centre = false;
        for (i, &n) in self.centre_node.iter().enumerate() {
            if flooded[i] == 0 && n >= 0 {
                centre_at[n as usize] = i as i32;
                any_centre = true;
            }
        }
        let (mut dist, mut prev, mut via) = (vec![f64::INFINITY; n_nodes], vec![-1i32; n_nodes], vec![-1i32; n_nodes]);
        let mut heap = MinHeap::new(2 * self.n_edges() + 4);
        let start = start as usize;
        if wet[start] == 0 {
            dist[start] = 0.0;
            heap.push(0.0, start as i32);
        }
        let (mut exit_node, mut centre_node) = (-1i32, -1i32);
        while heap.n > 0 {
            let u = heap.pop() as usize;
            if exit_node < 0 && g.exit[u] != 0 {
                exit_node = u as i32;
            }
            if centre_node < 0 && centre_at[u] >= 0 {
                centre_node = u as i32;
            }
            if exit_node >= 0 && (centre_node >= 0 || !any_centre) {
                break;
            }
            for p in self.off[u] as usize..self.off[u + 1] as usize {
                if closed[self.edge[p] as usize] != 0 {
                    continue;
                }
                let v = self.to[p] as usize;
                if wet[v] != 0 {
                    continue;
                }
                let nd = dist[u] + self.len[p];
                if nd < dist[v] {
                    dist[v] = nd;
                    prev[v] = u as i32;
                    via[v] = self.road[p];
                    heap.push(nd, v as i32);
                }
            }
        }
        let path = |t: i32| -> Option<Path> {
            if t < 0 {
                return None;
            }
            let (mut nodes, mut vias) = (Vec::new(), Vec::new());
            let mut n = t;
            while n >= 0 {
                nodes.push(n);
                vias.push(via[n as usize]);
                n = prev[n as usize];
            }
            Some(Path { km: dist[t as usize], nodes, vias })
        };
        r.to_exit = path(exit_node);
        r.to_centre = path(centre_node);
        r.centre = if centre_node >= 0 { centre_at[centre_node as usize] } else { -1 };
        Ok(r)
    }
}

/// A route, from its end back to the start: the nodes, and the road each was reached by.
pub struct Path {
    pub km: f64,
    pub nodes: Vec<i32>,
    pub vias: Vec<i32>,
}

#[derive(Default)]
pub struct Route {
    /// the spot is not near a road
    pub none: bool,
    pub start_km: f64,
    pub to_exit: Option<Path>,
    pub to_centre: Option<Path>,
    /// which evacuation centre the second route ends at
    pub centre: i32,
    pub centres: i32,
    pub centres_flooded: i32,
}
