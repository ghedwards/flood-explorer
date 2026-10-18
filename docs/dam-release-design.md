# Dam-release scenarios

## Problem

Releases from Wivenhoe/Somerset dominated the 2011 and 2022 lower-
Brisbane floods, but the 2D solver accepts a single inflow point (the
selected gauge's cell). Users can't ask "what does the river look like
when the dam lets go of X?".

## Research

- Dam **locations** ship with the app (`data/national/storages.geojson`
  in the SW shell); the water-history annotation shows the build tracks
  263/303 dam storage records.
- All BoM data reaches the page as **build-time snapshots** from the
  pipeline binary (`flood national` → `readings.json`, storages; see
  `.github/workflows/build.yml` ~115) — there is no live WDO client.
  Storage-volume time series should extend that same snapshot so the
  release estimate works offline too.
- Solver input today: `inflow_cell: Option<usize>` + scalar
  `inflow_m3_s` (`rust/flood-core/src/inertial.rs` ~16), validated
  against the terrain's active non-boundary cells. One inflow per run.

## Design

1. **Solver: inflow list.** Replace the single
   `(inflow_cell, inflow_m3_s)` with `inflows: Vec<(usize, f64)>`
   (sum into the existing source term per timestep; keep the scalar
   path as a one-element convenience for API compatibility). Update the
   Rust reference, wasm bridge, parity battery, and the new-optional
   validation (cells active, non-boundary, rates finite ≥ 0).
2. **UI: dam picker.** Tapping a dam on the map (already a report
   target) gains "Add release inflow" for the 2D controls: stores
   {name, cell, m³/s} in an inflow list rendered as editable rows
   (0–100 000 m³/s). Multiple dams accumulate.
3. **Starting-point estimate.** From the storage-volume history in the
   build snapshot: where a steep volume drop appears in a past window,
   pre-fill the field with the equivalent dV/dt and label it "≈ net
   release from the storage record (date range)". Manual edit always
   wins.
4. **Volume audit.** The status line's stored/added/balance reporting
   gains a per-inflow breakdown so a multi-inflow run is still
   auditable.

## Failure behaviour

- Dam cell on an invalid/boundary cell (tiny model window): the row is
  flagged in red with the solver's reason instead of failing the run
  opaquely.

## Test plan

- Rust: two-inflow mass-balance test (conservation to tolerance);
  validation tests for the list form.
- Parity: a two-inflow case added to the checksum battery.
- Node: picker row math (dV/dt pre-fill) is pure and tested.

## Effort

M — Rust change is contained; UI rides the existing dam pins.
