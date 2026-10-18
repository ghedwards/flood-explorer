# Remove the JavaScript flood model; wasm-or-refuse

## Decision

The viewer runs the wasm engine; flood-core.js's model functions
(analyse, streamSurface, inundate, stats, flashFlood, burnDefences,
waveSetup, waveSurface, floodTimeline, hazard, compareRuns,
parseSimpleTiff) are ~1,200 lines duplicating the Rust model that were
only ever reachable as a silent fallback (`?engine=js`, per-call
try/catch). The bit-exact parity work already proved the Rust model
faithful, so the duplicate is dead weight in the bundle and a second
implementation to keep in sync (the 2D hazard velocities gap was exactly
this divergence).

## What stays in flood-core.js (utilities, not the model)

- `syntheticTerrain` (+ `mulberry32`), fixture generator for tests/parity
- `encodeWhiteboxD8`, `mainStem`, `snapToStream` — grid tools with no wasm
  bridge
- `mergeRuns`, `lineCells`, `hazardClass` — small helpers with no wasm
  bridge that app.js and tests call directly
- `stormUplift`, `parseAsciiGrid`, `downsample`, `cleanNodata` — data
  ingestion utilities (no wasm bridge)
- `parseSimpleTiff` JS version is removed: the wasm op covers the GA
  fast path and both call sites already fall back to the general
  GeoTIFF library on any parse failure.

## Failed-load behaviour

`install()` keeps the `flood:wasm-error` event but no longer falls back:
- no `?engine=js` escape hatch (removed);
- no WebAssembly support or a failed `flood.wasm` fetch → `engine:
  'error'` and the event fires;
- the per-call try/catch JS fallback disappears — wasm calls throw to the
  caller like every other non-recoverable engine error (already the rule
  for the Rust-only solvers).
- app.js listens for the event and, after `FloodCoreReady`, checks the
  engine: anything but `rust` shows a blocking card — "this browser can't
  run the flood model" with likely causes and a reload button — and the
  scheduler refuses to build anything, so no code path hits an undefined
  model function.
- flood-worker tags error replies with the engine so a wasm problem inside
  the worker surfaces the same card.

## Tests / CI

- tests/model.js: engines become wasm (default) | native; the wasm file
  must exist (build with `node scripts/build-wasm.js` locally — the error
  message says so); `FLOOD_IMPL=js` is rejected.
- The JS-vs-Rust parity legs in build.yml and hydrology-compare.yml are
  replaced by wasm-vs-Rust-reference comparisons
  (`FLOOD_IMPL=wasm node tests/parity.js work-parity-rust.txt`), which is
  the wasm-bridge check that still catches protocol regressions.
- `cargo run --example parity` remains the generator of the reference
  checksums.

## Consequence accepted

There is no longer a second implementation to cross-check Rust against.
Protection for the hydrology math comes from the Rust reference
checksums, the wasm-bridge comparison above, and the benchmark rasters
that produced the fill/breach/acc/D8/HAND parity results.

## Testing

- `cargo test --workspace` + clippy; wasm rebuild; `node --test
  tests/*.test.js` (defaults to wasm now); parity vs a fresh
  Rust-reference run; eslint.
