# Worker-resident analyses: cheaper timeline builds and calibration

## Problems (items #3 and #4 of the perf audit)

- Every timeline build posts the whole analysis object to the flood worker:
  a structured clone of ~30–45 MB on the main thread, followed by a fresh
  `load` upload of ~20 N bytes into the *worker's* wasm memory (its handle
  cache keys on object identity, and every clone is a new object).
- `fitRecorded` runs ~41 `inundate` calls on the main thread (the
  0.5 m scan from the river bed plus a 0.05 m refine), freezing the UI for
  seconds on the largest grids.

## Design

### Registry in the flood worker

After the worker's own `analyse` op, before replying (its reply *transfers*
the array buffers to the page, detaching the worker's copies), the worker
keeps:

- the wasm analysis handle via a newly exposed `FloodCore.handleOf(a)`;
- small snapshots the scoring needs that aren't inside wasm: `ocean`,
  `stream`, `W/H/cell/N` (2 N bytes).

Reply carries `key`. Keys are per-worker-instance: `workerGen` increments
each time the app creates the worker, and the app stamps the analysis with
`{ analysisKey, keyGen }`. Stale keys (worker was recreated, e.g. after
loading from `file:`) fall back to posting the full object.

### New worker op kinds

- **timeline** accepts `aKey`: the handler reconstructs a stub analysis
  from the resident handle (`FloodCore.byHandle(h)` registers a small
  object that `handleOf` recognises) and runs wasm's `floodTimeline`
  against it — no clone, no re-upload. Without a key the old path runs.
- **calibrate** (new): takes `{ aKey, s0, m: { near, flood }, bed }` and
  runs the whole level scan in the worker; returns best `{ lv, s }` only.

### One calibration implementation

`scoreRun` and the scan loop move from app.js into flood-core.js as pure
functions: `scoreRun(a, run, m)` (reads `a.ocean`/`a.stream`/`run.wet`) and
`calibrateLevels(scoring, s0, m, bed, run)` where `run(s0, lv) -> Run`
abstracts the engine. The worker passes the resident stub for `run` and
its snapshot for scoring; the app passes `state.a` and wasm `inundate`
(slim). The scan schedule (0.5 m sweep from `bed + 0.5`, 0.05 m refine
around the best) now lives in exactly one place.

### Unchanged deliberately

The timeline still re-routes internally in the wasm op, and the
main-thread `waveSetup` still builds the interactive wave for step
playback — eliminating that duplication means precomputed per-step frames
(explicit follow-up). `showTimeStep` keeps using the main-thread wave.

## Failure behaviour

- No worker (module workers unsupported), no engine, or stale key: the
  existing main-thread paths run (worker wasm candidate, or fitRecorded's
  scan with yields) — same numbers, just paid where they used to be.
- Worker calibrate errors reject and render as the existing
  "Couldn't compare" hint.

## Testing

- Battery: node tests (wasm engine), eslint, clippy/cargo test, parity vs
  Rust reference, wasm rebuild when rust changes (none planned in this
  step).
- New worker branches are exercised through the browser flows; automated
  coverage stays on the arithmetic (`calibrateLevels` is a pure function
  testable via `F.inundate`).
