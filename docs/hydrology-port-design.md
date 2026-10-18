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

Reference rasters are now available in work/brisbane/ (dem.tif, d8.tif, acc.tif,
streams.tif, hand.tif, dem_breached.tif, dem_cond.tif). Validation can use
`flood compare-hydrology <reference-dir> <candidate-dir>`. The algorithms are ready for refinement
once reference data is available.

## Parity port: fill_depressions (2026-10-18)

The pipeline's `fill_depressions` resolves to `fill_depressions_core` in
wbtools_oss (pinned f0076c2), with `fix_flats=true`, Garbrecht–Martz flat
resolution (the default), `max_depth=inf`, and NO manifest defaults merging —
`ToolRegistry::run` calls `tool.run(args)` with exactly the args the pipeline
passes, so `flat_increment` is unset and the epsilon is computed by
`auto_small_increment_legacy`: diag=ceil(sqrt(2)·cell) (57 for 40 m cells),
max-elevation digit count scaling (`small = diag·10^-(15-digits)` ≈ 5.7e-11 on
Brisbane).

The faithful port (`fill_depressions_wbt` in flood-core) therefore reproduces:
1. interior-only pit detection (cells at image borders can never be pits,
   nodata neighbours suppress pitness), pits processed highest-first;
2. per-pit minimal heap expansion using std `BinaryHeap` with the same
   comparator (`other.elev.total_cmp(self.elev)`) and push order, so pop order
   is bit-identical to the reference implementation;
3. outlet recognition strictly via a *lower unvisited neighbour* (the spill
   plane is discovered by expansion, not from the border), then BFS raising
   everything below the spill level and tagging flats;
4. Garbrecht–Martz flat resolution: per flat component, BFS distances to lower
   edges and higher edges, `rank = dist_low·(max_high+1) + (max_high−dist_high)`,
   elevation = spill + small·rank.

First-cut `fill_depressions_simple` (4-neighbour border-seeded priority-flood,
no flats) measured 86.01% exact on dem_breached→dem_cond. The port should be
judged by the same harness (`validate_fill`).

## Parity validation results (2026-10-18)

Validated against the whitebox_next_gen reference rasters using the
`validate_*` diagnostic binaries in `rust/flood-pipeline/src/bin/` (717,255
valid cells on the Brisbane 891x805 grid):

| Algorithm | Match rate | Notes |
|---|---|---|
| D8 pointer | 99.95% (716,868/717,255) | Steepest-descent matches after aligning output to Whitebox pointer codes (1=NE, 2=E, 4=SE, 8=S, 16=SW, 32=W, 64=NW, 128=N). Residual 387 cells are flat/tie cases. |
| Flow accumulation | 100% | Bit-exact (maxerr 0.00) given the reference D8 pointers. |
| Extract streams | 100% | Threshold 625 on accumulation matches cell-for-cell. |
| HAND (flow-path) | 98.86% (709,082/717,255) | Rewrite: for each cell walk its D8 flow path to the first stream cell, HAND = z(cell) - z(stream cell). O(n) memoised path walk; replaced the O(n^2) Manhattan-nearest first cut. All non-NaN candidates are bit-exact; the residual 1.1% are cells our walk cannot resolve (drain off-grid/loop-guard) but the reference has values. |
| Fill depressions | 100% (717,255/717,255, maxerr 0.0) | Faithful port of `fill_depressions_core` with Garbrecht–Martz flat resolution and `auto_small_increment_legacy` epsilon (no manifest defaults are applied by the registry, so the epsilon comes from cell size + max elevation, not the 0.0001 manifest default). |
| Breach depressions | not yet validated | vs dem_breached.tif |

Key lessons:
- Whitebox pointer codes differ from the ESRI codes the viewer historically
  used; `d8_pointer_simple` now emits Whitebox codes directly so client output
  matches pipeline rasters, and `decode_whitebox_d8`/`encode_whitebox_d8`
  already handle the interop with the browser's internal `rec` directions.
- Establish the parity harness for the next two algorithms (fill, breach) by
  building a hand-off: run `fill_depressions_simple` on dem.tif and compare with
  dem_cond.tif; run `breach_depressions_simple` with max_dist=60 and compare
  with dem_breached.tif.
