# Wasm bag protocol: trim run payloads to what callers use

## Problem (from the perf audit)

Every `inundate` result ships a fixed 18N-byte bag (wet 1N + depth 4N +
level 4N + wse 8N + onPath 1N), and every `stats`/`hazard`/`compareRuns`
call carries whole runs back INTO wasm memory. Per-frame slider drags pay:

- 18N out per run, when the render path only reads wet, depth and level;
- 9–18N in per `stats` call (run + baseline), even though the stats math
  uses only wet and depth;
- a separate typed-array allocation + wasm-memory copy per bag field.

## Usage audit (why each field can be trimmed)

- `run.wse` — read only by `drawProfile` (`app.js:2384-2385`), which
  early-returns unless the profile panel is open and river/both mode is
  active. Timeline, impact, GeoTIFF, hazard and stats paths never touch it.
  The flash run's `wse` is discarded by `mergeRuns` and the profile bails
  in flash mode — never consumed.
- `run.onPath` — produced by the wasm bridge (`put_run`), never read by
  any consumer (the stream-surface op has its own `onPath` payload; inertial
  builds its own; `mergeRuns` passes `r1.onPath` through). No JS reads it.
- `run.level` — read by `describe()` (hover), hazard's velocity slope and
  merge. Stats and compare only use wet/depth.

## Design

Opt-in slimming, defaulted OFF so the protocol stays compatible with
existing tests and parity checksums:

- Rust `put_run(o, r, slim)`: when the JS call passes a `slim` marker, skip
  `wse` and `onPath`; otherwise the full shape ships (unchanged default).
  `inundate`/`flashFlood` handlers read `b.has("slim")`.
- JS wrapper `toRun(out, slim)` omits the missing fields; `inundate(a, s,
  opts)` and `flashFlood(a, o)` accept `{ slim: 1 }`.
- `runBag(r, p, withLevel)`: stats and compareRuns stop carrying `level`
  (Rust's `run_of` already defaults missing level to NaN); hazard keeps it.
- app.js passes `slim` at every call site except `drawProfile` needs:
  base and riverRun build with `slim: !wantWse` where
  `wantWse = !$('panel-profile').hidden`; fitRecorded levels, timeline
  steps and the property-check point all get `slim`; flash calls always
  slim. The base-run cache is invalidated when it was built slim but the
  profile is now open.
- `drawProfile` guards `if (!run.wse || (base && !base.wse)) { schedule();
  return; }` — opening the profile panel after a run built without the
  waterline triggers one rebuild instead of crashing on `undefined`
  indexing.
- `readBag`: one span copy for large bags, then typed-array views for
  fields whose byte offset satisfies alignment; misaligned fields fall
  back to the copy path. Fewer allocations, same bytes.

JS impl (`flood-core.js`) keeps building `wse`/`onPath` — the JS engine
derives `level` from `wse` during the solve, so nothing changes there.

## Testing

- `cargo test --workspace`, `cargo clippy` clean.
- `node --test tests/*.test.js` (js), then wasm rebuild
  (`node scripts/build-wasm.js`) + `FLOOD_IMPL=wasm` node tests — the CI
  (`hydrology-compare`, `build`) runs node tests under wasm, so the slim
  default must not change unslimmed shapes.
- `FLOOD_IMPL=wasm node tests/parity.js` exit 0 (checksums use the full
  shape; app-side trims never reach it).
