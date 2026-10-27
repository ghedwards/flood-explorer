//! Road access over time: a port of the step loop in `timelineAccess` (viewer/access.js), which it matches
//! exactly (the JavaScript stays as the reference and the fallback). At each step: the roads under deep water,
//! how many buildings are flooded, and how many are cut off, meaning the nearest road node no longer reaches
//! the edge of the model by dry roads though the whole network would.
//!
//! The caller prepares the network and the buildings once (CSR adjacency, edges by cell, buildings by node);
//! the cell bits are one `wps`-word row per step, a set bit meaning wet (or deep) at that cell.

pub struct AccessIn<'a> {
    pub steps: usize,
    pub wps: usize,
    pub n_cells: usize,
    pub n_names: usize,
    // road nodes: CSR adjacency, the cell under each, edge of the model, joined to it when nothing is flooded
    pub off: &'a [i32],
    pub to: &'a [i32],
    pub edge: &'a [i32],
    pub node_cell: &'a [i32],
    pub exit: &'a [u8],
    pub dry_reach: &'a [u8],
    // edges by cell, and each edge's road-name id (-1 for none)
    pub ce_off: &'a [i32],
    pub ce_list: &'a [i32],
    pub edge_name: &'a [i32],
    // buildings: cell, buildings per cell, and the buildings that have each node as nearest
    pub b_cell: &'a [i32],
    pub b_count: &'a [i32],
    pub node_off: &'a [i32],
    pub node_list: &'a [i32],
    pub wet: &'a [u32],
    pub deep: &'a [u32],
}

#[derive(Default)]
pub struct AccessOut {
    pub closed_count: Vec<i32>,
    pub flood_count: Vec<i32>,
    pub iso_count: Vec<i32>,
    pub iso_steps: Vec<i16>,
    pub first_iso: Vec<i16>,
    pub longest: i32,
    /// per step, how many road names closed, and then their ids in the order the edge scan first met them
    pub name_counts: Vec<i32>,
    pub name_ids: Vec<i32>,
}

fn bit(bits: &[u32], base: usize, c: i32) -> bool {
    c >= 0 && bits[base + (c as usize >> 5)] & (1u32 << (c as usize & 31)) != 0
}

#[allow(clippy::needless_range_loop)]
pub fn access_over_time(a: &AccessIn) -> AccessOut {
    let (n_nodes, n_edges, n_b) = (a.node_cell.len(), a.edge_name.len(), a.b_cell.len());
    let mut o = AccessOut {
        closed_count: vec![0; a.steps],
        flood_count: vec![0; a.steps],
        iso_count: vec![0; a.steps],
        iso_steps: vec![0; n_b],
        first_iso: vec![-1; n_b],
        name_counts: vec![0; a.steps],
        ..Default::default()
    };
    let mut edge_stamp = vec![0i32; n_edges];
    let mut name_stamp = vec![0i32; a.n_names];
    let mut name_first = vec![0i32; a.n_names];
    let mut iso_run = vec![0i16; n_b];
    let mut now_iso = vec![0i32; n_b];
    let mut reach_buf = vec![0u8; n_nodes];
    let mut q = vec![0i32; n_nodes];
    let mut active: Vec<i32> = Vec::new();
    for k in 0..a.steps {
        let base = k * a.wps;
        let stamp = k as i32 + 1;
        // edges under deep water, from the deep cells outwards
        let (mut closed, mut any_deep) = (0i32, false);
        let mut closed_names: Vec<i32> = Vec::new();
        for w in 0..a.wps {
            let mut bits = a.deep[base + w];
            if bits == 0 {
                continue;
            }
            any_deep = true;
            while bits != 0 {
                let cell = (w << 5) + bits.trailing_zeros() as usize;
                bits &= bits - 1;
                if cell >= a.n_cells {
                    continue;
                }
                for p in a.ce_off[cell] as usize..a.ce_off[cell + 1] as usize {
                    let e = a.ce_list[p] as usize;
                    if edge_stamp[e] == stamp {
                        continue;
                    }
                    edge_stamp[e] = stamp;
                    closed += 1;
                    let nm = a.edge_name[e];
                    if nm < 0 {
                        continue;
                    }
                    let nm = nm as usize;
                    if name_stamp[nm] != stamp {
                        name_stamp[nm] = stamp;
                        name_first[nm] = e as i32;
                        closed_names.push(nm as i32);
                    } else if (e as i32) < name_first[nm] {
                        name_first[nm] = e as i32;
                    }
                }
            }
        }
        o.closed_count[k] = closed;
        closed_names.sort_by_key(|&nm| name_first[nm as usize]);
        o.name_counts[k] = closed_names.len() as i32;
        o.name_ids.extend_from_slice(&closed_names);
        // nodes still joined to the edge of the model; with nothing deep, every node the whole network joins
        let reach: &[u8] = if any_deep {
            reach_buf.fill(0);
            let mut qt = 0usize;
            for n in 0..n_nodes {
                if a.exit[n] != 0 && !bit(a.deep, base, a.node_cell[n]) {
                    reach_buf[n] = 1;
                    q[qt] = n as i32;
                    qt += 1;
                }
            }
            let mut h = 0;
            while h < qt {
                let u = q[h] as usize;
                h += 1;
                for p in a.off[u] as usize..a.off[u + 1] as usize {
                    let m = a.to[p] as usize;
                    if reach_buf[m] != 0 || edge_stamp[a.edge[p] as usize] == stamp || bit(a.deep, base, a.node_cell[m]) {
                        continue;
                    }
                    reach_buf[m] = 1;
                    q[qt] = m as i32;
                    qt += 1;
                }
            }
            &reach_buf
        } else {
            a.dry_reach
        };
        // flooded buildings: wet cells, weighted by the buildings in each
        let mut flood = 0i32;
        for w in 0..a.wps {
            let mut bits = a.wet[base + w];
            while bits != 0 {
                let cell = (w << 5) + bits.trailing_zeros() as usize;
                bits &= bits - 1;
                if cell < a.n_cells {
                    flood += a.b_count[cell];
                }
            }
        }
        o.flood_count[k] = flood;
        // cut off: dry buildings whose nearest road node the network joins to the edge but the flood has cut from it
        let mut now: Vec<i32> = Vec::new();
        for n in 0..n_nodes {
            if a.dry_reach[n] == 0 || reach[n] != 0 {
                continue;
            }
            for p in a.node_off[n] as usize..a.node_off[n + 1] as usize {
                let i = a.node_list[p] as usize;
                if bit(a.wet, base, a.b_cell[i]) {
                    continue;
                }
                now.push(i as i32);
                now_iso[i] = stamp;
            }
        }
        for &i in &active {
            if now_iso[i as usize] != stamp {
                iso_run[i as usize] = 0;
            }
        }
        for &i in &now {
            let i = i as usize;
            o.iso_steps[i] = o.iso_steps[i].wrapping_add(1);
            iso_run[i] = iso_run[i].wrapping_add(1);
            if iso_run[i] as i32 > o.longest {
                o.longest = iso_run[i] as i32;
            }
            if o.first_iso[i] < 0 {
                o.first_iso[i] = k as i16;
            }
        }
        o.iso_count[k] = now.len() as i32;
        active = now;
    }
    o
}
