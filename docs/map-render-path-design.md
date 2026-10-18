# Map render path (perf audit item #5)

## Problem

Beyond the per-step wasm work (see `precomputed-frames-design.md`), the
remaining render costs are the DOM/SVG churn around the map: what
actually redraws when the scenario or step changes.

## Research (what redraws today)

- `drawMap()` (~1036) — the flood layer: the water overlay ImageData is
  rebuilt per step (fast by design after the playback split); the relief
  base is encoded once per analysis (`area.relief`). Remaining per-draw
  costs: `floodEdges(a, run)` — the outline tracing for the crisp flood
  edge — runs on run change (every step during playback, since
  `state.run` is replaced per step).
- `drawStats(tl.s)` per step; legend re-render on overlay/zoom events;
  `syncLayerLists` on zoom; SVG marks (gauges, impact marks, road
  segments) rebuilt on the `impactDrawn`/draw-key change detection (already
  keyed — good).
- Council Esri feature polygons already render via canvas (quick-wins
  commit).

## Design (in expected value order)

1. **Flood edges per frame, not per step.** During timeline playback,
   decouple the outline from the per-step run: compute edges on
   `requestIdleCallback` (or every 3rd step) rather than synchronously
   per step; the edge layer fades to the new outline when ready. The
   edge is cosmetic; depth colouring is the signal.
2. **Legend/sync throttle.** `syncLayerLists` and legend rebuilds on
   `zoomend` are cheap once but add up during pinch sequences; coalesce
   to one rAF (same treatment the hover text got).
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
