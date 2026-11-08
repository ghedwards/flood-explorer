# Radar-to-2D nowcast: design sketch

Proposed 8 November 2026. Nothing here is built. It is the first priority in
[commercial-comparison.md](commercial-comparison.md): feed real radar rainfall into the
2D solver to answer "what will the rain on the radar do over the next 2 hours?".

Data sources, licences and quantitative claims about third-party services below
are **assumptions to verify** (marked `[verify]`), not checked facts.

## What exists today

- The 2D local-inertial solver (`rust/flood-core/src/inertial.rs`) takes rain
  as `Options::rain_series`, a single `Vec<f64>` of mm/h indexed by time
  (`series_step_s` per entry). The same value is added to **every cell**: rain
  is spatially uniform. This is the main thing that must change.
- `viewer/flash-2d.js` and `effective_rain_series` in `flash.rs` turn a design
  storm into 10-minute effective-rain steps by applying initial and continuing
  loss to one catchment-wide total.
- The recorded-storm replay (`docs/recorded-storm-design.md`) already feeds
  hourly **gauge** rainfall in as a series. It is the natural comparison for a
  radar path.
- The map's radar (`viewer/app.js`, RainViewer) is coloured image tiles, shown
  at zoom 7 or lower detail. It is a picture, not a rainfall field, and cannot
  drive a model.
- The broker (`rust/flood-broker`) already fronts services that block browsers
  and caches answers, and `flood-feeds` reads Bureau FTP products. The roadmap
  records that the Bureau website refuses GitHub's servers but FTP works.
- Cost reference: about 5 s for 2,160 steps on a 95 x 95 grid, scaling with
  cell count; up to 384 cells a side, a 200,000-step budget.

## Goal and non-goals

**Goal.** For a modelled area, show the deepest water, arrival times and hazard
for the **last 1 h of observed radar rain plus a 2 h extrapolated forecast**,
refreshed about every 10 minutes, clearly labelled as indicative.

**Non-goals (first version).** Neural-surrogate speed (a later phase), drainage
pipes, alerts, certified or approval use, and any claim of validation before
the hindcasts below pass.

## Pipeline

```
radar frames ──► broker ──► viewer worker
 (6-10 min)     /v1/radar     1. decode to mm/h grid
                              2. gauge bias correction
                              3. nowcast (advection) +2 h
                              4. resample to solver grid, per-cell losses
                              5. 2D solver: spin-up (observed) → forecast
                              6. depth / arrival / hazard maps + timeline
```

### 1. Radar ingest (broker)

- New endpoint, for example `GET /v1/radar?bbox=w,s,e,n&frames=12`, returning
  the last N frames cropped to the box as a small quantised grid (rain-rate
  class per cell, plus timestamps and radar site). Cache about 5 minutes, same
  pattern as `/v1/levels`.
- Source options, in order of preference:
  1. **Bureau of Meteorology radar images via anonymous FTP** `[verify]`:
     public, around 6-minute cadence, but delivered as colour-coded PNG with a
     published legend, so rainfall is recovered by class (a banded value, not a
     continuous one). Licence and terms of automated use must be checked.
  2. **A commercial nowcast API** (as the comparator uses): gives a ready
     forecast but is paid, closed and needs a key `[verify]`. Reasonable as an
     optional pluggable provider behind the same endpoint.
  3. **Model precipitation** (for example Open-Meteo 15-minute fields): coarse
     and not radar, so only a fallback for places without radar `[verify]`.
  RainViewer tiles are rejected as a model input (non-quantitative colours,
  limited detail, free-tier limits).
- The broker must report **age and completeness**. Missing, stale (say older
  than 30 minutes) or partial radar must show as "no live rain data", never as
  "no rain", matching how the tsunami bulletin panel treats missing feeds.

### 2. Gauge bias correction

Radar rain-rate error is large (reflectivity-to-rain conversion, beam height,
clutter). Use rain gauges already reachable through the broker and the Water
Data Online pipeline `[verify coverage and latency]`:

- Over the last 1 to 3 hours compare gauge totals with the radar at the gauge
  cells and compute a single mean-field multiplicative factor, clamped (for
  example 0.5 to 2.0), only when enough gauges and enough rain agree.
- Report the factor and the gauge count in the UI; skip the correction and say
  so when there is too little to use.

### 3. Nowcast (`rust/flood-core/src/nowcast.rs`, new)

Pure Rust so it runs in WebAssembly and in the Node tests:

- Estimate a motion field from the last 3 to 4 frames (optical flow; a
  block-matching or Lucas-Kanade pyramid is enough for a first version).
- Advect the latest frame forward by semi-Lagrangian stepping to +120 minutes
  at the frame cadence, with the motion field held constant.
- Honest limits: extrapolation cannot predict new cells, growth or decay;
  skill falls quickly after 30 to 60 minutes. Apply a documented decay or blend
  toward zero beyond the observed storm's lifetime only if hindcasts support it.
- Uncertainty: run low / central / high scenarios (rain scaled, for example,
  0.7 / 1.0 / 1.4, and/or motion perturbed) and show the spread rather than
  one confident map. Three solver runs triple the cost, so the first version
  may offer the central run and a "what if 30% heavier" run.

### 4. Solver change (`inertial.rs`)

Add a spatial rain field alongside the uniform series:

```rust
pub struct RainField {
    pub step_s: f64,            // seconds per frame, after interpolation
    pub frames: Vec<Vec<f32>>,  // mm/h per solver cell, one Vec per step
}
// Options { rain_field: Option<RainField>, .. }
```

- The viewer resamples each radar frame (about 1 km cells) onto the solver grid
  (bilinear for rate, then rescaled so the area-integrated depth is preserved).
  Interpolate between frames in time so a 10-minute step is not applied as a
  block, using the existing boundary-aligned stepping.
- Replace the per-step scalar `r` at `inertial.rs:142` with a per-cell lookup
  when `rain_field` is present; keep the series path unchanged and the default.
- **Per-cell losses.** Rain now varies by cell, so initial and continuing loss
  must be tracked per cell (a cumulative-infiltration `Vec<f64>`) instead of
  once for the catchment as in `effective_rain_series`. Reuse the same defaults
  and slider values so results stay comparable with the screening model.
- Antecedent wetness: default to the existing loss values; optionally reduce
  the initial loss using the observed rain of the previous hours, since the
  spin-up window already contains it.
- Mass balance: extend the existing rainfall-balance test to a spatially
  varying field (source volume equals field volume over water cells).

### 5. Run orchestration (viewer + worker)

- Start the solver at "now minus 1 h" with the observed frames, then continue
  into the forecast frames, so water already on the ground at "now" is
  represented. Record the state at "now" for the timeline and for a quick
  re-run when new radar arrives.
- Run in `inertial-worker.js`; reuse the existing grid sizes (96, 192, 384) and
  step budget. Expected cost is a few seconds to about a minute depending on
  grid, an assumption to measure `[verify]`; a result older than the next radar
  update is replaced, not queued.
- Cache by (radar frame time, area, settings) so reopening the page does not
  recompute.

### 6. UI

- A "Live storm (radar)" method next to the existing 2D storm controls.
- A timeline: observed (solid) vs forecast (hatched) segments, a frame
  scrubber, depth/arrival/hazard modes as today, and the radar overlay for the
  same times.
- Always show: radar time and age, bias factor and gauges used, the forecast
  horizon, and the standing text that this is indicative, not an official
  warning, with BoM/council warnings, 000 / SES 132 500 and "never enter
  floodwater".
- Failure states are explicit: no radar coverage, stale radar, broker down,
  solver budget exceeded. None of them may render as "safe".

## Validation plan (gates before anything is called a forecast)

1. **Unit tests.** Nowcast of a translating blob recovers speed and direction;
   zero motion leaves the frame unchanged; mass is preserved by resampling;
   solver volume balance with a spatial field.
2. **Hindcast harness.** For recorded events that already have gauge
   hydrographs and flood outlines (see `config/events.json`), replay archived
   radar through the same path and compare with the gauge-driven replay, the
   recorded outlines and satellite water (existing "check against" tools).
3. **Nowcast skill.** Score the +30 / +60 / +120 min rain fields against the
   later observed radar, against a persistence baseline. Report the horizon at
   which skill drops below persistence.
4. **Radar versus gauge.** Publish the bias factor distribution over the
   hindcast set, so users can see typical radar error.
5. Record every result and its limits in `docs/validation/`, in the repo's
   existing style (implemented does not mean validated).

## Phasing

1. **Spatial rain in the solver** with a synthetic moving storm, plus tests.
   Smallest, and useful on its own for "what if the storm sits over this
   catchment?".
2. **Radar ingest in the broker** and the decode, with the freshness reporting,
   and observed-only replay of the last hour (no forecast yet).
3. **Nowcast + bias correction + UI timeline**, behind an experimental label.
4. **Hindcast validation** and tuning; publish results.
5. **Speed**: train a surrogate on the solver's own output, and address alerts,
   as separate designs.

## Risks and open questions

- **Licence and access** to Bureau radar, or the cost and terms of a commercial
  provider, decide the whole data route `[verify before building phase 2]`.
- **Resolution mismatch.** Radar is about 1 km; the solver grid is 50 to 200 m
  over a 20 km area. Sub-kilometre rain structure is invented by interpolation,
  and the terrain is still 30 m, so street-level claims are not supportable.
- **Short-lived convective rain** is exactly what extrapolation handles worst.
- **Run time on phones.** The 384-cell grid may be too slow in the browser; a
  server-side runner through the broker is the alternative, at the cost of the
  no-server design.
- **Drains and pipes** are not modelled, so urban depths are likely high; say so
  next to every result.
- **Multi-radar / multi-area coverage**: areas that straddle two radars need
  compositing, deferred.
