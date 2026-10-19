# 2D map polish — plan

Status: planned (2026-10-19). Evidence: `shots2d` run on main 9cbf680
(live site; images on the `shots-2d` branch). Implementation on a
`2d-polish` branch (pushes to `2d-*` build and screenshot it in CI).

## Findings

Map and flood rendering:

1. **The river channel reads as a black void.** In imagery mode only
   "newly flooded" cells are drawn (`floodLayerImage`: `run.wet[i] &&
   isFlood(i)`, i.e. not wet in the 0.5 m baseline run), and the channel
   cells come out as newly flooded in the darkest bands — most likely
   because the elevation model's channel surface (DEM-H / LiDAR records
   the water surface on the capture date) sits above the 0.5 m baseline,
   so the baseline never wets the channel. Through the town it looks like
   a hole in the imagery (03, 06). Verify on Rockhampton first (log the
   channel cells' dem vs the baseline level).
2. **Shallow water is near-white.** The <0.5 m band (#c9e7f7) looks like
   white paint or cloud over imagery, and fringes of single pale cells
   speckle the flood edges (03, 06).
3. **Blocky, noisy flood edges at street zoom.** At z15+ the 30 m cells
   are hard squares (crisp nearest-neighbour by design), and the
   hazard view shows checkerboard speckle along the banks (05).
4. **The flood stops dead at the model box** (06: orange rectangle with
   the flood cut along its north, south and east edges). The panel says
   so, but the map gives no cue at the edge itself.
5. **The gauge marker and the numbered place pin overlap** (03, 05, 06:
   a blue "1" on top of the orange "1").

Chrome and layout:

6. **Monospace message and key headline.** The toast ("River model
   ready…") and the key card's first line use the monospace font, so
   they read as debug output; the toast sits over the middle of the map
   (03).
7. **The key card sits bottom-centre, over the flood** (03–06), and on
   the Australia-wide view it shows the water-depth legend although
   there's no flood — while the gauge dots' colours (blue, green,
   purple, red, orange, brown) have no key at all (01).
8. **Phone: the map controls overlap the key card** (08: the 3D,
   fullscreen and locate buttons sit on top of the card's right edge;
   attribution text runs underneath it), and the Scenario sheet covers
   ~85 % of the screen so the flood can't be seen while adjusting it
   (09).
9. **Left panels take over a quarter of a laptop screen**, with long
   help paragraphs that stay after the first visit (01, 03).
10. **Dense gauge dots** on the east coast at country zoom overlap into
    a solid band (01).

## Plan

### Map rendering (viewer/app.js flood raster, styles)

- **Channel water**: treat the mapped river channel as normally wet for
  display — stream cells above the display threshold (the ones relief
  mode already tints with `WATER`), plus anything wet in the baseline —
  and draw them as a translucent neutral water tint (~35 % alpha) rather
  than as newly flooded depth bands; depth bands only for land newly
  flooded. Statistics ("land newly flooded") are unchanged — display
  only. Keep the hazard view's own rules. Add "river (normal level)" to
  the key.
- **Depth colours**: keep the band boundaries; shift the palette so the
  shallowest band is a clearly visible light blue at ~70 % alpha (e.g.
  #8fc7ea), not near-white, and make the overlay slightly translucent
  overall so streets show through shallow water. Same change in the 3D
  (coordinate with `viewer/terrain3d.js` `BANDS`) and the legend.
- **Edges**: at z ≥ 15 switch the raster to smooth (bilinear) scaling
  with a 1-cell alpha feather on the flood boundary, so streets-level
  views show a soft shoreline instead of 30 m squares; keep crisp cells
  below z15 where they read as data. Suppress isolated single wet cells
  smaller than the display threshold in the depth view (display only —
  stats unchanged).
- **Model edge**: where the flood touches the model boundary, draw that
  edge of the box as a dashed orange line with a small "model edge —
  flood continues?" label and make the box itself subtler (thin, 50 %
  opacity) elsewhere.
- **Markers**: offset the numbered place pin from the gauge marker when
  they're within ~20 px (or merge them: the place pin shows the gauge
  icon), so both stay tappable.

### Chrome

- **Typography**: the toast and key headline use the UI sans font
  (Archivo) — monospace only for numbers if wanted (tabular figures).
- **Toast**: top-centre but below the search bar, auto-dismiss after
  ~6 s (persistent only for errors), never over the gauge.
- **Key card**: dock it bottom-left on desktop (beside the panels,
  collapsible to a one-line chip) and make it context-aware: the
  Australia-wide view shows the gauge/dam dot colours (forecast,
  information, tide, river, dam, flooding status) instead of depth.
- **Phone**: key card collapses to a chip above the bottom bar; the map
  buttons stack above it with no overlap; attribution moves above the
  bottom bar or into About. Scenario sheet opens at ~45 % height with a
  drag handle to expand, so the flood stays visible while sliding the
  level.
- **Panels**: help paragraphs shown once (remembered), then collapsed
  to a "?" link; Places panel compact when it has one entry.
- **Gauge dots at country zoom**: smaller radius below z6 and draw
  order by importance (forecast/flooding on top), or cluster with
  counts below z5.

### Tests and verification

- Extend `tests/shots2d.js` (fix the streets basemap name; add a pose
  with the key collapsed, a phone pose with the Scenario sheet at
  half height, and a z16 pose for edge smoothing). Each push to
  `2d-polish` builds and screenshots; check each change before the next
  push.
- Existing `node --test` suites and the live smoke test must pass; the
  visual-regression baselines in `tests/visual/` will need updating
  (`UPDATE_VISUALS=1`) — note which ones changed and why.

## Phases

1. Colours and channel (findings 1, 2) — also update the 3D `BANDS`.
2. Edges, isolated cells, model-edge cue (3, 4).
3. Markers and typography/toast (5, 6).
4. Key card (desktop docking, context-aware Australia legend) (7, 10).
5. Phone layout (8) and panel help text (9).

## Phase 1 outcomes

**Finding 1, verified (run 39322369115, Rockhampton, 3.05 m at gauge,
`__floodChannelDiag`).** The premise was only partly right. Of 6,492
mapped channel cells (stream cells above the display threshold), 1,914
(29 %) are wet in the baseline run and 3,359 (52 %) are wet in the flood
run; 1,445 count as newly flooded, none deeper than 4 m (mean depth over
wet channel cells 2.4 m). The gauge sits at 0.03 m in the model, so the
baseline (0.3 m above that) does wet the main river through town. The
"black void" in the town reach is therefore mostly the Esri imagery's own
dark river with nothing drawn over it; the dark squares in the channel
(04b) are real 2-4 m newly flooded cells at the bank edges. So channel
cells are not mis-banded as the finding assumed.

Display change made: flood depth bands are untouched for flooded cells
(statistics and what counts as flood are unchanged); channel cells and
baseline-wet water that are *not* drawn as flood now get a light neutral
tint (~35 % alpha) over imagery, so the river reads as water rather than
a hole, and the key says "River (normal)". Relief mode is unchanged.
Palette: the 2D bands now use the 3D view's colours (BANDS3D, shallow
`#3f9ae0` at ~70 % alpha, the rest ~90 %), replacing the near-white
`#c9e7f7`; `BANDS` in terrain3d.js, the legend swatches and `DEPTH_STOPS`
move together (tests/terrain3d.test.js checks 2D = 3D).

## Out of scope

The flood engine and its statistics, new layers, basemap changes.
