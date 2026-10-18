# Precomputed per-step timeline frames

## Problem

Playback still does per-step wasm work on the main thread: each
`showTimeStep` runs `F.waveSurface` + a slim `F.inundate` (fast on the
biggest grids now, but not free) before `drawMap`/`drawStats`. On slow
devices the wasm share is the playback floor.

## Research

- The worker's `floodTimeline` op already computes, per step: wet/deep
  bitsets (`wetBits`, `deepBits`, `wordsPerStep`), `firstWet`,
  `lastDeep`, `wetCount`, `gauge` levels — the *shape* of the flood
  over time is already computed in the worker and transferred once.
- The main thread additionally derives, per step, the actual water
  SURFACE (`waveSurface` → wse scratch) so `inundate` can produce
  per-cell depths for colouring and the profile. This is the duplicated
  work noted in `worker-resident-analysis-design.md` ("unchanged
  deliberately").
- Depth colouring reads `state.run.depth`; stats read wet/deep counts
  (available from the worker's arrays).

## Design

1. **Worker precomputes depth frames.** New op (or extend
   `floodTimeline`) that, for every step, runs `waveSurface` +
   `inundate(slim)` inside the worker and encodes each step's depth
   field compactly: depths quantised to u8 centimetres with a per-frame
   scale (max depth usually < 2.55 m → one byte per wet cell) —
   `frames: [ArrayBuffer]` (one per step, ~N bytes each), transferred
   once with the rest of the timeline result. Cost: the same total wasm
   work as today's playback, but off the main thread and pre-paid
   before playback starts.
2. **Main thread decode.** `showTimeStep(k)` becomes: pull frame k,
   expand u8→depth into the scratch (or keep u8 and quantise the colour
   ramp — colour bands are coarse enough that u8 depth is
   indistinguishable), skip wasm entirely. `state.run` for a step is
   rebuilt as a shallow object {wet bits→wet array? } — colouring and
   property checks need wet/depth per cell; expand lazily on first use.
3. **Memory budget.** N bytes × steps (e.g. 1.78 M cells × 75 steps ≈
   130 MB raw) is too much to hold uncompressed for big grids — keep
   the per-frame ArrayBuffers compressed with the browser's
   CompressionStream ('deflate') (~10:1 on mostly-zero water fields)
   and inflate lazily, keeping only the current + next frame hot.
   Fallback: no CompressionStream (older Safari) → decode on demand
   from the worker each step (current behaviour).
4. **Interaction with worker-resident analyses**: the frames are
   computed against the resident handle — no new data transfer into the
   worker.

## Failure behaviour

- Worker missing / engine unavailable: today's main-thread per-step
  path stays as the fallback (it is exactly the current code).

## Test plan

- Parity: frame depth quantisation vs the Rust reference run for the
  same steps (checksum battery, tolerance = quantisation step).
- Node: decode round-trip; memory-cap path (frame eviction).
- Manual: playback on the largest area — no per-step wasm on the main
  thread (devtools profile), no stutter at integer-zoom crossings.

## Effort

L — wasm bridge + worker op + decode/eviction machinery; gated behind
the existing timeline feature flags.
