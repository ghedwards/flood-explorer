//! The grids the tsunami lab runs on, built and checked here: the regional propagation grids (idealised flat, shelf and island basins, or a prefetched coastal grid), the
//! idealised nonlinear estuary, and the real local terrain scenes, each with its starting wave. `connected_water_depth` fills the sea inward from a scene's open edges.
//! Every builder refuses what it cannot run with the same messages the lab shows.

use crate::inundation::Edge;

pub const W: usize = 160;
pub const H: usize = 96;

/// A grid ready for `tsunami::Solver` (regional) or `inundation::Solver` (estuary and local): the water depth, the starting surface displacement and, for the nonlinear scenes, the
/// bed, the valid-cell mask and the roughness. `method` is 0 staggered, 1 finite volume, 2 nonlinear and 3 dispersive.
#[derive(Debug)]
pub struct Grid {
    pub w: usize,
    pub h: usize,
    pub cell: f64,
    pub depth: Vec<f64>,
    pub eta: Vec<f64>,
    pub bed: Option<Vec<f64>>,
    pub valid: Option<Vec<u8>>,
    pub absorbing: bool,
    pub roughness: Option<f64>,
    pub method: u8,
    pub coupled: bool,
}

#[derive(Clone, Copy, PartialEq, Debug)]
pub enum Shape { Flat, Shelf, Island }

/// What a regional grid is built from: an idealised basin, or a prefetched grid (its id, size, cell, elevations in metres and lon/lat bounds, as the lab's data files have them).
pub enum Basin<'a> { Ideal(Shape), Coast { id_ok: bool, w: usize, h: usize, cell: f64, elevation: &'a [f64], bounds: &'a [f64] } }

pub struct Regional<'a> { pub basin: Basin<'a>, pub deep: f64, pub amplitude: f64, pub width: f64, pub source: [f64; 2], pub absorbing: bool, pub method: u8 }

fn all_finite(v: &[f64]) -> bool { v.iter().all(|x| x.is_finite()) }

/// Regional propagation grids: the idealised basins, or a prefetched coastal grid whose land/sea mask is kept (the propagation-only model floors wet cells at 10 m).
pub fn regional(r: &Regional) -> Result<Grid, String> {
    let invalid = || Err("Invalid wave scenario.".to_string());
    if r.method > 3 { return invalid(); }
    if !r.deep.is_finite() || r.deep < 500.0 || r.deep > 5000.0 || !r.amplitude.is_finite() || r.amplitude.abs() > 3.0 || !r.width.is_finite() || r.width < 5.0 || r.width > 20.0
        || !all_finite(&r.source) { return invalid(); }
    let cell = if matches!(r.basin, Basin::Coast { .. }) { 1500.0 } else { 1000.0 };
    if let Basin::Coast { id_ok, w, h, cell: c, elevation, bounds } = &r.basin {
        if !id_ok || *w != W || *h != H || *c != cell || elevation.len() != W * H || elevation.iter().any(|x| !x.is_finite() || *x < -12000.0 || *x > 9000.0)
            || bounds.len() != 4 || !all_finite(bounds) { return Err("Invalid prefetched coastal grid.".into()); }
    }
    let (sx, sy) = (r.source[0], r.source[1]);
    if sx < 0.0 || sx >= W as f64 || sy < 0.0 || sy >= H as f64 { return Err("Choose a source inside the basin.".into()); }
    let (mut depth, mut eta) = (vec![0.0; W * H], vec![0.0; W * H]);
    for y in 0..H { for x in 0..W {
        let i = y * W + x;
        let (xf, yf) = (x as f64, y as f64);
        match &r.basin {
            Basin::Coast { elevation, .. } => depth[i] = if elevation[i] < 0.0 { (-elevation[i]).max(10.0) } else { 0.0 },
            Basin::Ideal(shape) => {
                let coast = 130.0 + 3.0 * (yf / H as f64 * std::f64::consts::PI * 2.0).cos();
                depth[i] = if *shape == Shape::Flat { r.deep } else if xf >= coast { 0.0 } else { 20.0_f64.max(r.deep * ((coast - xf) / 50.0).min(1.0)) };
                if *shape == Shape::Island {
                    let radius = (xf - 87.0).hypot(yf - 48.0);
                    depth[i] = depth[i].min(if radius <= 7.0 { 0.0 } else { 20.0_f64.max(r.deep * ((radius - 7.0) / 16.0).min(1.0)) });
                }
            }
        }
        if depth[i] > 0.0 {
            let (dx, dy) = ((xf - sx) * cell / 1000.0 / r.width, (yf - sy) * cell / 1000.0 / r.width);
            // Paired uplift/subsidence at rest; the positive lobe faces east.
            eta[i] = r.amplitude * dx * (0.5 - 0.5 * (dx * dx + dy * dy)).exp();
        }
    } }
    if depth[sy.floor() as usize * W + sx.floor() as usize] == 0.0 { return Err("Choose a wave source in the ocean.".into()); }
    Ok(Grid { w: W, h: H, cell, depth, eta, bed: None, valid: None, absorbing: r.absorbing, roughness: None, method: r.method, coupled: false })
}

/// Sea inward from the open edges: the depth (m) of every cell connected to an open edge whose ground is below `level`, 0 elsewhere. Only ocean-facing edges seed the initial
/// sea level; this does not impose an open-flow boundary.
pub fn connected_water_depth(bed: &[f64], w: usize, h: usize, level: f64, edges: &[Edge], valid: Option<&[u8]>) -> Result<Vec<f64>, String> {
    if edges.is_empty() { return Err("Invalid ocean-facing terrain edges.".into()); }
    let (mut depth, mut seen, mut queue) = (vec![0.0; w * h], vec![false; w * h], Vec::new());
    let ok = |i: usize| valid.is_none_or(|v| v[i] != 0) && bed[i].is_finite() && bed[i] < level;
    let add = |i: usize, seen: &mut Vec<bool>, queue: &mut Vec<usize>| { if !seen[i] && ok(i) { seen[i] = true; queue.push(i); } };
    for y in 0..h {
        if edges.contains(&Edge::East) { add(y * w + w - 1, &mut seen, &mut queue); }
        if edges.contains(&Edge::West) { add(y * w, &mut seen, &mut queue); }
    }
    for x in 0..w {
        if edges.contains(&Edge::North) { add(x, &mut seen, &mut queue); }
        if edges.contains(&Edge::South) { add((h - 1) * w + x, &mut seen, &mut queue); }
    }
    let mut head = 0;
    while head < queue.len() {
        let i = queue[head];
        head += 1;
        let (x, y) = (i % w, i / w);
        depth[i] = level - bed[i];
        if x > 0 { add(i - 1, &mut seen, &mut queue); }
        if x + 1 < w { add(i + 1, &mut seen, &mut queue); }
        if y > 0 { add(i - w, &mut seen, &mut queue); }
        if y + 1 < h { add(i + w, &mut seen, &mut queue); }
    }
    Ok(depth)
}

pub struct Estuary { pub amplitude: f64, pub width: f64, pub source: [f64; 2], pub absorbing: bool, pub tide: f64, pub roughness: f64, pub lake_level: f64 }

/// The 4 x 2.4 km idealised coast (not a reconstruction of Moreton Bay): a low floodplain, a curving estuary, a raised inland lake and an offshore pulse.
pub fn estuary(e: &Estuary) -> Result<Grid, String> {
    let is_int = |v: f64| v.is_finite() && v.fract() == 0.0;
    if ![e.amplitude, e.width, e.tide, e.roughness, e.lake_level].iter().all(|v| v.is_finite()) || e.amplitude.abs() > 3.0 || e.width < 0.1 || e.width > 0.8 || e.tide < -1.0 || e.tide > 2.0
        || e.roughness < 0.0 || e.roughness > 0.2 || e.lake_level < 0.5 || e.lake_level > 2.0 || !is_int(e.source[0]) || !is_int(e.source[1])
        || e.source[0] < 0.0 || e.source[0] >= 160.0 || e.source[1] < 0.0 || e.source[1] >= 96.0 { return Err("Invalid estuary scenario.".into()); }
    let cell = 25.0;
    let (mut bed, mut depth, mut eta) = (vec![0.0; W * H], vec![0.0; W * H], vec![0.0; W * H]);
    for y in 0..H { for x in 0..W {
        let i = y * W + x;
        let (xf, yf) = (x as f64, y as f64);
        let channel = (yf - (48.0 + 7.0 * ((xf - 78.0) / 22.0).sin())).abs();
        let mut z = if xf < 80.0 { -((80.0 - xf) * 0.5).min(40.0) } else { 0.05 * (xf - 80.0) };
        if xf >= 70.0 && channel < 4.0 { z = z.min(-2.0 + (xf - 90.0).max(0.0) * 0.015); }
        // Elliptical lake with a raised rim separates its water level from the sea.
        let lake = (((xf - 128.0) / 13.0).powi(2) + ((yf - 22.0) / 10.0).powi(2)).sqrt();
        if lake < 1.25 { z = if lake < 1.0 { -0.5 } else { 2.5 }; }
        bed[i] = z;
        let level = if lake < 1.0 { e.lake_level } else { e.tide };
        depth[i] = (level - z).max(0.0);
    } }
    let origin = e.source[1] as usize * W + e.source[0] as usize;
    if depth[origin] < 0.25 { return Err("Choose a wave source in water at least 0.25 m deep.".into()); }
    // Perturb only the source waterbody. Clicking the lake can generate a seiche without also imposing the same initial wave on the disconnected ocean.
    let (mut queue, mut seen) = (vec![origin], vec![false; W * H]);
    seen[origin] = true;
    let mut head = 0;
    while head < queue.len() {
        let i = queue[head];
        head += 1;
        let (x, y) = (i % W, i / W);
        let (dx, dy) = ((x as f64 - e.source[0]) * cell / 1000.0 / e.width, (y as f64 - e.source[1]) * cell / 1000.0 / e.width);
        eta[i] = e.amplitude * dx * (0.5 - 0.5 * (dx * dx + dy * dy)).exp() * (depth[i] / 5.0).min(1.0);
        let mut add = |j: usize| { if !seen[j] && depth[j] > 0.0 { seen[j] = true; queue.push(j); } };
        if x > 0 { add(i - 1); }
        if x + 1 < W { add(i + 1); }
        if y > 0 { add(i - W); }
        if y + 1 < H { add(i + W); }
    }
    Ok(Grid { w: W, h: H, cell, depth, eta, bed: Some(bed), valid: None, absorbing: e.absorbing, roughness: Some(e.roughness), method: 2, coupled: false })
}

/// A real local terrain scene (one of the lab's cropped 160 x 96 coasts): its elevations with null (NaN) where there is no ground data, the valid-cell mask, MGA extent and the
/// sea edges that face the ocean.
pub struct LocalTerrain<'a> { pub id_ok: bool, pub w: usize, pub h: usize, pub cell: f64, pub valid: Option<&'a [u8]>, pub elevation: &'a [f64], pub extent: &'a [f64], pub sea_edges: &'a [Edge] }

pub struct Local<'a> { pub terrain: LocalTerrain<'a>, pub amplitude: f64, pub width: f64, pub source: [f64; 2], pub absorbing: bool, pub tide: f64, pub roughness: f64, pub coupled: bool }

pub fn local(l: &Local) -> Result<Grid, String> {
    let t = &l.terrain;
    let invalid = || Err("Invalid local estuary terrain or water settings.".to_string());
    let n = W * H;
    if !t.cell.is_finite() || t.cell < 10.0 || t.cell > 100.0 || !t.id_ok || t.w != W || t.h != H { return invalid(); }
    if let Some(v) = t.valid { if v.len() != n || v.iter().any(|x| *x > 1) { return invalid(); } }
    if t.elevation.len() != n { return invalid(); }
    for (i, v) in t.elevation.iter().enumerate() {
        let masked = t.valid.is_some_and(|m| m[i] == 0);
        if masked { if !v.is_nan() { return invalid(); } } else if !v.is_finite() || *v < -100.0 || *v > 1000.0 { return invalid(); }
    }
    if t.extent.len() != 4 || !all_finite(t.extent) || (t.extent[2] - t.extent[0] - W as f64 * t.cell).abs() > 0.01 || (t.extent[3] - t.extent[1] - H as f64 * t.cell).abs() > 0.01 { return invalid(); }
    if ![l.amplitude, l.width, l.tide, l.roughness].iter().all(|v| v.is_finite()) || l.amplitude.abs() > 3.0 || l.width < 0.1 || l.width > 0.8 || l.tide < -1.0 || l.tide > 2.0
        || l.roughness < 0.0 || l.roughness > 0.2 { return invalid(); }
    let is_int = |v: f64| v.is_finite() && v.fract() == 0.0;
    if !is_int(l.source[0]) || !is_int(l.source[1]) || l.source[0] < 0.0 || l.source[0] >= W as f64 || l.source[1] < 0.0 || l.source[1] >= H as f64 { return invalid(); }
    let bed: Vec<f64> = t.elevation.iter().map(|v| if v.is_nan() { 0.0 } else { *v }).collect();
    let depth = connected_water_depth(&bed, W, H, l.tide, t.sea_edges, t.valid)?;
    // Driven by a regional wave: still water at the start, the wave enters at the open edges.
    let (sx, sy) = (l.source[0] as usize, l.source[1] as usize);
    if !l.coupled && depth[sy * W + sx] < 2.0 { return Err("Choose a source in connected bay water at least 2 m deep.".into()); }
    let mut eta = vec![0.0; n];
    if !l.coupled {
        for (i, e) in eta.iter_mut().enumerate() {
            if depth[i] > 0.0 {
                let (dx, dy) = (((i % W) as f64 - l.source[0]) * t.cell / 1000.0 / l.width, ((i / W) as f64 - l.source[1]) * t.cell / 1000.0 / l.width);
                // Crest faces west towards the river. Depth taper keeps drawdown positive.
                *e = -l.amplitude * dx * (0.5 - 0.5 * (dx * dx + dy * dy)).exp() * (depth[i] / 5.0).min(1.0);
            }
        }
    }
    Ok(Grid { w: W, h: H, cell: t.cell, depth, eta, bed: Some(bed), valid: t.valid.map(|v| v.to_vec()), absorbing: l.absorbing && !l.coupled, roughness: Some(l.roughness), method: 2, coupled: l.coupled })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ideal(shape: Shape) -> Regional<'static> { Regional { basin: Basin::Ideal(shape), deep: 3000.0, amplitude: 1.0, width: 10.0, source: [38.0, 48.0], absorbing: true, method: 0 } }

    #[test]
    fn the_idealised_basins_have_ocean_at_the_source_land_at_the_far_edge_and_a_wave_that_is_zero_on_land() {
        for shape in [Shape::Flat, Shape::Shelf, Shape::Island] {
            let g = regional(&ideal(shape)).unwrap();
            assert_eq!((g.w, g.h, g.cell, g.method), (W, H, 1000.0, 0));
            assert!(g.depth[48 * W + 38] > 0.0 && g.eta.iter().zip(&g.depth).all(|(e, d)| *d > 0.0 || *e == 0.0));
            assert!(g.eta.iter().any(|e| *e > 0.0) && g.eta.iter().any(|e| *e < 0.0), "paired uplift and subsidence");
        }
        assert_eq!(regional(&ideal(Shape::Shelf)).unwrap().depth[48 * W + 150], 0.0, "land beyond the coast");
        assert!(regional(&ideal(Shape::Island)).unwrap().depth[48 * W + 87] == 0.0, "the island is land");
        assert!(regional(&ideal(Shape::Flat)).unwrap().depth.iter().all(|d| *d == 3000.0));
    }

    #[test]
    fn a_regional_grid_refuses_what_it_cannot_run_with_the_labs_messages() {
        let bad = |r: Regional| regional(&r).unwrap_err();
        assert!(bad(Regional { source: [150.0, 48.0], ..ideal(Shape::Shelf) }).contains("ocean"));
        assert!(bad(Regional { source: [f64::NAN, 48.0], ..ideal(Shape::Shelf) }).contains("Invalid"));
        assert!(bad(Regional { deep: -1.0, ..ideal(Shape::Shelf) }).contains("Invalid"));
        assert!(bad(Regional { source: [-1.0, 48.0], ..ideal(Shape::Shelf) }).contains("inside the basin"));
        assert!(bad(Regional { width: 25.0, ..ideal(Shape::Shelf) }).contains("Invalid"));
        assert!(bad(Regional { basin: Basin::Coast { id_ok: true, w: W, h: H, cell: 1500.0, elevation: &[], bounds: &[0.0, 1.0, 2.0, 3.0] }, ..ideal(Shape::Shelf) }).contains("prefetched"));
    }

    #[test]
    fn a_coastal_grid_keeps_its_mask_and_floors_wet_cells_at_ten_metres() {
        let elevation: Vec<f64> = (0..W * H).map(|i| if i % W < 100 { -((i % W) as f64) } else { 5.0 }).collect();
        let g = regional(&Regional { basin: Basin::Coast { id_ok: true, w: W, h: H, cell: 1500.0, elevation: &elevation, bounds: &[150.0, -30.0, 154.0, -26.0] }, source: [50.0, 48.0], ..ideal(Shape::Shelf) }).unwrap();
        assert_eq!(g.cell, 1500.0);
        assert_eq!((g.depth[5], g.depth[50], g.depth[120]), (10.0, 50.0, 0.0));
        let dry_source = Regional { basin: Basin::Coast { id_ok: true, w: W, h: H, cell: 1500.0, elevation: &elevation, bounds: &[150.0, -30.0, 154.0, -26.0] }, source: [130.0, 48.0], ..ideal(Shape::Shelf) };
        assert!(regional(&dry_source).unwrap_err().contains("ocean"));
    }

    #[test]
    fn the_sea_fills_inward_from_the_open_edges_only_where_the_ground_is_below_the_level() {
        // 6 x 3: ground rises from the east edge; a hollow at x = 0 is cut off by a ridge at x = 2
        let bed: Vec<f64> = (0..18).map(|i| match i % 6 { 0 => -3.0, 1 => 1.0, 2 => 4.0, 3 => -1.0, 4 => -2.0, _ => -3.0 }).collect();
        let d = connected_water_depth(&bed, 6, 3, 0.0, &[Edge::East], None).unwrap();
        assert_eq!(&d[0..6], &[0.0, 0.0, 0.0, 1.0, 2.0, 3.0], "the hollow behind the ridge stays dry");
        let both = connected_water_depth(&bed, 6, 3, 0.0, &[Edge::East, Edge::West], None).unwrap();
        assert_eq!(both[0], 3.0);
        let mut valid = vec![1u8; 18];
        for row in 0..3 { valid[row * 6 + 4] = 0; }
        assert_eq!(connected_water_depth(&bed, 6, 3, 0.0, &[Edge::East], Some(&valid)).unwrap()[3], 0.0, "a masked cell blocks the sea");
        assert!(connected_water_depth(&bed, 6, 3, 0.0, &[], None).unwrap_err().contains("Invalid"));
    }

    #[test]
    fn the_idealised_estuary_has_a_separate_lake_and_perturbs_only_the_source_waterbody() {
        let e = Estuary { amplitude: 1.0, width: 0.3, source: [38.0, 48.0], absorbing: false, tide: 0.0, roughness: 0.025, lake_level: 1.0 };
        let g = estuary(&e).unwrap();
        assert_eq!((g.cell, g.method), (25.0, 2));
        assert!(g.depth[22 * W + 128] > 1.0, "the lake holds water at its own level");
        assert!(g.eta[22 * W + 128] == 0.0, "the disconnected lake is not perturbed by an ocean source");
        assert!(g.eta.iter().any(|v| *v != 0.0));
        let lake = estuary(&Estuary { source: [128.0, 22.0], width: 0.15, ..e }).unwrap();
        assert!(lake.eta[22 * W + 120] != 0.0 && lake.eta[48 * W + 38] == 0.0, "a source in the lake makes a seiche without waking the ocean");
        assert!(estuary(&Estuary { source: [120.0, 48.0], ..e }).unwrap_err().contains("water"));
        assert!(estuary(&Estuary { roughness: f64::NAN, ..e }).unwrap_err().contains("Invalid"));
        assert!(estuary(&Estuary { source: [38.5, 48.0], ..e }).unwrap_err().contains("Invalid"));
    }

    fn scene() -> (Vec<f64>, Vec<u8>) {
        // a 4 km bay: sea to the east of x = 80, land to the west, masked cells at the top-left corner
        let elevation: Vec<f64> = (0..W * H).map(|i| if i % W >= 80 { -4.0 } else { 3.0 }).collect();
        (elevation, vec![1; W * H])
    }
    fn local_with<'a>(elevation: &'a [f64], valid: Option<&'a [u8]>, extent: &'a [f64], coupled: bool) -> Local<'a> {
        Local { terrain: LocalTerrain { id_ok: true, w: W, h: H, cell: 25.0, valid, elevation, extent, sea_edges: &[Edge::East] }, amplitude: 1.0, width: 0.3, source: [140.0, 48.0], absorbing: true, tide: 0.0, roughness: 0.025, coupled }
    }

    #[test]
    fn a_local_scene_starts_with_a_pulse_or_at_rest_when_a_regional_wave_will_drive_it() {
        let (elevation, valid) = scene();
        let extent = [0.0, 0.0, 4000.0, 2400.0];
        let g = local(&local_with(&elevation, Some(&valid), &extent, false)).unwrap();
        assert!(g.depth[48 * W + 140] == 4.0 && g.eta.iter().any(|v| *v != 0.0) && g.absorbing && !g.coupled);
        assert!(g.depth[48 * W + 10] == 0.0 && g.eta[48 * W + 10] == 0.0);
        let driven = local(&local_with(&elevation, Some(&valid), &extent, true)).unwrap();
        assert!(driven.eta.iter().all(|v| *v == 0.0) && !driven.absorbing && driven.coupled, "still water, no sponge: the forced signal would be damped");
        // refusals
        assert!(local(&Local { source: [10.0, 48.0], ..local_with(&elevation, Some(&valid), &extent, false) }).unwrap_err().contains("connected bay water"));
        assert!(local(&local_with(&elevation, Some(&valid), &[0.0, 0.0, 4000.0, 2500.0], false)).unwrap_err().contains("Invalid local"));
        let mut nan = elevation.clone();
        nan[0] = f64::NAN;
        assert!(local(&local_with(&nan, Some(&valid), &extent, false)).unwrap_err().contains("Invalid local"), "a NaN where the mask says there is ground");
        let mut masked = valid.clone();
        masked[0] = 0;
        assert!(local(&local_with(&nan, Some(&masked), &extent, false)).is_ok(), "...but fine where the mask says there is none");
        assert!(local(&local_with(&elevation[1..], Some(&valid), &extent, false)).unwrap_err().contains("Invalid local"));
        assert!(local(&Local { tide: 3.0, ..local_with(&elevation, Some(&valid), &extent, false) }).unwrap_err().contains("Invalid local"));
        // a tide covers low ground that the scene's land mask treats as dry
        let high = local(&Local { tide: 1.0, ..local_with(&elevation, Some(&valid), &extent, true) }).unwrap();
        assert!(high.depth[48 * W + 140] == 5.0);
    }
}
