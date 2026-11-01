# Visual regression in CI

Implemented 1 November 2026. The [baseline guide](../tests/visual/README.md)
describes scenes, thresholds, reproduction, updates and failure artifacts.

## Current behaviour

`tests/visual-browser.js` serves the built viewer locally and exercises the
real Rust/WASM model with deterministic terrain, gauge, tile and impact
responses. Five reviewed PNGs cover national gauges, river depth, hazard,
impact roads and a timeline step. Unhandled external requests are blocked;
Linux baseline generation and verification also run with Docker networking off.

Missing expected images, viewport changes and pixel differences over the
scene threshold fail. Baselines are updated only with an explicit local
command; CI updates are refused. `tests/visual-detection.js` intentionally
hides the flood layer and requires the normal runner to report a river-depth
image mismatch, proving that a blank overlay cannot pass unnoticed.

The Browser checks workflow builds and compares these scenes and uploads
actual, expected and diff PNGs on failure. Live smoke screenshots remain
separate diagnostics: changing imagery/readings are not baseline inputs.

## Scope and remaining work

Captures cover map compositing; floating UI, tooltips and controls are hidden
only for screenshots. Panel layout, real-phone interaction and live service
availability retain their own tests/manual checks. Add further scenes when
new rendering behaviour warrants coverage, using deterministic fixtures and
reviewed expected images rather than automatically accepting the first capture.
