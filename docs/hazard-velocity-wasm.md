# 2D hazard velocities in the wasm engine

## Problem

Since the inertial solver shipped velocities (`run.vx`, `run.vy`), the JS
engine (`flood-core.js hazard`) uses them for the hazard class, but the
wasm bridge silently ignores them: `flood-wasm.js hazard(a, run)` drops the
third/fourth arguments, and the wasm `hazard` op never parsed them. The
viewer runs the wasm engine, so the feature was depth-only there — a
correctness gap, not a perf one.

## Fix

- wasm `hazard` op parses optional `vx`/`vy` bags and calls
  `hazard_with_velocities` (already in `flood-core`; `hazard` is just the
  `None/None` case).
- `flood-wasm.js hazard(a, run, vx, vy)` forwards the arrays when both are
  present — same sparse-cell rule as the JS impl (indices beyond the array
  length fall back to the Manning estimate).
- Parity: `tests/parity.js` calls `hazard` without velocities → bit-exact
  checksums unchanged.
- New `core.test.js` case asserts the provided velocity is used (vel ≈
  1 m/s at a wet cell with vx=1, vy=0) in both engines, since CI runs node
  tests under `FLOOD_IMPL=wasm`.

## Testing

- `cargo test`/clippy, wasm rebuild, node tests js + wasm, parity exit 0.
