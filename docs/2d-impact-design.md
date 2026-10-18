# Impact estimates for the local-inertial 2D model

## Gap

The 2D solver result is currently display-only: the UI blocks impact
estimates ("unavailable for the experimental coarse-grid 2D model"),
recorded-flood comparison, and per-property hazard. But the expanded run
(`FloodInertialGrid.expand`) already maps the solver's final fields back
onto the analysis grid with exactly the shapes the fast-model machinery
reads: `wet`, `depth`, `level`/`wse`, plus `vx`/`vy` velocities.

## What already works for 2D runs (no change)

- Stats panel, depth GeoTIFF/GeoJSON downloads (2d-final naming), report
  metadata (`model: 'local-inertial-2d-experimental'`), hazard colouring
  (`hazardNow()` reads `run.vx`/`run.vy`, which the 2D run carries).

## Changes

1. **Impact estimates** — remove the bail in `renderImpact`'s caller
   (`computeImpact` only reads `run.wet`/`run.depth` per cell; buildings,
   roads, isolation and SA1 people all flow unchanged). When
   `state.inertial` is set, append a caveat to the impact copy: depths are
   sampled from the solver's coarse (N m) grid — indicative, not
   per-building. `computeImpact` itself is untouched (it is a
   self-contained function sliced by tests).
2. **Recorded-flood comparison** — remove the bail; `scoreRun` compares
   `run.wet` with the recorded mask as for the fast model, with a caveat
   that it compares the 2D final wet extent on its coarse grid.
3. **Property report** — show the per-property hazard class (from
   `hazardClass` with the run's cell velocities) alongside the depth;
   keep "floods at gauge level X" unavailable (the 2D model is not
   gauge-driven) and keep the coarse-grid wording.

## Deliberately unchanged

- The printable report stays disabled for 2D (it is built around gauge
  levels and scenario readouts) — separate scope.
- The profile tool and timeline controls remain fast-model-only.

## Risk

The bails exist for honesty, not correctness — the numbers the fast model
produces for the same masks are produced the same way here. The coarse
cell size is the caveat to carry; wording keeps "experimental"/"indicative"
everywhere the 2D path surfaces a number.
