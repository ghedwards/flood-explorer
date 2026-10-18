# Roadmap

Working backlog with links to design notes. Items are implemented one
design note at a time; a note is written before its code, and an approach
that breaks tests is reverted and redesigned.

## Shipped this cycle

- Perf Top-5 (playback split, bag trim, worker relocation, timeline
  round-trip; render path intentionally last) — notes: `timeline-playback-perf-design.md`, `wasm-bag-trim-design.md`, `worker-resident-analysis-design.md`.
- wasm-only model + JS removal — `js-impl-removal-design.md`.
- 2D hazard velocities — `hazard-velocity-wasm.md`.
- Impact for the 2D solver — `2d-impact-design.md`.
- Map feel: sub-pixel wheel zoom, basemap tile-failure notice.

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
  `hand-d8-polish-design.md` (small accuracy items).
- Blocked: measured floor heights and IFD design rainfall (no open data).
