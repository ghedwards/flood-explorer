//! The 5 m flood picture from LiDAR: for each output pixel, the model's water
//! level from the wet model cells around it (distance-weighted) against the
//! LiDAR ground height. A port of `fineRaster` in viewer/fine-raster.js, which
//! it matches byte for byte (the JavaScript stays as the reference and as the
//! fallback when the module is not loaded).
//!
//! Pixel rows run north to south. The model arrays cover a window of
//! `ww` columns starting at model cell (`x0`, `y0`); the box and the model's
//! geographic extent place the pixels on it.

pub struct Fine<'a> {
    pub w: usize,
    pub h: usize,
    /// west, south, east, north of the output.
    pub bbox: [f64; 4],
    /// west, east, north, south of the whole model grid.
    pub extent: [f64; 4],
    pub a_w: usize,
    pub a_h: usize,
    pub x0: usize,
    pub y0: usize,
    pub ww: usize,
    pub lidar: &'a [f32],
    pub nodata: f64,
    pub dem: &'a [f32],
    pub valid: &'a [u8],
    pub ocean: &'a [u8],
    pub wet: &'a [u8],
    pub depth: &'a [f32],
    pub level: Option<&'a [f32]>,
    pub base_wet: Option<&'a [u8]>,
    pub base_depth: Option<&'a [f32]>,
    pub hz_cls: Option<&'a [u8]>,
    pub hz_vel: Option<&'a [f32]>,
    /// The model's own RGBA picture for the window.
    pub coarse: &'a [u8],
    /// Upper depth limit of each band (the last may be infinite) and its RGB.
    pub depth_limits: &'a [f64],
    pub depth_colors: &'a [u8],
    pub depth_alpha0: u8,
    pub water: [u8; 3],
    pub channel_alpha: u8,
    /// Six RGB colours, and five (depth, speed, depth x speed) limits.
    pub hazard_colors: &'a [u8],
    pub hazard_limits: &'a [f64],
}

/// RGBA pixels (w * h * 4) and the number of pixels that have LiDAR.
pub fn fine_raster(p: &Fine) -> Result<(Vec<u8>, usize), String> {
    let (w, h, a_w, a_h) = (p.w, p.h, p.a_w, p.a_h);
    let n = p.dem.len();
    if w == 0 || h == 0 || a_w == 0 || a_h == 0 || p.ww == 0 || p.lidar.len() != w * h || !n.is_multiple_of(p.ww) {
        return Err("fine raster: inconsistent sizes".into());
    }
    let same = |len: usize| len == n;
    if !same(p.valid.len()) || !same(p.ocean.len()) || !same(p.wet.len()) || !same(p.depth.len()) || p.coarse.len() != n * 4
        || p.level.is_some_and(|v| !same(v.len())) || p.base_wet.is_some_and(|v| !same(v.len()))
        || p.base_depth.is_some_and(|v| !same(v.len())) || p.hz_cls.is_some_and(|v| !same(v.len())) || p.hz_vel.is_some_and(|v| !same(v.len())) {
        return Err("fine raster: the model arrays differ in size".into());
    }
    if p.depth_limits.is_empty() || p.depth_colors.len() != p.depth_limits.len() * 3 || p.hazard_colors.len() != 18 || p.hazard_limits.len() != 15 {
        return Err("fine raster: bad colour tables".into());
    }
    let hz = p.hz_cls.is_some() && p.hz_vel.is_some();
    let [west, east, north, south] = p.extent;
    let (gw, gh) = (east - west, north - south);
    let band = |dep: f64| p.depth_limits.iter().position(|&l| dep < l).unwrap_or(p.depth_limits.len() - 1);
    let hazard_class = |dep: f64, v: f64| {
        for k in 0..5 {
            let (dl, vl, dvl) = (p.hazard_limits[k * 3], p.hazard_limits[k * 3 + 1], p.hazard_limits[k * 3 + 2]);
            if dep <= dl && v <= vl && dep * v <= dvl {
                return k + 1;
            }
        }
        6
    };
    let flag = |a: Option<&[u8]>, k: usize| a.is_some_and(|v| v[k] != 0);
    let is_flood = |k: usize| p.ocean[k] == 0 && !flag(p.base_wet, k);
    // What each model cell contributes to its neighbours' averages, worked out once:
    // the water level of a wet usable cell, the speed of a hazard cell, the normal
    // river level of a baseline cell (NaN where the cell does not contribute), and
    // whether the cell is in the baseline at all.
    let mut level_of = vec![f64::NAN; n];
    let mut speed_of = vec![f64::NAN; n];
    let mut base_of = vec![f64::NAN; n];
    let mut in_base = vec![false; n];
    // ... and whether a cell or any in-grid neighbour could change the picture.
    let mut busy = vec![false; n];
    for k in 0..n {
        in_base[k] = flag(p.base_wet, k);
        if p.valid[k] == 0 || p.ocean[k] != 0 {
            continue;
        }
        if p.wet[k] != 0 {
            level_of[k] = match p.level {
                Some(l) if (l[k] as f64).is_finite() => l[k] as f64,
                _ => p.dem[k] as f64 + p.depth[k] as f64,
            };
        }
        if hz && flag(p.hz_cls, k) {
            speed_of[k] = p.hz_vel.unwrap()[k] as f64;
        }
        if let (Some(bd), true) = (p.base_depth, in_base[k]) {
            base_of[k] = p.dem[k] as f64 + bd[k] as f64;
        }
    }
    for k in 0..n {
        busy[k] = !level_of[k].is_nan() || !speed_of[k].is_nan() || !base_of[k].is_nan() || in_base[k];
    }
    let mut out = vec![0u8; w * h * 4];
    let mut have = 0usize;
    let (ww, x0, y0) = (p.ww as i64, p.x0 as i64, p.y0 as i64);
    // The columns' nearest model cell and weights do not depend on the row.
    let cols: Vec<(i64, f64)> = (0..w).map(|px| {
        let lon = p.bbox[0] + ((px as f64 + 0.5) / w as f64) * (p.bbox[2] - p.bbox[0]);
        let fx = ((lon - west) / gw) * a_w as f64 - 0.5;
        ((a_w as f64 - 1.0).min(0f64.max((fx + 0.5).floor())) as i64, fx)
    }).collect();
    for py in 0..h {
        let lat = p.bbox[3] - ((py as f64 + 0.5) / h as f64) * (p.bbox[3] - p.bbox[1]);
        let fy = ((north - lat) / gh) * a_h as f64 - 0.5;
        let cy = (a_h as f64 - 1.0).min(0f64.max((fy + 0.5).floor())) as i64;
        for (px, &(cx, fx)) in cols.iter().enumerate() {
            let ci = (cy - y0) * ww + (cx - x0);
            let o = (py * w + px) * 4;
            let lid = p.lidar[py * w + px] as f64;
            // a pixel whose model cell lies outside the window is left clear
            if ci < 0 || ci as usize >= n {
                continue;
            }
            let ci = ci as usize;
            let copy = |out: &mut [u8]| out[o..o + 4].copy_from_slice(&p.coarse[ci * 4..ci * 4 + 4]);
            if !(lid.is_finite() && lid != p.nodata && lid > -100.0 && lid < 9000.0) {
                copy(&mut out);
                continue;
            }
            have += 1;
            if p.ocean[ci] != 0 {
                copy(&mut out);
                continue;
            }
            let (mut ws, mut wsum, mut bs, mut bsum, mut n_in, mut n_base, mut vs, mut vsum) = (0.0f64, 0.0f64, 0.0f64, 0.0f64, 0usize, 0usize, 0.0f64, 0.0f64);
            let (ylo, yhi) = ((cy - 1).max(0), (cy + 1).min(a_h as i64 - 1));
            let (xlo, xhi) = ((cx - 1).max(0), (cx + 1).min(a_w as i64 - 1));
            for yy in ylo..=yhi {
                let row = (yy - y0) * ww - x0;
                let ey = yy as f64 - fy;
                let ey2 = ey * ey;
                for xx in xlo..=xhi {
                    let k = row + xx;
                    if k < 0 || k as usize >= n {
                        continue;
                    }
                    let k = k as usize;
                    n_in += 1;
                    if in_base[k] {
                        n_base += 1;
                    }
                    if !busy[k] {
                        continue;
                    }
                    let ex = xx as f64 - fx;
                    let wt = 1.0 / (0.25 + ex * ex + ey2);
                    let lv = level_of[k];
                    if !lv.is_nan() {
                        ws += wt * lv;
                        wsum += wt;
                    }
                    let v = speed_of[k];
                    if !v.is_nan() {
                        vs += wt * v;
                        vsum += wt;
                    }
                    let b = base_of[k];
                    if !b.is_nan() {
                        bs += wt * b;
                        bsum += wt;
                    }
                }
            }
            let truthy = |v: f64| v != 0.0 && !v.is_nan();
            let dep = if truthy(wsum) { ws / wsum - lid } else { 0.0 };
            let dep_base = if truthy(bsum) { bs / bsum - lid } else { 0.0 };
            if dep_base > 0.02 || (n_base == n_in && n_in > 0) {
                out[o..o + 3].copy_from_slice(&p.water);
                out[o + 3] = p.channel_alpha;
            } else if dep > 0.02 && hz {
                let c = hazard_class(dep, if truthy(vsum) { vs / vsum } else { 0.0 }) - 1;
                out[o..o + 3].copy_from_slice(&p.hazard_colors[c * 3..c * 3 + 3]);
                out[o + 3] = 255;
            } else if dep > 0.02 {
                let b = band(dep);
                out[o..o + 3].copy_from_slice(&p.depth_colors[b * 3..b * 3 + 3]);
                out[o + 3] = if b == 0 { p.depth_alpha0 } else { 255 };
            } else if !(p.wet[ci] != 0 && is_flood(ci)) {
                copy(&mut out);
            }
        }
    }
    Ok((out, have))
}

#[cfg(test)]
mod tests {
    use super::*;

    // A 40 x 40 model over a 0.01 degree square: ground at 1 m, water level 2 m
    // in the west half. Mirrors the setup of tests/fine-raster.test.js.
    struct Setup {
        dem: Vec<f32>, valid: Vec<u8>, ocean: Vec<u8>, wet: Vec<u8>, depth: Vec<f32>, coarse: Vec<u8>, lidar: Vec<f32>,
    }
    fn setup() -> Setup {
        let (a_w, a_h) = (40usize, 40usize);
        let n = a_w * a_h;
        let mut wet = vec![0u8; n];
        let mut depth = vec![0f32; n];
        for y in 0..a_h { for x in 0..20 { wet[y * a_w + x] = 1; depth[y * a_w + x] = 1.0; } }
        let mut lidar = vec![1f32; 60 * 60];
        for y in 20..30 { for x in 5..15 { lidar[y * 60 + x] = 3.0; } }
        lidar[0] = -9999.0;
        Setup { dem: vec![1.0; n], valid: vec![1; n], ocean: vec![0; n], wet, depth, coarse: vec![0; n * 4], lidar }
    }
    const LIMITS: [f64; 5] = [0.5, 1.0, 2.0, 4.0, f64::INFINITY];
    const COLORS: [u8; 15] = [1, 1, 1, 2, 2, 2, 3, 3, 3, 4, 4, 4, 5, 5, 5];
    const HAZ_COLORS: [u8; 18] = [11, 0, 0, 12, 0, 0, 13, 0, 0, 14, 0, 0, 15, 0, 0, 16, 0, 0];
    const HAZ_LIMITS: [f64; 15] = [0.3, 2.0, 0.3, 0.5, 2.0, 0.6, 1.2, 2.0, 0.6, 2.0, 2.0, 1.0, 4.0, 4.0, 4.0];

    fn run<'a>(s: &'a Setup) -> Fine<'a> {
        Fine {
            w: 60, h: 60, bbox: [150.002, -23.008, 150.008, -23.002], extent: [150.0, 150.01, -23.0, -23.01], a_w: 40, a_h: 40, x0: 0, y0: 0, ww: 40,
            lidar: &s.lidar, nodata: -9999.0, dem: &s.dem, valid: &s.valid, ocean: &s.ocean, wet: &s.wet, depth: &s.depth,
            level: None, base_wet: None, base_depth: None, hz_cls: None, hz_vel: None, coarse: &s.coarse,
            depth_limits: &LIMITS, depth_colors: &COLORS, depth_alpha0: 178, water: [9, 9, 9], channel_alpha: 90,
            hazard_colors: &HAZ_COLORS, hazard_limits: &HAZ_LIMITS,
        }
    }
    fn px(rgba: &[u8], x: usize, y: usize) -> [u8; 4] {
        let o = (y * 60 + x) * 4;
        [rgba[o], rgba[o + 1], rgba[o + 2], rgba[o + 3]]
    }

    #[test]
    fn wet_ground_gets_its_depth_colour_and_high_ground_stays_dry() {
        let s = setup();
        let (rgba, have) = fine_raster(&run(&s)).unwrap();
        assert_eq!(have, 60 * 60 - 1);
        assert_eq!(px(&rgba, 8, 25), [0, 0, 0, 0], "the 3 m mound is above the 2 m water level");
        assert_eq!(px(&rgba, 2, 40), [3, 3, 3, 255], "1 m deep is the 1 to 2 m band");
        assert_eq!(px(&rgba, 55, 40)[3], 0, "the dry east half stays clear");
    }

    #[test]
    fn hazard_colours_use_the_speed_of_the_flooded_cells() {
        let s = setup();
        let cls = vec![1u8; 40 * 40];
        let vel = vec![0.1f32; 40 * 40];
        let mut p = run(&s);
        p.hz_cls = Some(&cls);
        p.hz_vel = Some(&vel);
        let (rgba, _) = fine_raster(&p).unwrap();
        // 1 m deep at 0.1 m/s: depth <= 1.2, speed <= 2, depth x speed <= 0.6, the third class
        assert_eq!(px(&rgba, 2, 40), [13, 0, 0, 255]);
    }

    #[test]
    fn normal_river_cells_are_drawn_as_channel() {
        let s = setup();
        let base = vec![1u8; 40 * 40];
        let mut p = run(&s);
        p.base_wet = Some(&base);
        let (rgba, _) = fine_raster(&p).unwrap();
        assert_eq!(px(&rgba, 2, 40), [9, 9, 9, 90]);
    }

    #[test]
    fn bad_sizes_are_errors_not_panics() {
        let s = setup();
        let mut p = run(&s);
        p.lidar = &s.lidar[..10];
        assert!(fine_raster(&p).is_err());
        let mut q = run(&s);
        q.depth_limits = &[];
        assert!(fine_raster(&q).is_err());
        let short = vec![0u8; 5];
        let mut r = run(&s);
        r.wet = &short;
        assert!(fine_raster(&r).is_err());
    }
}

#[cfg(test)]
mod bench {
    use super::*;
    #[test]
    #[ignore]
    fn time_a_large_picture() {
        let (a_w, a_h, n) = (400usize, 400usize, 400 * 400);
        let (w, h) = (2000usize, 2000usize);
        let dem = vec![1f32; n];
        let valid = vec![1u8; n];
        let ocean = vec![0u8; n];
        let wet: Vec<u8> = (0..n).map(|i| (i % a_w < 200) as u8).collect();
        let depth: Vec<f32> = (0..n).map(|i| if i % a_w < 200 { 1.0 + (i % 7) as f32 * 0.2 } else { 0.0 }).collect();
        let lidar: Vec<f32> = (0..w * h).map(|i| 0.5 + (i % 13) as f32 * 0.1).collect();
        let coarse = vec![0u8; n * 4];
        let limits = [0.5, 1.0, 2.0, 4.0, f64::INFINITY];
        let colors = [1u8; 15];
        let hc = [1u8; 18];
        let hl = [0.3, 2.0, 0.3, 0.5, 2.0, 0.6, 1.2, 2.0, 0.6, 2.0, 2.0, 1.0, 4.0, 4.0, 4.0];
        let p = Fine { w, h, bbox: [150.02, -23.18, 150.12, -23.08], extent: [150.0, 150.2, -23.0, -23.2], a_w, a_h, x0: 0, y0: 0, ww: a_w,
            lidar: &lidar, nodata: -9999.0, dem: &dem, valid: &valid, ocean: &ocean, wet: &wet, depth: &depth, level: None, base_wet: None, base_depth: None,
            hz_cls: None, hz_vel: None, coarse: &coarse, depth_limits: &limits, depth_colors: &colors, depth_alpha0: 178, water: [9, 9, 9], channel_alpha: 90,
            hazard_colors: &hc, hazard_limits: &hl };
        let t = std::time::Instant::now();
        let (_, have) = fine_raster(&p).unwrap();
        eprintln!("native: {:?} for {} pixels", t.elapsed(), have);
    }
}
