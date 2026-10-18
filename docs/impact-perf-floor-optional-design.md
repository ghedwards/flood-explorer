# Impact: reusable compute + optional floor height + optional auto-refresh

## Problem

`computeImpact()` is O(buildings + road edges) with a BFS over the road network.
It is triggered automatically on every scenario change (250 ms debounce), every
timeline step (150 ms), and every floor-height slider step — so once counted,
it re-runs the entire computation repeatedly. Also, the "water above floor"
and damage numbers assume a floor height slider (default 0.3 m) though measured
floor-heights data doesn't exist yet; users without floor info get a number
built on a guess.

## Design

Three changes, one control flow:

1. **Run-scoped cache.** `computeImpact` memoises everything that depends only
   on the impact data (`d`) and the model run on `d.cache = { a, run, base }`
   (identity-compare, mirroring `state.hazard`). `base` holds building depths
   (`bDepth`), cell/bFlood/flag arrays and the whole roads/isolated/people/
   SA1/SA2/sites result. Per-call only the O(nB) floor loop re-runs
   (over-floor + damage from `bDepth`); no `cellOf`, no BFS, no network work.
   Runs replaced per scenario (as today) invalidate naturally; timeline steps
   with a new run each step still recompute unless (3) opts out.
2. **Floor height optional.** New `#floorUnknown` checkbox ("No floor height
   known — skip water-above-floor and damage"). Checked disables the slider,
   `floorH` becomes `null`, and `overFloor`/`damage` come back as `null`
   (displayed "–"). Property check says water depth without an over-floor
   claim. Default unchecked → current behaviour preserved (test stubs lack the
   element, so their properties read falsy and stay "known").
3. **Auto-refresh optional.** New `#impactAuto` checkbox (default on = today's
   behaviour). Off gates the four automatic `renderImpact()` timers behind
   `maybeRenderImpact()`; a `#impactStale` hint shows "scenario changed —
   recount" keyed to the same area (first count stays manual as it already
   was).

### Layer reuse (the original motivation)

`renderImpact()` re-built every polyline, circleMarker and tooltip per call.
Now one draw-key `{ d, run, a, roadOn }` gates a rebuild; toggling the roads
overlay fires `overlayadd → renderImpact()` so the key change covers both
toggles. Marker sets (EVAC flooded rings, flooded key sites) rebuild with the
same key — tooltips too.

## Testing

- Existing census fixture (slices `computeImpact`) passes unchanged: its `$`
  stub returns the same object for every id, missing `checked` ⇒ floor known.
- New tests: floor unknown ⇒ `overFloor`/`damage` null; second call cache hit
  returns the memoised result even if inputs mutate mid-test.
- `node --test`, `eslint`, wasm parity unaffected (JS-only change).
