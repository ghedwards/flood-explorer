# Visual regression in CI

## Problem

DOM-level smoke tests can't see rendering. The bugs that escape are
visual: the "satellite island" (tiles silently missing), flood-layer
opacity/compositing regressions from the playback split, mark layers
that fail to draw.

## Research

- The CI smoke already runs **Playwright** (`tests/smoke_live.js`)
  against the deployed site in the `smoke-test / browser` job — the
  harness for screenshots is in place; nothing new to install.
- Screenshots in headless Chromium vary slightly across runs (font
  hinting, GPU flags) — comparisons need a tolerance, not equality.
- Keeping baselines in-repo works if they're few and small; they're
  updated deliberately with the change that alters them.

## Design

1. **Capture**: smoke_live gains a `snap(name)` helper —
   `page.screenshot({ clip })` of the map region (not the whole page,
   to keep panel text noise out), ~6 shots: initial view, river model
   drawn, depth colour mode, hazard colour mode, timeline mid-play,
   impact marks on.
2. **Compare**: `pixelmatch` (pure JS, no native deps) at a
   threshold (e.g. 0.1, ignore antialiasing); the helper reports the
   mismatch fraction against the baseline in
   `tests/visual/<name>.png`.
3. **CI behaviour**: missing baseline → capture and PASS (first run
   seeds); mismatch above tolerance → FAIL with the diff image uploaded
   as an artifact; an env flag `UPDATE_VISUALS=1` rewrites baselines
   and is the documented way to update them.
4. **Hydration control**: screenshots wait for the same readiness
   signals the smoke already uses (networkidle, model drawn flags) plus
   a fixed settle, and the worker hides the animated cursor/progress.

## Failure behaviour

- Playwright/PNG/CI flakiness shows up as occasional CI retries — keep
  tolerance conservative (catch layout-scale breaks and missing layers,
  not 1-px antialiasing drift).

## Test plan

- The visual job itself is the test; validate the harness by
  intentionally breaking a layer locally (hide the flood overlay) and
  confirming the run fails with a diff artifact.

## Effort

S — one helper, six capture points, one CI compare step.
