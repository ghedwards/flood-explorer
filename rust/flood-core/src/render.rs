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
    sat: &[i32],
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
        } else if !relief && ocean[i] == 0 && ((channel && !(sat.len() == n && sat[i] >= 0 && (sat[i] as f32) < SAT_CHANNEL)) || (base_wet.len() == n && base_wet[i] != 0)) {
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
        let sat = vec![0i32; n];
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
        let sat = vec![0i32; n];
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
        let sat = vec![0i32; n];
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