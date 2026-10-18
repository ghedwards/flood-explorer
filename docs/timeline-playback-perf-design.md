# Timeline playback + water/relief overlay split

## Problem (from the perf audit)

One timeline step (350 ms interval) costs ~100–200 ms at 1.78 M cells
(`showTimeStep`): a fresh 8N `Float64Array(N).fill(NaN)`, a full `inundate`
re-run, `composeImage` which copies the 4N terrain buffer per draw
(28 MB), a redundant O(4N) pixel-count pass, and a full-grid **opaque** PNG
encode. The terrain part of that image never changes during playback — only
the water does — but it is re-encoded every step.

## Design

### Two overlays per area, exactly preserving the rendered result

Today one fused `ImageOverlay` per area comes out of `composeImage`:
- relief on: opaque terrain; flood pixels pre-blended into it
  (0.88·flood + 0.12·terrain; ocean/base-wet/stream water likewise; stream
  lines 0.9); `floodOpacity` fades the whole raster over the basemap.
- relief off: transparent image; flood cells **fully opaque** (the
  see-through comes entirely from the `floodOpacity` slider).

The split renders the same pixels with arithmetic the browser already does:

1. **Relief overlay** (`area.relief`), zIndex 5 under the flood raster:
   pure `terrainRGBA` (opaque, no water, no ocean, no streams). Encoded once
   per analysis (`state.terrain`); during playback it is never re-encodes.
   CSS opacity = `floodOpacity`.
2. **Water overlay** (`area.overlay`, as today): rebuilt per run/step from a
   persistent `ImageData` (no per-draw allocation or terrain copy):
   - flood-colour cells as today (depth/hazard/compare),
   - in relief mode additional `WATER` cells (ocean, base-wet-not-flood,
     stream lines at 0.9) with per-pixel alpha 0.88 — compositing
     `(0.88·water) over (opaque terrain)` reproduces today's pre-blend
     exactly,
   - in non-relief mode flood cells stay fully opaque and the terrain-only
     extras stay absent (today's look), and the overlays omit them.

`floodPixels` counting folds into the water compose loop (single pass,
counting flood-path cells only; relief mode of status keeps the historical
`-1`).

Scratch reuse: `state.reliefDirty` set when `state.terrain` rebuilds or
relief toggles; `drawGeoMap` re-encodes the relief base only when dirty.
Water keeps a persistent `ImageData` when the grid size is unchanged.

### Timeline per-step work

`showTimeStep` reuses one `state.wseScratch` `Float64Array` (`.fill(NaN)`
each step, no allocation) instead of `new Float64Array(N).fill(NaN)`;
the time slider gets rAF-coalesced scheduling like the scenario controls.

## Out of scope (follow-ups)

- wasm `inundate` bag trimming and scratch reuse inside `inundate` (item #2,
  protocol change — must not disturb parity).
- precomputed per-step depth frames in the worker (bigger redesign).
- drawStats skip during playback.

## Testing

- `node --test` (existing 50 + smoke semantics unchanged: `floodPixels`
  stays `-1` in relief mode).
- eslint clean; wasm parity exit 0 (JS-only change).
- Manual check: relief on/off with the same scenario renders identically
  (alpha-pre-blend equivalence is exact by construction).
