//! Gaps in a downloaded elevation window: sea, or holes in the data? A port of
//! `classifyDemGaps` in viewer/dem-voids.js, which it matches exactly (the
//! JavaScript stays as the reference and the fallback).
//!
//! Geoscience Australia's DEM-H marks the sea as "no data", but it also has
//! occasional gaps inland. Each connected gap is sea only if it reaches the
//! edge of the window and the land along its edge is low; any other gap is
//! filled from the land around it, ring by ring from its edge inwards.
//! Gaps are NaN in `dem`, which is changed in place.

pub const SEA_SHORE_MAX_M: f64 = 20.0;

pub struct Gaps {
    /// 1 where the cell is sea.
    pub sea: Vec<u8>,
    pub sea_cells: usize,
    pub filled_cells: usize,
    pub gaps: usize,
}

/// The up-to-four neighbours of a cell in the order left, right, up, down. The order
/// matters: the fill averages them in this order and floating-point sums depend on it.
fn neighbours(i: usize, w: usize, h: usize) -> impl Iterator<Item = usize> {
    let (x, y) = (i % w, i / w);
    [
        (x > 0).then(|| i - 1),
        (x + 1 < w).then(|| i + 1),
        (y > 0).then(|| i - w),
        (y + 1 < h).then(|| i + w),
    ]
    .into_iter()
    .flatten()
}

pub fn classify_dem_gaps(dem: &mut [f32], w: usize, h: usize, shore_max: f64) -> Result<Gaps, String> {
    let n = w.checked_mul(h).ok_or("window too large")?;
    if w == 0 || h == 0 || dem.len() != n {
        return Err("classifyDemGaps: the elevation array does not match the window size".into());
    }
    let mut sea = vec![0u8; n];
    let mut seen = vec![false; n];
    let mut queue: Vec<usize> = Vec::new();
    let (mut sea_cells, mut filled_cells, mut gaps) = (0usize, 0usize, 0usize);
    // the cells of every inland gap, one after another
    let mut fill: Vec<usize> = Vec::new();
    for s in 0..n {
        if !dem[s].is_nan() || seen[s] {
            continue;
        }
        // one gap: its cells, whether it reaches the window's edge, and the land along its edge
        gaps += 1;
        queue.clear();
        let (mut head, mut edge, mut shore_sum, mut shore_n) = (0usize, false, 0.0f64, 0usize);
        queue.push(s);
        seen[s] = true;
        while head < queue.len() {
            let i = queue[head];
            head += 1;
            let (x, y) = (i % w, i / w);
            if x == 0 || y == 0 || x == w - 1 || y == h - 1 {
                edge = true;
            }
            for j in neighbours(i, w, h) {
                if dem[j].is_nan() {
                    if !seen[j] {
                        seen[j] = true;
                        queue.push(j);
                    }
                } else {
                    shore_sum += dem[j] as f64;
                    shore_n += 1;
                }
            }
        }
        let shore = if shore_n > 0 { shore_sum / shore_n as f64 } else { f64::NEG_INFINITY };
        if edge && shore < shore_max {
            for &i in &queue {
                sea[i] = 1;
            }
            sea_cells += queue.len();
        } else {
            filled_cells += queue.len();
            fill.extend_from_slice(&queue);
        }
    }
    // Fill each inland gap ring by ring from its edge: a breadth-first walk from the land
    // gives each cell its ring, and in that order each cell takes the mean of its neighbours
    // in earlier rings (or land). One pass, however big the gap.
    if !fill.is_empty() {
        let mut ring = vec![-1i32; n];
        queue.clear();
        for &i in &fill {
            if neighbours(i, w, h).any(|j| !dem[j].is_nan()) {
                ring[i] = 0;
                queue.push(i);
            }
        }
        let mut head = 0;
        while head < queue.len() {
            let i = queue[head];
            head += 1;
            for j in neighbours(i, w, h) {
                if ring[j] < 0 && dem[j].is_nan() && sea[j] == 0 {
                    ring[j] = ring[i] + 1;
                    queue.push(j);
                }
            }
        }
        for q in 0..queue.len() {
            let (i, ri) = (queue[q], ring[queue[q]]);
            let (mut sum, mut count) = (0.0f64, 0usize);
            for j in neighbours(i, w, h) {
                let earlier = if ring[j] < 0 { !dem[j].is_nan() } else { ring[j] < ri };
                if sea[j] == 0 && earlier {
                    sum += dem[j] as f64;
                    count += 1;
                }
            }
            dem[i] = if count > 0 { (sum / count as f64) as f32 } else { 0.0 };
        }
    }
    Ok(Gaps { sea, sea_cells, filled_cells, gaps })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn an_inland_gap_is_filled_from_the_land_around_it() {
        let (w, h) = (20, 20);
        let mut dem = vec![170f32; w * h];
        for y in 8..12 { for x in 8..12 { dem[y * w + x] = f32::NAN; } }
        let r = classify_dem_gaps(&mut dem, w, h, SEA_SHORE_MAX_M).unwrap();
        assert_eq!((r.sea_cells, r.filled_cells, r.gaps), (0, 16, 1));
        assert!(dem.iter().all(|v| (v - 170.0).abs() < 1e-3));
    }

    #[test]
    fn no_data_along_a_low_coast_is_sea_and_is_left_as_no_data() {
        let (w, h) = (20, 20);
        let mut dem: Vec<f32> = (0..w * h).map(|i| if i % w < 6 { f32::NAN } else { ((i % w) as f32 - 5.0) * 1.5 }).collect();
        let r = classify_dem_gaps(&mut dem, w, h, SEA_SHORE_MAX_M).unwrap();
        assert_eq!((r.sea_cells, r.filled_cells), (6 * h, 0));
        assert_eq!(r.sea[0], 1);
        assert!(dem[0].is_nan());
    }

    #[test]
    fn a_gap_at_the_edge_among_high_ground_is_a_hole() {
        let (w, h) = (20, 20);
        let mut dem = vec![210f32; w * h];
        for y in 0..3 { for x in 5..9 { dem[y * w + x] = f32::NAN; } }
        let r = classify_dem_gaps(&mut dem, w, h, SEA_SHORE_MAX_M).unwrap();
        assert_eq!((r.sea_cells, r.filled_cells), (0, 12));
        assert!((dem[5] - 210.0).abs() < 1e-3);
    }

    #[test]
    fn an_all_no_data_window_is_sea_and_wrong_sizes_are_errors() {
        let mut dem = vec![f32::NAN; 12];
        let r = classify_dem_gaps(&mut dem, 4, 3, SEA_SHORE_MAX_M).unwrap();
        assert_eq!((r.sea_cells, r.gaps), (12, 1));
        assert!(classify_dem_gaps(&mut dem, 5, 3, SEA_SHORE_MAX_M).is_err());
        assert!(classify_dem_gaps(&mut [], 0, 0, SEA_SHORE_MAX_M).is_err());
    }
}
