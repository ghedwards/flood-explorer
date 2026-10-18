# Client-side GLO-30 + Hydrology — Progress

## Phase A: Tile download prototype ✅
- Created `viewer/glo30-proto.html` to fetch a Copernicus GLO-30 tile from S3.
- Validates CORS and tile availability.

## Phase B: D8 in browser — BLOCKED

**Finding:** The `whitebox-wasm` crate (v0.6.1) exposes geotiff reading, lidar,
vector, and Moran's I — but NOT the hydrology tools (breach, fill, D8, flow
accumulation, streams, HAND). Those live in `wbtools_oss` / `whitebox-cli`,
which are not wasm-compatible.

**Options to unblock:**
1. Port the needed Whitebox hydrology algorithms (breach, fill, D8, flow acc)
   to Rust in `flood-core` (which has no deps) — significant effort.
2. Compile `wbtools_oss` to wasm (may fail due to filesystem/CLI deps).
3. Reimplement hydrology in JS (slow, but feasible for 20 km squares).

Recommendation: option 1 (extend flood-core with hydrology) keeps a single
Rust codebase and matches the existing pipeline.

- Requires compiling `whitebox-wasm` (git dep at f0076c2) to `wasm32-unknown-unknown`.
- Add a build step: `cargo build --target wasm32-unknown-unknown -p whitebox-wasm` (or a thin wrapper crate).
- Load the WASM module in a worker; expose `d8_pointer`, `fill_depressions`, etc.
- Validate: run D8 on the prototype tile and compare to the pipeline's d8.tif.

## Phase C: Full hydrology pipeline in-browser
- Port `flood hydrology` stages (breach, fill, D8, flow acc, streams, HAND) to a worker.
- Mosaic multiple tiles for a 20 km square; resample to target CRS/cell size.
- Cache intermediate rasters in IndexedDB.

## Phase D: UI integration
- Add toggle in on-demand flow: DEM-H (default) vs GLO-30 + hydrology.
- Fall back to DEM-H on failure.

## Blockers
- Whitebox-wasm browser build not yet set up.
- Tile mosaicking/resampling in JS needs a geospatial library (geotiff.js + proj4 or similar).
