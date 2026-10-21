//! Terrain grids: the sample terrain, file readers, resampling, levees.

use crate::util::*;

/// A terrain grid. `valid` (1 = data) and `inflow` (extra upstream cells
/// entering at a cell) are optional; `d8` holds Whitebox D8 pointer codes
/// from the pipeline when flow directions come precomputed.
#[derive(Clone, Debug, Default)]
pub struct Grid {
    pub w: usize,
    pub h: usize,
    pub cell: f64,
    pub dem: Vec<f32>,
    pub valid: Option<Vec<u8>>,
    pub inflow: Option<Vec<f32>>,
    pub d8: Option<Vec<i16>>,
}

fn rasterise_polyline(pts: &[(f64, f64)], w: usize, h: usize, out: &mut [u8]) {
    for k in 0..pts.len().saturating_sub(1) {
        let (x0, y0) = pts[k];
        let (x1, y1) = pts[k + 1];
        let n = ((x1 - x0).hypot(y1 - y0) * 2.0).ceil() + 1.0;
        let mut s = 0.0;
        while s <= n {
            let x = js_round(x0 + (x1 - x0) * s / n);
            let y = js_round(y0 + (y1 - y0) * s / n);
            if x >= 0.0 && y >= 0.0 && (x as usize) < w && (y as usize) < h {
                out[y as usize * w + x as usize] = 1;
            }
            s += 1.0;
        }
    }
}

/// Illustrative lower-river terrain (a meandering river into a bay, low
/// flats, hills and two tributary creeks). Not real elevation; used by the
/// tests and when no data is loaded.
pub fn synthetic_terrain(w: usize, h: usize, cell: f64, seed: u32) -> Grid {
    let fbm = ValueNoise::new(seed);
    let fbm2 = ValueNoise::new(seed + 11);
    let coast_x = js_round(w as f64 * 0.84);
    let (wf, hf) = (w as f64, h as f64);
    let pi = std::f64::consts::PI;

    let mut river = Vec::new();
    let mut x = -2.0;
    while x <= coast_x + 6.0 {
        let t = x / coast_x;
        let y = hf * 0.5
            + 46.0 * (t * pi * 3.1 + 0.4).sin()
            + 22.0 * (t * pi * 7.3 + 1.1).sin() * (1.0 - t * 0.6)
            + 10.0 * (fbm2.fbm(x / 40.0, 3.3, 3) - 0.5);
        river.push((x, y));
        x += 1.0;
    }
    // river[i] is at x = i - 2
    let ja = river[js_round(coast_x * 0.35) as usize];
    let jb = river[js_round(coast_x * 0.62) as usize];
    let (mut creek_a, mut creek_b) = (Vec::new(), Vec::new());
    let mut s = 0.0;
    while s <= 1.0001 {
        creek_a.push((ja.0 - 30.0 * s + 8.0 * (s * 9.0).sin(), ja.1 - (ja.1 - 8.0) * s));
        creek_b.push((jb.0 + 18.0 * s + 7.0 * (s * 11.0).sin(), jb.1 + (hf - 8.0 - jb.1) * s));
        s += 0.02;
    }
    let n = w * h;
    let (mut r_mask, mut c_mask) = (vec![0u8; n], vec![0u8; n]);
    rasterise_polyline(&river, w, h, &mut r_mask);
    rasterise_polyline(&creek_a, w, h, &mut c_mask);
    rasterise_polyline(&creek_b, w, h, &mut c_mask);
    let d_r = chamfer_distance(&r_mask, w, h);
    let d_c = chamfer_distance(&c_mask, w, h);

    let mut dem = vec![0f32; n];
    for yi in 0..h {
        for xi in 0..w {
            let i = yi * w + xi;
            let (x, y) = (xi as f64, yi as f64);
            let coast = coast_x + 10.0 * (fbm.fbm(3.1, y / 30.0, 3) - 0.5) * 2.0;
            let t = jmin(1.0, jmax(0.0, x / coast_x));
            let base = 1.2 + 9.5 * (1.0 - t).powf(1.6);
            let dm = d_r[i] * cell;
            let plain_w = 900.0 + 1400.0 * fbm.fbm(x / 70.0, y / 70.0, 3) * (0.6 + 0.6 * t);
            let hills = smoothstep(plain_w, plain_w + 1600.0, dm) * (14.0 + 85.0 * fbm.fbm(x / 55.0, y / 55.0, 5));
            let mut z = base + 1.6 * (dm / 1000.0) + hills + 1.2 * (fbm.fbm(x / 9.0, y / 9.0, 3) - 0.5);
            let dcm = d_c[i] * cell;
            z -= (6.0 + hills * 0.6) * (-dcm / 260.0).exp();
            if dcm < 60.0 {
                z = jmin(z, base + 1.0 + 0.004 * dm - 1.5);
            }
            if dm < 160.0 {
                let f = 1.0 - dm / 160.0;
                z = jmin(z, base - 6.2 * f * f + 0.4);
            }
            if x > coast {
                z = jmin(z, -1.5 - (x - coast) * 0.06);
            } else if x > coast - 14.0 {
                z = jmin(z, 0.4 + (coast - x) * 0.09 + (hills * 0.1));
            }
            dem[i] = z as f32;
        }
    }
    let (mut entry, mut best) = (0usize, f64::INFINITY);
    for yi in 0..h {
        let v = dem[yi * w + 4] as f64;
        if v < best {
            best = v;
            entry = yi * w + 4;
        }
    }
    let mut inflow = vec![0f32; n];
    inflow[entry] = 1e6;
    let _ = wf;
    Grid { w, h, cell, dem, valid: None, inflow: Some(inflow), d8: None }
}

/// The default sample terrain (420 × 300 cells of 50 m, seed 1974).
pub fn sample_terrain() -> Grid {
    synthetic_terrain(420, 300, 50.0, 1974)
}

/// One levee for `burn_defences`.
#[derive(Clone, Debug, Default)]
pub struct Levee {
    pub cells: Vec<i64>,
    /// metres above the ground beside it; None: crest from the terrain
    pub height: Option<f64>,
    pub failed: bool,
    pub breaches: Vec<i64>,
    pub breach_width: Option<f64>,
}

/// Burn levees into a terrain grid (see the JavaScript model): intact levees
/// raise their cells to the crest; failed levees and breaches lower them to
/// the median ground beside them. Returns a new dem.
pub fn burn_defences(g: &Grid, levees: &[Levee]) -> Vec<f32> {
    let (w, h) = (g.w as i64, g.h as i64);
    let n = (w * h) as usize;
    let dem = &g.dem;
    let mut out = dem.clone();
    let mut is_lev = vec![0u8; n];
    for l in levees {
        for &c in &l.cells {
            if c >= 0 && (c as usize) < n {
                is_lev[c as usize] = 1;
            }
        }
    }
    let around = |c: i64, r: i64, f: &mut dyn FnMut(usize)| {
        let (cx, cy) = (c % w, c / w);
        for dy in -r..=r {
            for dx in -r..=r {
                let (x, y) = (cx + dx, cy + dy);
                if x >= 0 && y >= 0 && x < w && y < h {
                    f((y * w + x) as usize);
                }
            }
        }
    };
    let ground = |c: i64| -> f64 {
        let mut v: Vec<f32> = Vec::new();
        around(c, 3, &mut |nn| {
            if is_lev[nn] == 0 {
                v.push(dem[nn]);
            }
        });
        if v.is_empty() {
            return dem[c as usize] as f64;
        }
        v.sort_by(|x, y| x.partial_cmp(y).unwrap_or(std::cmp::Ordering::Equal));
        v[v.len() / 2] as f64
    };
    let crest_of = |c: i64| -> f64 {
        let mut m = f64::NEG_INFINITY;
        around(c, 1, &mut |nn| {
            if (dem[nn] as f64) > m {
                m = dem[nn] as f64;
            }
        });
        m
    };
    for l in levees {
        let mut breach = std::collections::HashSet::new();
        let br = jmax(1.0, js_round(l.breach_width.unwrap_or(60.0) / 2.0 / g.cell)) as i64;
        for &b in &l.breaches {
            around(b, br, &mut |nn| {
                breach.insert(nn);
            });
        }
        for &c in &l.cells {
            if c < 0 || c as usize >= n {
                continue;
            }
            let cu = c as usize;
            if l.failed || breach.contains(&cu) {
                let gr = ground(c);
                let mut lower = Vec::new();
                around(c, 1, &mut |nn| {
                    if is_lev[nn] != 0 || nn == cu {
                        lower.push(nn);
                    }
                });
                for nn in lower {
                    out[nn] = jmin(out[nn] as f64, gr) as f32;
                }
                out[cu] = jmin(out[cu] as f64, gr) as f32;
            } else {
                let crest = match l.height {
                    Some(hgt) => ground(c) + hgt,
                    None => crest_of(c),
                };
                if crest > out[cu] as f64 {
                    out[cu] = crest as f32;
                }
            }
        }
    }
    out
}

/// Grid cells along a polyline of [x, y] grid coordinates (8-connected),
/// each once, in order.
pub fn line_cells(pts: &[(f64, f64)], w: usize, h: usize) -> Vec<i32> {
    let mut cells = Vec::new();
    let mut seen = std::collections::HashSet::new();
    for k in 1..pts.len() {
        let (mut x0, mut y0) = (js_round(pts[k - 1].0) as i64, js_round(pts[k - 1].1) as i64);
        let (x1, y1) = (js_round(pts[k].0) as i64, js_round(pts[k].1) as i64);
        let dx = (x1 - x0).abs();
        let dy = -(y1 - y0).abs();
        let sx = if x0 < x1 { 1 } else { -1 };
        let sy = if y0 < y1 { 1 } else { -1 };
        let mut err = dx + dy;
        loop {
            if x0 >= 0 && y0 >= 0 && (x0 as usize) < w && (y0 as usize) < h {
                let c = (y0 as usize * w + x0 as usize) as i32;
                if seen.insert(c) {
                    cells.push(c);
                }
            }
            if x0 == x1 && y0 == y1 {
                break;
            }
            let e2 = 2 * err;
            if e2 >= dy {
                err += dy;
                x0 += sx;
            }
            if e2 <= dx {
                err += dx;
                y0 += sy;
            }
        }
    }
    cells
}

/// JavaScript parseFloat: the longest numeric prefix (NaN if none).
pub fn parse_float(s: &str) -> f64 {
    let t = s.trim_start();
    let b = t.as_bytes();
    let mut i = 0;
    if i < b.len() && (b[i] == b'+' || b[i] == b'-') {
        i += 1;
    }
    if t[i..].starts_with("Infinity") {
        return if b.first() == Some(&b'-') { f64::NEG_INFINITY } else { f64::INFINITY };
    }
    let digits_start = i;
    while i < b.len() && b[i].is_ascii_digit() {
        i += 1;
    }
    let mut had_digits = i > digits_start;
    if i < b.len() && b[i] == b'.' {
        let mut j = i + 1;
        while j < b.len() && b[j].is_ascii_digit() {
            j += 1;
        }
        if j > i + 1 || had_digits {
            had_digits = had_digits || j > i + 1;
            i = j;
        }
    }
    if !had_digits {
        return f64::NAN;
    }
    if i < b.len() && (b[i] == b'e' || b[i] == b'E') {
        let mut j = i + 1;
        if j < b.len() && (b[j] == b'+' || b[j] == b'-') {
            j += 1;
        }
        let k = j;
        while j < b.len() && b[j].is_ascii_digit() {
            j += 1;
        }
        if j > k {
            i = j;
        }
    }
    t[..i].trim_end_matches('.').parse::<f64>().or_else(|_| t[..i].parse::<f64>()).unwrap_or(f64::NAN)
}

/// Parse an ESRI ASCII grid (.asc).
pub fn parse_ascii_grid(text: &str) -> Result<Grid, String> {
    let lines: Vec<&str> = text.split('\n').map(|l| l.strip_suffix('\r').unwrap_or(l)).collect();
    let mut hdr = std::collections::HashMap::new();
    let mut li = 0;
    while li < lines.len() {
        let t = lines[li].trim();
        let mut parts = t.split_whitespace();
        let (k, v) = match (parts.next(), parts.next(), parts.next()) {
            (Some(k), Some(v), None) => (k, v),
            _ => break,
        };
        let key_ok = k.chars().all(|c| c.is_ascii_alphabetic() || c == '_');
        let val_ok = v.chars().all(|c| c.is_ascii_digit() || "-.eE+".contains(c)) && !v.is_empty();
        if !key_ok || !val_ok {
            break;
        }
        hdr.insert(k.to_ascii_lowercase(), parse_float(v));
        li += 1;
    }
    let get = |k: &str| hdr.get(k).copied().unwrap_or(f64::NAN);
    let (w, h, cell) = (get("ncols"), get("nrows"), get("cellsize"));
    if !(w > 0.0 && h > 0.0 && cell > 0.0) {
        return Err("Not an ASCII grid: missing ncols, nrows or cellsize.".into());
    }
    let (w, h) = (w as usize, h as usize);
    let nd = if hdr.contains_key("nodata_value") { get("nodata_value") } else { -9999.0 };
    let rest = lines[li..].join(" ");
    let vals: Vec<&str> = rest.split_whitespace().collect();
    if vals.len() < w * h {
        return Err(format!("ASCII grid has {} values, expected {}.", vals.len(), w * h));
    }
    let mut dem = vec![0f32; w * h];
    let mut valid = vec![0u8; w * h];
    for i in 0..w * h {
        let v = parse_float(vals[i]);
        if v.is_finite() && v != nd {
            dem[i] = v as f32;
            valid[i] = 1;
        }
    }
    Ok(Grid { w, h, cell, dem, valid: Some(valid), inflow: None, d8: None })
}

/// Block-average a grid so its longest side is at most max_side cells.
pub fn downsample(g: &Grid, max_side: usize) -> Grid {
    let f = ((g.w.max(g.h) as f64) / max_side as f64).ceil() as usize;
    if f <= 1 {
        return g.clone();
    }
    let (w, h) = (g.w / f, g.h / f);
    let mut dem = vec![0f32; w * h];
    let mut valid = vec![0u8; w * h];
    for y in 0..h {
        for x in 0..w {
            let (mut s, mut n) = (0.0f64, 0usize);
            for j in 0..f {
                for i in 0..f {
                    let k = (y * f + j) * g.w + x * f + i;
                    if g.valid.as_ref().is_none_or(|v| v[k] != 0) {
                        s += g.dem[k] as f64;
                        n += 1;
                    }
                }
            }
            if n * 2 >= f * f {
                dem[y * w + x] = (s / n as f64) as f32;
                valid[y * w + x] = 1;
            }
        }
    }
    Grid { w, h, cell: g.cell * f as f64, dem, valid: Some(valid), inflow: g.inflow.clone(), d8: g.d8.clone() }
}

/// Mark values outside a plausible elevation range (or equal to nodata) invalid.
pub fn clean_nodata(g: &mut Grid, nodata: f64) {
    let n = g.w * g.h;
    let mut valid = g.valid.take().unwrap_or_else(|| vec![1u8; n]);
    for (i, valid_cell) in valid.iter_mut().enumerate().take(n) {
        let v = g.dem[i] as f64;
        if !v.is_finite() || v == nodata || !(-500.0..=9000.0).contains(&v) {
            *valid_cell = 0;
        }
    }
    g.valid = Some(valid);
}

/// A single-band 32-bit float GeoTIFF read by `parse_simple_tiff`.
pub struct Tiff {
    pub w: usize,
    pub h: usize,
    pub data: Vec<f32>,
    pub nodata: f64,
    pub bounds: Option<[f64; 4]>,
}

/// Read a single-band, uncompressed 32-bit float GeoTIFF (tiled or stripped),
/// as Geoscience Australia's elevation service returns. Missing ("sparse")
/// tiles are filled with the no-data value.
pub fn parse_simple_tiff(buf: &[u8]) -> Result<Tiff, String> {
    let rd16 = |o: usize, le: bool| -> u16 {
        let b = [buf[o], buf[o + 1]];
        if le { u16::from_le_bytes(b) } else { u16::from_be_bytes(b) }
    };
    let rd32 = |o: usize, le: bool| -> u32 {
        let b = [buf[o], buf[o + 1], buf[o + 2], buf[o + 3]];
        if le { u32::from_le_bytes(b) } else { u32::from_be_bytes(b) }
    };
    if buf.len() < 8 {
        return Err("not a TIFF file".into());
    }
    let bo = u16::from_be_bytes([buf[0], buf[1]]);
    if bo != 0x4949 && bo != 0x4d4d {
        return Err("not a TIFF file".into());
    }
    let le = bo == 0x4949;
    if rd16(2, le) != 42 {
        return Err("BigTIFF is not supported".into());
    }
    let ifd = rd32(4, le) as usize;
    let n = rd16(ifd, le) as usize;
    let size_of = |t: u16| -> usize {
        match t {
            1 | 2 => 1,
            3 => 2,
            4 | 11 => 4,
            5 | 12 | 16 => 8,
            _ => 1,
        }
    };
    let mut nums: std::collections::HashMap<u16, Vec<f64>> = std::collections::HashMap::new();
    let mut strs: std::collections::HashMap<u16, String> = std::collections::HashMap::new();
    for i in 0..n {
        let e = ifd + 2 + i * 12;
        let tag = rd16(e, le);
        let ty = rd16(e + 2, le);
        let count = rd32(e + 4, le) as usize;
        let bytes = size_of(ty) * count;
        let at = if bytes <= 4 { e + 8 } else { rd32(e + 8, le) as usize };
        if ty == 2 {
            let s: String = (0..count).map(|k| buf[at + k]).filter(|&c| c != 0).map(|c| c as char).collect();
            strs.insert(tag, s);
            continue;
        }
        let mut vals = Vec::with_capacity(count);
        for k in 0..count {
            let o = at + k * size_of(ty);
            let v = match ty {
                3 => rd16(o, le) as f64,
                4 | 16 => rd32(o, le) as f64,
                11 => f32::from_bits(rd32(o, le)) as f64,
                12 => {
                    let b: [u8; 8] = buf[o..o + 8].try_into().unwrap();
                    if le { f64::from_le_bytes(b) } else { f64::from_be_bytes(b) }
                }
                _ => buf[o] as f64,
            };
            vals.push(v);
        }
        nums.insert(tag, vals);
    }
    let first = |t: u16, d: f64| nums.get(&t).and_then(|v| v.first().copied()).unwrap_or(d);
    let w = first(256, 0.0) as usize;
    let h = first(257, 0.0) as usize;
    let (bits, fmt, comp, spp) = (first(258, 32.0), first(339, 1.0), first(259, 1.0), first(277, 1.0));
    if comp != 1.0 || bits != 32.0 || fmt != 3.0 || spp != 1.0 {
        return Err("unsupported TIFF layout".into());
    }
    let nodata = strs.get(&42113).map(|s| parse_float(s)).unwrap_or(f64::NAN);
    let fill = if nodata.is_finite() { nodata as f32 } else { f32::NAN };
    let mut data = vec![fill; w * h];
    let mut read = |off: usize, count: usize, bw: usize, bh: usize, x0: usize, y0: usize| {
        if off == 0 || count == 0 || off + count > buf.len() {
            return;
        }
        for r in 0..bh {
            let y = y0 + r;
            if y >= h {
                break;
            }
            for c in 0..bw {
                let x = x0 + c;
                if x >= w {
                    break;
                }
                let o = off + (r * bw + c) * 4;
                if o + 4 > buf.len() {
                    return;
                }
                data[y * w + x] = f32::from_bits(rd32(o, le));
            }
        }
    };
    if let Some(tw) = nums.get(&322).map(|v| v[0] as usize) {
        let th = first(323, 0.0) as usize;
        let offs = nums.get(&324).cloned().unwrap_or_default();
        let cnts = nums.get(&325).cloned().unwrap_or_default();
        let across = w.div_ceil(tw);
        for (t, &off) in offs.iter().enumerate() {
            read(off as usize, cnts.get(t).copied().unwrap_or(0.0) as usize, tw, th, (t % across) * tw, (t / across) * th);
        }
    } else {
        let rps = first(278, h as f64) as usize;
        let offs = nums.get(&273).cloned().unwrap_or_default();
        let cnts = nums.get(&279).cloned().unwrap_or_default();
        for (k, &off) in offs.iter().enumerate() {
            read(off as usize, cnts.get(k).copied().unwrap_or(0.0) as usize, w, rps, 0, k * rps);
        }
    }
    let bounds = match (nums.get(&33550), nums.get(&33922)) {
        (Some(s), Some(tp)) if s.len() >= 2 && tp.len() >= 5 => {
            let (sx, sy) = (s[0], s[1]);
            let west = tp[3] - tp[0] * sx;
            let north = tp[4] + tp[1] * sy;
            Some([west, north - h as f64 * sy, west + w as f64 * sx, north])
        }
        _ => None,
    };
    Ok(Tiff { w, h, data, nodata, bounds })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sample_terrain_has_a_bay_and_hills() {
        let g = sample_terrain();
        assert_eq!(g.dem.len(), 420 * 300);
        let min = g.dem.iter().cloned().fold(f32::INFINITY, f32::min);
        let max = g.dem.iter().cloned().fold(f32::NEG_INFINITY, f32::max);
        assert!(min < 0.0 && max > 30.0, "{min} {max}");
    }

    #[test]
    fn ascii_grid_round_trip() {
        let g = parse_ascii_grid("ncols 3\nnrows 2\ncellsize 10\nNODATA_value -9999\n1 2 3\n4 -9999 6\n").unwrap();
        assert_eq!((g.w, g.h, g.cell), (3, 2, 10.0));
        assert_eq!(g.valid.as_ref().unwrap(), &vec![1, 1, 1, 1, 0, 1]);
        assert!(parse_ascii_grid("hello").is_err());
    }

    #[test]
    fn line_cells_are_connected_and_unique() {
        let c = line_cells(&[(0.0, 0.0), (5.0, 2.0), (5.0, 2.0)], 10, 10);
        assert_eq!(c.first(), Some(&0));
        assert_eq!(c.last(), Some(&25));
        let set: std::collections::HashSet<_> = c.iter().collect();
        assert_eq!(set.len(), c.len());
    }

    #[test]
    fn parse_float_takes_a_prefix() {
        assert_eq!(parse_float("12.5abc"), 12.5);
        assert_eq!(parse_float(" -3e2"), -300.0);
        assert!(parse_float("abc").is_nan());
    }
}
