# Radar-to-2D nowcast: design sketch

Proposed 8 November 2026. **Phase 1 is implemented (see "Phase 1 status"
below); everything else is still a proposal.** It is the first priority in
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

## Phase 1 status (8 November 2026)

Built: `rust/flood-core/src/rainfield.rs` and a hook in `inertial.rs`.

- `RainField { step_s, frames }`: mm/h per solver cell per step, validated (step
  1 s to 24 h, rates 0 to 1000, every frame the grid's size, at most 16 million
  values). Frames hold for their step; the last one stays in force after the
  field ends, so end a storm with zero frames.
- `Solver::set_rain_field` replaces `rain_mm_h` and `rain_series`; steps end
  exactly at frame boundaries so a short burst puts down exactly its volume.
  Without a field the solver behaves as before.
- `rainfield::apply_losses` applies initial and continuing loss cell by cell
  with the same banking rule as `flash::effective_rain_series`; on a uniform
  field it reproduces that series (tested).
- `rainfield::moving_storm` builds a drifting Gaussian storm for tests and
  what-if runs.
- `rainfield::drifting_design_storm` turns the page's design storm into one
  drifting cell: the core gets the storm's rain, the centre crosses the middle
  of the area halfway through the rain, and the frame count and timing match
  `effective_rain_series`. A cell far wider than the area is the even storm
  (tested).
- `flood-wasm` `inertialStart` accepts either `rainFieldFrames` (frames x cells,
  flattened) with `rainFieldStepS`, or the drifting-storm parameters
  (`driftSigmaM`, `driftHeadingDeg`, `driftSpeedKmh`, with the storm's rain,
  hours and losses); the worker builds the field, so no large arrays cross the
  page. It reports the area's mean rain and runoff.
- **On the page** (flash flooding, method "2D water movement"): *Rain pattern*,
  *Even over the area* or *One drifting storm cell*, with the core radius,
  heading and speed. The status line says how much rain the area got on
  average against the core's, and how much ran off against the even storm.
  Covered by `tests/flash-2d.test.js` (through the wasm bridge) and
  `tests/impact-browser.js` (in a real browser).
- Tests: a uniform field equals the series path; rain lands only where the field
  says and water balances; a moving storm puts down exactly the field's volume;
  bad fields are refused.

Not done: interpolation between frames in time, radar,
nowcast and everything from phase 2 on.

## Phase 2 status and data-source findings (8 November 2026)

**Built, source-independent:** `rust/flood-core/src/radar.rs`.
- `resample`: a radar frame (mm/h on a north-up grid in the area's metric
  coordinates) to the solver's cells, bilinear at each cell centre, returning the
  share of cells the radar actually covered. Cells outside the radar are NaN.
- `observed_field`: equally spaced observed frames to a `RainField` (before
  losses). A frame that covers too little of the area, has the wrong size or no
  frames at all is refused; partly covered edge cells take the nearest value and
  are never silently zero, and rates are clamped to 0 to 1000 mm/h.
- `decode_legend`: RGBA image to rates through a source-supplied colour legend;
  transparent is no echo, unknown colours are an error, not a guess.
- Not yet wired to the broker, the page or WebAssembly: there is no source to
  feed it.

**Source checks run from the build sandbox** (what a source allows from the
broker's own host may differ):
- **Bureau of Meteorology radar by FTP:** the sandbox cannot reach FTP at all
  (connection refused on port 21), so the product directory, file format and
  terms are **unverified**. The Bureau's radar web pages have moved to a new
  address. Needs a check from the deployed broker host and a read of the
  Bureau's terms for automated use.
- **RainViewer free tier** (used today for the map overlay): reachable and
  returning frames, but its own published terms say the free API is for
  *personal and educational use*; it has past frames only (10-minute steps, about
  2 hours, **nowcast discontinued**), a single colour scheme (Universal Blue), zoom 7 at
  most and 100 requests per IP per minute. Tiles come back as coarse blocky
  images. It is not suitable as a public model input from a hosted broker.
- **Commercial nowcast API:** not checked; needs a key, price and terms.

**Bureau terms read on 8 November 2026** (from the Bureau's copyright page and
its data-feeds page; quotes are short, check the pages for the full text):
- Website content: the Bureau does "not allow you to use automated or manual
  techniques to hack, scrape or otherwise extract material from our site", and
  "restricted content ... such as radar images, high-resolution maps ... may be
  subject to a data licence agreement". Reproducing or redistributing pages for
  commercial purposes needs written permission.
- Anonymous FTP products (the route this document assumed): "free to access
  and are not for commercial use"; customers needing "support, service
  continuity and access to more secure Cloud (S)FTP services" are pointed to
  the Bureau's **Registered User Services**.
- The Bureau's weather API is marked "You must not use, copy or share it".

So a hosted broker that fetches Bureau radar and serves it, or a forecast made
from it, to the public is a redistribution the anonymous route does not clearly
permit, and scraping the radar web pages is excluded outright. No radar frame
was downloaded or kept for this check beyond fetching the pages above. The
anonymous-FTP file layout is still unverified (FTP is blocked from the build
sandbox).

**Decision (8 November 2026): a source-neutral endpoint.** The broker serves
frames from a folder the deployer supplies (`RADAR_DIR`, `rust/flood-broker/src/radar.rs`,
`broker/README.md`); it fetches nothing and bundles no source, and the manifest must
name the source, attribution and licence, which every answer repeats. Missing,
empty or stale stores are errors or flagged, never "no rain", and -1 in the
rates means missing. Whoever deploys it holds the data rights. Open question that
remains: what fills the folder, which needs the licence conversation above.

**Earlier decision text, kept for the record:** which source to use.
The options, in the order I would look at them: the Bureau's radar (free, needs
the access and licence confirmed), a commercial provider (works, costs money),
or running the nowcast ourselves on the Bureau frames (phase 3).

## Phase 3 status: the forecast step (8 November 2026)

Built and tested **on synthetic storms only**: `rust/flood-core/src/nowcast.rs`.

- `estimate_motion`: one motion vector for the whole frame from consecutive
  frames, by normalised cross-correlation over whole-cell shifts with a
  sub-cell parabola refinement. Pairs with too little rain or a poor match are
  skipped; with no usable pair the motion is zero and flagged `reliable: false`.
- `advect`: carries a frame forward along the motion (bilinear). Cells whose
  upwind place is outside the radar are NaN, never dry.
- `nowcast`: the latest frame carried to the middle of each step out to the
  horizon (up to 6 hours), with an optional exponential decay you choose
  (`f64::INFINITY` for none; not fitted to anything), and the share of cells
  known at each lead.
- `scaled`: lighter and heavier what-if copies of a forecast.
- The output goes straight through `radar::observed_field` to a solver rain
  field (tested end to end on synthetic frames).

What the tests show on synthetic Gaussian storms: speeds recovered to within
0.15 cell per frame including fractional ones; the forecast error at every lead
to one hour is under a quarter of persistence's; the peak stays within 15% of
the truth; noise of about 30% still gives the right motion; still rain reads as
still; dry frames give an unreliable zero, not an invented motion.

What they do not show: any skill on real rain. Real storms grow, split and
decay; one vector cannot describe rain moving in different directions; and
radar is noisy in ways a synthetic blob is not. A bug the tests did catch:
scaling a forecast turned unknown cells into the 1000 mm/h cap, because
`f64::min` ignores NaN. Next: the hindcast harness in the validation plan, which
needs real archived radar.

## Page-side client status (8 November 2026)

Built: `viewer/radar-client.js`, `rust/flood-core/src/live.rs`, a radar option in
the flash-flood 2D panel, and a `meta=1` query on the broker.

- **Option and gating.** *Rain pattern* gains "Live radar: last hour and a
  forecast", shown only when the broker's `/health` says a radar folder is
  configured. Controls: forecast ahead (30 min, 1 h, 2 h) and a what-if scale
  for the forecast only (30% lighter, as forecast, 40% heavier). The ground type
  sets the losses; the storm's own rain amount is not used.
- **Client.** Asks the broker for its coordinate system (`meta=1`), accepts only
  the MGA zones (EPSG:283xx and 78xx), asks for the area plus 60 km each way,
  and refuses, with a message and a code, anything that is not current,
  complete, evenly spaced and placeable: unconfigured, unavailable or empty
  (stated as not treated as dry), stale (over 30 minutes), gaps (any cell with
  no measurement), irregular spacing, an unsupported coordinate system, an area
  outside the radar, network failure.
- **Model.** `inertialStart` takes the frames and builds, in the worker, the last
  hour as observed then the forecast then dry frames, per-cell losses, on the
  solver's cells projected into the radar grid (north up, east right,
  checked). The run is as long as that storm.
- **What the page says.** Radar source and attribution, the newest picture's
  time and age, minutes observed and forecast, the rain's direction and speed (or
  that it could not be told), average observed and forecast rain over the area
  and what runs off, and the share of the area whose upwind rain was unknown
  (filled from the nearest known rain). The saved settings do not carry the frames.
- **Tests.** `tests/radar-client.test.js`: zone parsing, window maths, every
  error path, a live storm through the model with water conservation, and a
  contract test against the real broker binary (cropping, coordinate
  convention, empty store, outside, stale). `tests/impact-browser.js`: the option
  is hidden then shown, an empty store gives a message and no run, and a live
  storm runs in a real browser against a stand-in broker.
- **Convention fix.** The broker's grid now gives `y0` as the northing of the top
  edge with rows stepping south (it first said y grew southward, which is
  wrong for real coordinates).

Limits: the stand-in radar is synthetic, so nothing here shows skill on real
rain or that any real radar feed fits the format; the page refuses frames with
gaps rather than coping with them; one motion vector for the whole area; the
forecast stops at its horizon (dry after, as stated); a 60 km margin of a 1 km
radar is about 50,000 cells per frame to match.

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
