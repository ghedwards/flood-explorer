# Map render path (perf audit item #5)

## Problem

Beyond the per-step wasm work (see `precomputed-frames-design.md`), the
remaining render costs are the DOM/SVG churn around the map: what
actually redraws when the scenario or step changes.

## Research (what redraws today)

- `drawMap()` (~1036) is called per step during playback. The flood
  layer itself is cheap by design after the playback split: the water
  overlay ImageData is rebuilt per step, the relief base is encoded
  once per analysis (`area.relief`).
- Every `drawMap()` **unconditionally** calls `renderModeLegend()` and
  `renderCompare()` — the latter rebuilds comparison HTML even when
  compare mode is off ("the street map is still opening" comment).
  That DOM work repeats ~every frame during playback for output nobody
  is looking at.
- `floodEdges` (~729) is not an outline tracer — it counts wet land
  cells on the four grid borders to warn that the flood reaches the
  model's edge. It runs only on scenario/area change, so it is *not* a
  per-step cost (an earlier draft of this note misread it as one).
- `drawStats(tl.s)` per step is real but small; SVG marks are keyed by
  `impactDrawn`/draw-key change detection (already good).

## Design (in expected value order)

1. **Guard the per-frame extras in `drawMap`**: `renderCompare()` only
   when compare mode is active (or its inputs changed);
   `renderModeLegend()` only when the mode/overlays changed. Both are
   pure DOM writes keyed on cheap state comparisons.
2. **`syncLayerLists` throttle.** Layer-list rebuilds on `zoomend`
   coalesce to one rAF (same treatment the hover text got).
3. **SVG → canvas for repeated marks.** Impact marks and gauges are
   small counts (fine as SVG); road segments during playback are the
   one growing set — if road cut sets exceed a few hundred segments,
   switch that layer to a canvas renderer (measure first; only if the
   profile shows it).
4. **Measure, then stop.** Profile before touching anything else; the
   playback split already removed the big costs. This item is finished
   when the devtools profile during playback shows only tile decode and
   compositing on the main thread.

## Test plan

- Existing 52 node tests + smoke; manual profile before/after each
  change (the smoke's timeline playback provides the reproducible
  scenario).

## Effort

S each, in the order above; item 3 is conditional on measurement.
