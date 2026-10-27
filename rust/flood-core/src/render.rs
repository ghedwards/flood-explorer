//! Colour mapping from a flood run to an RGBA raster: depth bands, hazard
//! classes, comparison, stream channels and terrain shading. A port of
//! viewer/app.js `composeWater()`. The JS side keeps the canvas upload
//! (`putImageData`) and the polygon mask post-pass is applied here too.

/// Colour tables matching viewer/app.js (DEPTH_STOPS, HAZARD_COLORS, ...).
const DEPTH_STOPS: [(f32, [u8; 3]); 5] = [
    (0.5, [63, 154, 224]),
    (1.0, [43, 127, 208]),
    (2.0, [31, 103, 187]),
    (4.0, [23, 80, 156]),
    (f32::INFINITY, [12, 52, 112]),
];
const DEPTH_ALPHA: [u8; 5] = [178, 230, 230, 230, 230];
const HAZARD_COLORS: [[u8; 3]; 6] = [
    [253, 231, 37],
    [122, 209, 81],
    [34, 168, 132],
    [42, 120, 142],
    [65, 68, 135],
    [68, 1, 84],
];
const WATER: [u8; 3] = [109, 147, 173];
const NORMAL_WATER: [u8; 3] = [38, 166, 154];
const CHANNEL_ALPHA: u8 = 180;
const COMPARE_ONLY_NOW: [u8; 3] = [230, 97, 1];
const COMPARE_ONLY_PINNED: [u8; 3] = [94, 60, 153];
const COMPARE_BOTH: [u8; 3] = [158, 202, 225];
const SAT_CHANNEL: f32 = 0.02;

pub struct ComposeParams {
    pub w: usize,
    pub h: usize,
    pub relief: bool,
    pub mode: u8, // 0 = depth, 1 = hazard, 2 = compare
    pub flood_a: u8,
    pub stream_a: u8,
    pub cell_km2: f32,
    pub stream_thr: f32,
}

fn depth_band(dep: f32) -> usize {
    for (k, (limit, _)) in DEPTH_STOPS.iter().enumerate() {
        if dep < *limit {
            return k;
        }
    }
    DEPTH_STOPS.len() - 1
}

fn lone_cell(wet: &[u8], i: usize, w: usize, h: usize) -> bool {
    let x = i % w;
    let y = i / w;
    for dy in -1i32..=1 {
        let yy = y as i32 + dy;
        if yy < 0 || yy >= h as i32 {
            continue;
        }
        for dx in -1i32..=1 {
            if dx == 0 && dy == 0 {
                continue;
            }
            let xx = x as i32 + dx;
            if xx < 0 || xx >= w as i32 {
                continue;
            }
            if wet[yy as usize * w + xx as usize] != 0 {
                return false;
            }
        }
    }
    true
}

/// Compose the water raster. Returns (rgba, flood_pixel_count).
/// `mask`: optional per-cell mask (1 = inside, 0 = outside). None = no mask.
#[allow(clippy::too_many_arguments)]
pub fn compose_water(
    valid: &[u8],
    ocean: &[u8],
    stream: &[u8],
    acc: &[f32],
    sat: &[f32],
    base_wet: &[u8],
    run_wet: &[u8],
    run_depth: &[f32],
    hz_cls: &[u8],
    cmp_diff: &[i8],
    params: &ComposeParams,
    mask: Option<&[u8]>,
) -> (Vec<u8>, usize) {
    let w = params.w;
    let h = params.h;
    let n = w * h;
    let mut d = vec![0u8; n * 4];
    let mut count = 0usize;
    let flood_a = params.flood_a;
    let stream_a = params.stream_a;
    let cell_km2 = params.cell_km2;
    let stream_thr = params.stream_thr;
    let mode = params.mode;
    let relief = params.relief;
    let is_hazard = mode == 1;
    let is_compare = mode == 2;

    for i in 0..n {
        if valid[i] == 0 {
            continue;
        }
        if let Some(m) = mask {
            if m[i] == 0 {
                continue;
            }
        }
        // polygon mask (passed separately as a per-cell mask) already handled above
        // isFlood in JS: !(base && base.wet[i]) && !ocean[i]
        let is_flood = if base_wet.is_empty() {
            ocean[i] == 0
        } else {
            base_wet[i] == 0 && ocean[i] == 0
        };

        let mut col: Option<[u8; 3]> = None;
        let mut band: i32 = -1;

        // relief base water
        if relief && (ocean[i] != 0 || (base_wet.len() == n && base_wet[i] != 0 && run_wet[i] != 0 && !is_flood)) {
            col = Some(WATER);
        }
        if is_compare {
            let k = cmp_diff[i];
            if k == 2 {
                col = Some(COMPARE_ONLY_NOW);
            } else if k == 3 {
                col = Some(COMPARE_ONLY_PINNED);
            } else if k == 1 && is_flood {
                col = Some(COMPARE_BOTH);
            }
        } else if run_wet[i] != 0 && is_flood {
            if is_hazard && hz_cls[i] != 0 {
                let ci = (hz_cls[i] as usize).saturating_sub(1).min(5);
                col = Some(HAZARD_COLORS[ci]);
            } else if !lone_cell(run_wet, i, w, h) {
                band = depth_band(run_depth[i]) as i32;
                col = Some(DEPTH_STOPS[band as usize].1);
            }
        }

        let o = i * 4;
        if let Some(c) = col {
            d[o] = c[0];
            d[o + 1] = c[1];
            d[o + 2] = c[2];
            let alpha = if band == 0 && !(is_hazard && hz_cls[i] != 0) && !is_compare {
                flood_a.min(DEPTH_ALPHA[0])
            } else {
                flood_a
            };
            d[o + 3] = alpha;
            count += 1;
            continue;
        }

        let channel = stream[i] != 0 && (acc[i] * cell_km2) > stream_thr;
        if stream_a != 0 && channel {
            d[o] = WATER[0];
            d[o + 1] = WATER[1];
            d[o + 2] = WATER[2];
            d[o + 3] = stream_a;
        } else if !relief && ocean[i] == 0 && ((channel && !(sat.len() == n && sat[i] >= 0.0 && sat[i] < SAT_CHANNEL)) || (base_wet.len() == n && base_wet[i] != 0)) {
            d[o] = NORMAL_WATER[0];
            d[o + 1] = NORMAL_WATER[1];
            d[o + 2] = NORMAL_WATER[2];
            d[o + 3] = CHANNEL_ALPHA;
        }
    }
    (d, count)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn empty_grid_is_transparent() {
        let w = 4; let h = 4; let n = w * h;
        let valid = vec![1u8; n];
        let ocean = vec![0u8; n];
        let stream = vec![0u8; n];
        let acc = vec![0f32; n];
        let sat = vec![0f32; n];
        let base_wet = vec![0u8; n];
        let run_wet = vec![0u8; n];
        let run_depth = vec![0f32; n];
        let hz = vec![0u8; n];
        let cmp = vec![0i8; n];
        let params = ComposeParams { w, h, relief: false, mode: 0, flood_a: 255, stream_a: 0, cell_km2: 0.0009, stream_thr: 0.0 };
        let (rgba, count) = compose_water(&valid, &ocean, &stream, &acc, &sat, &base_wet, &run_wet, &run_depth, &hz, &cmp, &params, None);
        assert_eq!(count, 0);
        assert!(rgba.iter().all(|&x| x == 0));
    }
    #[test]
    fn flooded_cell_gets_depth_color() {
        let w = 3; let h = 3; let n = w * h;
        let valid = vec![1u8; n];
        let ocean = vec![0u8; n];
        let stream = vec![0u8; n];
        let acc = vec![0f32; n];
        let sat = vec![0f32; n];
        let base_wet = vec![0u8; n];
        let mut run_wet = vec![0u8; n];
        run_wet[4] = 1; // centre cell wet
        run_wet[5] = 1; // adjacent, so not a lone speckle cell
        let mut run_depth = vec![0f32; n];
        run_depth[4] = 1.5; // 1-2m band -> DEPTH_STOPS[2] = [31,103,187]
        run_depth[5] = 1.5;
        let hz = vec![0u8; n];
        let cmp = vec![0i8; n];
        let params = ComposeParams { w, h, relief: false, mode: 0, flood_a: 255, stream_a: 0, cell_km2: 0.0009, stream_thr: 0.0 };
        let (rgba, count) = compose_water(&valid, &ocean, &stream, &acc, &sat, &base_wet, &run_wet, &run_depth, &hz, &cmp, &params, None);
        assert_eq!(count, 2);
        let o = 4 * 4;
        assert_eq!(&rgba[o..o+3], &[31, 103, 187]);
        assert_eq!(rgba[o+3], 255);
    }
    #[test]
    fn mask_excludes_cell() {
        let w = 3; let h = 3; let n = w * h;
        let valid = vec![1u8; n];
        let ocean = vec![0u8; n];
        let stream = vec![0u8; n];
        let acc = vec![0f32; n];
        let sat = vec![0f32; n];
        let base_wet = vec![0u8; n];
        let mut run_wet = vec![0u8; n];
        run_wet[4] = 1;
        run_wet[5] = 1; // adjacent, so not a lone speckle cell
        let mut run_depth = vec![0f32; n];
        run_depth[4] = 1.5;
        run_depth[5] = 1.5;
        let hz = vec![0u8; n];
        let cmp = vec![0i8; n];
        let mut mask = vec![1u8; n];
        mask[4] = 0; // mask out the flooded cells
        mask[5] = 0;
        let params = ComposeParams { w, h, relief: false, mode: 0, flood_a: 255, stream_a: 0, cell_km2: 0.0009, stream_thr: 0.0 };
        let (rgba, count) = compose_water(&valid, &ocean, &stream, &acc, &sat, &base_wet, &run_wet, &run_depth, &hz, &cmp, &params, Some(&mask));
        assert_eq!(count, 0);
        assert_eq!(rgba[4*4+3], 0);
    }
}
/// Shaded relief for the map and the static image: a hypsometric tint (`stops`, as
/// [position, r, g, b] rows from 0 to 1) lit from the north-west, sea in a flat colour, no data
/// transparent. A port of `terrainRGBA` in viewer/relief.js, which it matches to within a colour step
/// (the lighting is written without per-pixel trigonometry, so it equals the browser's only up to
/// rounding, which can move a rounded channel by one in a very few pixels).
pub fn terrain_rgba(w: usize, h: usize, cell: f64, dem: &[f32], valid: &[u8], ocean: Option<&[u8]>, stops: &[[f64; 4]]) -> Result<Vec<u8>, String> {
    let n = w * h;
    if w == 0 || h == 0 || dem.len() != n || valid.len() != n || ocean.is_some_and(|o| o.len() != n) || stops.len() < 2 {
        return Err("terrain relief: inconsistent sizes".into());
    }
    // the 2nd and 98th percentile of the land heights, from every seventh cell
    let mut land: Vec<f64> = (0..n).step_by(7).filter(|&i| valid[i] != 0 && !ocean.is_some_and(|o| o[i] != 0)).map(|i| dem[i] as f64).collect();
    land.sort_by(|a, b| a.partial_cmp(b).unwrap_or(std::cmp::Ordering::Equal));
    let (lo, hi) = if land.is_empty() { (0.0, 1.0) } else { (land[(land.len() as f64 * 0.02).floor() as usize], land[(land.len() as f64 * 0.98).floor() as usize]) };
    let (az, alt) = ((315.0_f64 * std::f64::consts::PI) / 180.0, (45.0_f64 * std::f64::consts::PI) / 180.0);
    let (cos_alt, sin_alt) = (alt.cos(), alt.sin());
    let c0 = az - std::f64::consts::FRAC_PI_2;
    let (cos_c0, sin_c0) = (c0.cos(), c0.sin());
    let tint = |t: f64| -> [f64; 3] {
        for k in 1..stops.len() {
            if t <= stops[k][0] {
                let (a, b) = (stops[k - 1], stops[k]);
                let f = (t - a[0]) / (b[0] - a[0]);
                return [a[1] + (b[1] - a[1]) * f, a[2] + (b[2] - a[2]) * f, a[3] + (b[3] - a[3]) * f];
            }
        }
        let last = stops[stops.len() - 1];
        [last[1], last[2], last[3]]
    };
    // a Uint8ClampedArray store: round half to even, clamp to 0..=255
    let byte = |v: f64| -> u8 { if v.is_nan() { 0 } else { v.clamp(0.0, 255.0).round_ties_even() as u8 } };
    let at = |x: i64, y: i64| -> f64 {
        let (x, y) = (x.clamp(0, w as i64 - 1) as usize, y.clamp(0, h as i64 - 1) as usize);
        let i = y * w + x;
        if valid[i] != 0 { dem[i] as f64 } else { f64::NAN }
    };
    let mut out = vec![0u8; n * 4];
    for y in 0..h {
        for x in 0..w {
            let (i, o) = (y * w + x, (y * w + x) * 4);
            if valid[i] == 0 {
                continue;
            }
            let c = dem[i] as f64;
            if c < -1.0 {
                out[o..o + 4].copy_from_slice(&[0xc9, 0xe7, 0xf7, 255]);
                continue;
            }
            let z = |dx: i64, dy: i64| { let v = at(x as i64 + dx, y as i64 + dy); if v.is_nan() { c } else { v } };
            let gx = (z(1, 0) - z(-1, 0)) / (2.0 * cell);
            let gy = (z(0, 1) - z(0, -1)) / (2.0 * cell);
            // The browser's formula is cos(alt) cos(slope) + sin(alt) sin(slope) cos(az - aspect - 90 deg), with
            // slope = atan(1.6 |g|) and aspect = atan2(gy, -gx). With u = 1.6 |g|: cos(atan u) = 1 / sqrt(1 + u^2),
            // sin(atan u) = u / sqrt(1 + u^2), cos(aspect) = -gx / |g| and sin(aspect) = gy / |g|, so the same number
            // comes from square roots alone (no per-pixel trigonometry), equal up to rounding.
            let g = (gx * gx + gy * gy).sqrt();   // not hypot: it is slow in WebAssembly
            let u = g * 1.6;
            let inv = 1.0 / (1.0 + u * u).sqrt();
            let toward = if g > 0.0 { (cos_c0 * -gx + sin_c0 * gy) / g } else { 0.0 };
            let hs = (cos_alt * inv + sin_alt * (u * inv) * toward).clamp(0.0, 1.0);
            let span = hi - lo;
            let t = ((c - lo) / if span != 0.0 { span } else { 1.0 }).clamp(0.0, 1.0);
            let col = tint(t);
            let k = 0.55 + 0.5 * hs;
            out[o] = byte(col[0] * k);
            out[o + 1] = byte(col[1] * k);
            out[o + 2] = byte(col[2] * k);
            out[o + 3] = 255;
        }
    }
    Ok(out)
}

#[cfg(test)]
mod relief_tests {
    use super::*;
    const STOPS: [[f64; 4]; 5] = [[0.0, 226.0, 230.0, 214.0], [0.12, 208.0, 218.0, 186.0], [0.35, 186.0, 186.0, 146.0], [0.65, 160.0, 142.0, 112.0], [1.0, 128.0, 112.0, 100.0]];

    #[test]
    fn sea_is_flat_no_data_is_clear_and_slopes_facing_the_light_are_brighter() {
        let (w, h) = (9, 5);
        // land rising to the east, a wall of sea in the first column, one cell of no data
        let dem: Vec<f32> = (0..w * h).map(|i| if i % w == 0 { -5.0 } else { (i % w) as f32 * 3.0 }).collect();
        let mut valid = vec![1u8; w * h];
        valid[2 * w + 4] = 0;
        let px = terrain_rgba(w, h, 30.0, &dem, &valid, None, &STOPS).unwrap();
        assert_eq!(px.len(), w * h * 4);
        assert_eq!(&px[0..4], &[0xc9, 0xe7, 0xf7, 255]);
        assert_eq!(px[(2 * w + 4) * 4 + 3], 0);
        assert_eq!(px[(2 * w + 5) * 4 + 3], 255);
        // flat ground lit at 45 degrees gives 0.55 + 0.5 cos(45 deg)... compare a west-facing and an east-facing slope
        let flat = vec![10f32; w * h];
        let f = terrain_rgba(w, h, 30.0, &flat, &vec![1u8; w * h], None, &STOPS).unwrap();
        let east_down: Vec<f32> = (0..w * h).map(|i| 50.0 - (i % w) as f32 * 4.0).collect();
        let west_down: Vec<f32> = (0..w * h).map(|i| (i % w) as f32 * 4.0).collect();
        let a = terrain_rgba(w, h, 30.0, &east_down, &vec![1u8; w * h], None, &STOPS).unwrap();
        let b = terrain_rgba(w, h, 30.0, &west_down, &vec![1u8; w * h], None, &STOPS).unwrap();
        let mid = (2 * w + 4) * 4;
        let sum = |p: &[u8]| p[mid] as u32 + p[mid + 1] as u32 + p[mid + 2] as u32;
        assert!(sum(&b) > sum(&a), "a slope facing the north-west light is brighter ({} against {})", sum(&b), sum(&a));
        assert!(f[mid] > 0);
    }

    #[test]
    #[ignore]
    fn time_a_large_relief() {
        let (w, h) = (1333usize, 1333usize);
        let dem: Vec<f32> = (0..w * h).map(|i| { let (x, y) = ((i % w) as f32, (i / w) as f32); if x < 250.0 { -3.0 } else { 5.0 + 40.0 * (x / 9.0).sin() * (y / 7.0).cos() + 0.2 * x } }).collect();
        let valid = vec![1u8; w * h];
        let t = std::time::Instant::now();
        let out = terrain_rgba(w, h, 30.0, &dem, &valid, None, &STOPS).unwrap();
        eprintln!("terrain_rgba {w}x{h}: {:?} ({} bytes)", t.elapsed(), out.len());
    }

    #[test]
    fn bad_sizes_are_errors() {
        assert!(terrain_rgba(3, 3, 30.0, &[0.0; 8], &[1; 9], None, &STOPS).is_err());
        assert!(terrain_rgba(3, 3, 30.0, &[0.0; 9], &[1; 9], Some(&[0; 4]), &STOPS).is_err());
        assert!(terrain_rgba(3, 3, 30.0, &[0.0; 9], &[1; 9], None, &STOPS[..1]).is_err());
    }
}
