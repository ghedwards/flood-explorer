# Roadmap

Working backlog with links to design notes. Items are implemented one
design note at a time; a note is written before its code, and an approach
that breaks tests is reverted and redesigned.

## Shipped this cycle (continued)

- Evacuation route to centres — already built (`routeOut` Dijkstra with
  parent pointers, `drawRoute` polyline, persisted in property snapshots
  and shown in the report); no new code needed.
- Dam releases on the 2D solver — time-varying inflow series in Rust +
  wasm bridge + app wiring (`buildInflowSeries`); release box drives it.
- Visual regression in CI — `snap()` helper + pixelmatch against
  `tests/visual/` baselines (seed on first run, UPDATE_VISUALS rewrites).
- Basemap failover, arrival times, map render path, keyboard/a11y,
  offline Overpass fix.

## Backlog (researched, notes in this folder)

| # | Item | Note | Effort | Value |
|---|------|------|--------|-------|
| 1 | Arrival times in the Places list | `arrival-times-design.md` | S | M (property flow already has it) |
| 2 | Dry-route to evacuation centres | `evacuation-route-design.md` | M | H |
| 3 | Basemap failover prompt | `basemap-failover-design.md` | S | M |
| 4 | Storms replayed from recorded rain | `recorded-storm-design.md` | L | H |
| 5 | Dam-release scenarios | `dam-release-design.md` | M | H (2011/2022 stories) |
| 6 | Offline field mode: close the Overpass gap | `offline-field-design.md` | S→M | H for field use |
| 7 | Keyboard + accessibility pass | `keyboard-a11y-design.md` | M | M |
| 8 | Visual regression in CI | `visual-regression-design.md` | S | M (catches render bugs DOM tests miss) |

## Also known

- Precomputed per-step timeline frames — `precomputed-frames-design.md`
  (biggest remaining playback win; worker precomputes quantised depth
  frames, main thread decodes).
- Map render path — `map-render-path-design.md` (last of the perf
  audit's Top 5; measure-first, four small items).
- HAND flat-cell fallback and D8 tie documentation —
  `hand-d8-polish-design.md` (D8 docs-only; HAND fallback deferred
  until a HAND band ships — `hand_simple` is defined but unused).
- Blocked: measured floor heights and IFD design rainfall (no open data).
