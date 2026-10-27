//! The water surface of a run as a triangle mesh for the 3D view: a port of `buildGrid` / `waterMeshAt` in
//! viewer/terrain3d.js (kept in tests/water-mesh-reference.js as the reference it is checked against). The
//! analysis grid is sampled every `skip` cells; a quad is emitted where all four sampled corners have a vertex.

/// Depth bands (lower bound, colour): the 2D legend's, and the 3D view's, which are the same shades.
const BANDS: [(f64, [u8; 3]); 5] = [
    (0.0, [0x3f, 0x9a, 0xe0]),
    (0.5, [0x2b, 0x7f, 0xd0]),
    (1.0, [0x1f, 0x67, 0xbb]),
    (2.0, [0x17, 0x50, 0x9c]),
    (4.0, [0x0c, 0x34, 0x70]),
];

fn band_colour(d: f64) -> [u8; 3] {
    let mut col = BANDS[0].1;
    for (lo, c) in BANDS {
        if d >= lo {
            col = c;
        }
    }
    col
}

/// What the mesh reads of a run: the water surface, its depth and where it is wet. A timeline frame is
/// quantised depth (a byte per cell, scaled to `max_d`) over the ground height, decoded only where sampled.
pub enum Water<'a> {
    Run { surface: &'a [f64], depth: &'a [f32], wet: &'a [u8] },
    Frame { dem: &'a [f32], frame: &'a [u8], max_d: f64 },
}

pub struct MeshIn<'a> {
    pub w: usize,
    pub h: usize,
    pub cell: f64,
    pub skip: usize,
    pub lift: f64,
    /// soft shoreline: a ring of transparent vertices around the wet cells, so the edge meets the ground smoothly
    pub soft: bool,
    /// scene coordinates of each column and row (empty: x * cell, y * cell)
    pub col_x: &'a [f64],
    pub row_z: &'a [f64],
    pub water: Water<'a>,
}

#[derive(Default)]
pub struct Mesh {
    pub positions: Vec<f32>,
    pub colors: Vec<f32>,
    pub uvs: Vec<f32>,
    pub indices: Vec<u32>,
}

impl Water<'_> {
    fn surface(&self, i: usize) -> f64 {
        match self {
            Water::Run { surface, .. } => surface[i],
            Water::Frame { dem, .. } => dem[i] as f64 + self.depth(i),
        }
    }
    fn depth(&self, i: usize) -> f64 {
        match self {
            Water::Run { depth, .. } => depth[i] as f64,
            // the Float32 value the page's frame decode stores
            Water::Frame { frame, max_d, .. } => ((frame[i] as f64 / 255.0) * max_d) as f32 as f64,
        }
    }
    fn is_wet(&self, i: usize) -> bool {
        let wet = match self {
            Water::Run { wet, .. } => wet[i] == 1,
            Water::Frame { frame, .. } => frame[i] > 0,
        };
        wet && !self.surface(i).is_nan()
    }
}

/// Per grid slot (cells `skip` apart): 0 not yet looked at, 1 no vertex, 2 vertex; and what the vertex is.
struct Soft {
    state: Vec<u8>,
    level: Vec<f64>,
    alpha: Vec<f64>,
    colour: Vec<[u8; 3]>,
}

impl Soft {
    /// The vertex at cell i, if any: wet cells, and cells with a wet neighbour (at the neighbours' mean
    /// level, fully transparent).
    fn probe(&mut self, water: &Water, i: usize, w: usize, h: usize, skip: usize, cols: usize) -> Option<usize> {
        let (x, y) = (i % w, i / w);
        let slot = (y / skip) * cols + x / skip;
        match self.state[slot] {
            1 => return None,
            2 => return Some(slot),
            _ => {}
        }
        if water.is_wet(i) {
            let d = water.depth(i);
            self.level[slot] = water.surface(i);
            self.colour[slot] = band_colour(d);
            self.alpha[slot] = (0.3 + 0.32 * d).min(0.88);
            self.state[slot] = 2;
            return Some(slot);
        }
        let (mut n, mut sum, mut col) = (0usize, 0.0f64, None);
        let skip_i = skip as i64;
        let mut dy = -skip_i;
        while dy <= skip_i {
            let mut dx = -skip_i;
            while dx <= skip_i {
                let (nx, ny) = (x as i64 + dx, y as i64 + dy);
                if (dx != 0 || dy != 0) && nx >= 0 && ny >= 0 && nx < w as i64 && ny < h as i64 {
                    let j = ny as usize * w + nx as usize;
                    if water.is_wet(j) {
                        n += 1;
                        sum += water.surface(j);
                        if col.is_none() {
                            col = Some(band_colour(water.depth(j)));
                        }
                    }
                }
                dx += skip_i;
            }
            dy += skip_i;
        }
        if n == 0 {
            self.state[slot] = 1;
            return None;
        }
        self.level[slot] = sum / n as f64;
        self.colour[slot] = col.unwrap_or(BANDS[0].1);
        self.alpha[slot] = 0.0;
        self.state[slot] = 2;
        Some(slot)
    }
}

/// None when no quad survives.
pub fn water_mesh(m: &MeshIn) -> Option<Mesh> {
    let (w, h, skip) = (m.w, m.h, m.skip.max(1));
    let cols = (w - 1) / skip + 1;
    let rows = (h - 1) / skip + 1;
    let water = &m.water;
    let mut soft = Soft {
        state: vec![0u8; cols * rows],
        level: vec![0.0f64; cols * rows],
        alpha: vec![0.0f64; cols * rows],
        colour: vec![[0u8; 3]; cols * rows],
    };
    let mut out = Mesh::default();
    let mut vertex = vec![-1i32; cols * rows];
    let (w_m, h_m) = ((w - 1) as f64 * m.cell, (h - 1) as f64 * m.cell);
    for gy in 0..rows {
        for gx in 0..cols {
            let (x, y) = (gx * skip, gy * skip);
            let i = y * w + x;
            // the hard-edged mesh keeps wet cells only; the soft one also the ring around them
            let (level, colour, alpha) = if m.soft {
                match soft.probe(water, i, w, h, skip, cols) {
                    Some(s) => (soft.level[s], soft.colour[s], soft.alpha[s]),
                    None => continue,
                }
            } else if water.is_wet(i) {
                let d = water.depth(i);
                (water.surface(i), band_colour(d), (0.3 + d / 0.45).min(1.0))
            } else {
                continue;
            };
            vertex[gy * cols + gx] = (out.positions.len() / 3) as i32;
            let px = if m.col_x.is_empty() { x as f64 * m.cell } else { m.col_x[x] };
            let pz = if m.row_z.is_empty() { y as f64 * m.cell } else { m.row_z[y] };
            out.positions.extend_from_slice(&[px as f32, (level + m.lift) as f32, pz as f32]);
            out.uvs.extend_from_slice(&[(px / w_m) as f32, (1.0 - pz / h_m) as f32]);
            out.colors.extend_from_slice(&[(colour[0] as f64 / 255.0) as f32, (colour[1] as f64 / 255.0) as f32, (colour[2] as f64 / 255.0) as f32, alpha as f32]);
        }
    }
    if out.positions.is_empty() {
        return None;
    }
    for gy in 0..rows.saturating_sub(1) {
        for gx in 0..cols.saturating_sub(1) {
            let (a0, a1) = (vertex[gy * cols + gx], vertex[gy * cols + gx + 1]);
            let (b0, b1) = (vertex[(gy + 1) * cols + gx], vertex[(gy + 1) * cols + gx + 1]);
            if a0 < 0 || a1 < 0 || b0 < 0 || b1 < 0 {
                continue;
            }
            out.indices.extend_from_slice(&[a0 as u32, b0 as u32, a1 as u32, a1 as u32, b0 as u32, b1 as u32]);
        }
    }
    if out.indices.is_empty() {
        return None;
    }
    Some(out)
}
