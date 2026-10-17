# Porting Hydrology into flood-core — Design

## Goal
Unblock client-side GLO-30+hydrology by implementing the six hydrology steps
in `flood-core` (no external deps), matching the pipeline's `flood hydrology`.

## Steps to port (from README)
1. **Breach depressions (least cost)** — carve through embankments/bridges.
2. **Fill depressions** (fix flats) — make flats drain.
3. **D8 pointer** — flow directions.
4. **D8 flow accumulation** — upstream area.
5. **Extract streams** — stream network from accumulation threshold.
6. **Elevation above stream (HAND)** — height above nearest drainage.

## Approach
- Implement each as a pure function in `flood-core` (new module `hydro_port.rs`
  or extend `hydro.rs`), operating on `Grid` (dem, valid, w, h, cell).
- Match the Whitebox tool semantics (verified by `tests/parity` and
  `flood compare-hydrology`).
- Add unit tests comparing output to reference rasters from the pipeline.
- Expose via `flood-wasm` as wasm ops for browser use.

## Effort
- D8 pointer: ~1 week (handling flats, nodata, edges).
- Fill depressions: ~1 week (priority-flood algorithm).
- Breach: ~2 weeks (least-cost path through barriers).
- Flow accumulation: ~3 days.
- Streams + HAND: ~3 days.
Total: ~5 weeks for a correct, tested port.

## Status
Not started. Design pending.

## Refinement toward Whitebox parity
The six algorithms above are first-cut proofs of concept. To reach parity with
the pipeline's `flood hydrology` (verified by `flood compare-hydrology`), each
needs:
1. Replace the simplified algorithm with the exact Whitebox semantics
   (priority-flood with flat resolution, least-cost breach via Dijkstra,
   flow-path-based HAND).
2. Run `flood compare-hydrology <reference> <candidate>` against the pipeline's
   six rasters to confirm pixel-exact match (including NaNs, sample types,
   dimensions, geospatial metadata).
3. Add regression tests using the pipeline's reference rasters as fixtures.

This requires the pipeline's reference rasters (dem.tif, d8.tif, etc.) which
are not available in this environment. The algorithms are ready for refinement
once reference data is available.
