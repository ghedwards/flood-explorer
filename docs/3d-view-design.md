# Experimental 3D flood view (three.js)

## Problem

Everything the user sees is plan view: flood depth colours over a
satellite/street basemap, with a profile cut for elevation. Two things a
map cannot show well are (1) how high the water sits on the banks
(river surface vs ground), and (2) the shape of the terrain the flood
wraps around. An orbitable 3D view with an exaggerated vertical scale
shows both, and is cheap for us because every input already exists
client-side.

## Research

- `state.a` already carries the full model: `dem` (Float32, m AHD),
  `valid`/`ocean` masks, `cell` (m), `W`/`H`/`N`.
- `state.terrain` is the hypsometric + hillshade RGBA render used by the
  relief mode — reusable as vertex colours with zero extra compute and
  perfect visual consistency with the 2D relief.
- Water: `state.run.wse` (surface elevation) + `wet` mask + `depth`.
  During timeline playback the u8 `depthFrames` (one byte per cell, per
  frame scale `depthFrameMax[k]`) reproduce `wse = dem + q/255*maxD`
  exactly as `showTimeStep` does — so a 3D scrubber needs **no wasm**
  per step, just the same u8 decode.
- three.js r186 (~150 KB gzip renderer+controls) imports as a separate
  vite chunk via dynamic `import()`; the offline-shell plugin already
  lists every emitted chunk in the SW's `BUILD_ASSETS`, so 3D works
  offline for free. MIT licence — the existing licence-file plugin
  covers it automatically.
- Vertical exaggeration is mandatory: terrain spans 10–100+ m while
  flood depths are 0.5–4 m. `mesh.scale.y` applies it without a rebuild.
- Leaflet stays untouched: 3D is an overlay panel, not a map mode.

## Design

1. **Pure helpers** (`viewer/terrain3d.js`, no three dependency, node-
   testable): `decimateStep(n, maxSide)` (skip factor, ≤ 560×560
   samples), `terrainMesh(a, k)` → { positions (x=east, y=metres AHD,
   z=north-negative), colors (from `terrainRGBA`), indices }, and
   `waterMesh(a, wse, depth, k)` → same shape for wet cells only.
   Invalid cells drop out of the index grid.
2. **Scene glue** (`viewer/scene3d.js`, lazy-imported): WebGLRenderer +
   OrbitControls in a fullscreen overlay; terrain mesh
   (`scale.y = exaggeration`, default 12×, slider 1–40×); water mesh
   translucent with the 2D depth-band colours; render-on-demand rAF
   (only on camera move / scrub / resize); full `dispose()` on close;
   WebGL2-missing → inline hint, not the blocking wasm gate.
3. **Entry point**: a "3D view" button in the legend card next to the
   Show select (visible once a model is built). Esc closes (existing
   keyboard pattern).
4. **Timeline scrub**: when `area.timeline` exists, the same step
   slider drives the 3D water surface from the u8 frames — rebuilt on
   each step (decimated mesh is ≤ ~150 k vertices, cheap).
5. **Perf budget**: decimation caps the mesh; no per-frame wasm; no
   texture draping in v1; renderer reused between opens; everything
   disposed on close so closing frees the GPU memory.

## Non-goals (v1)

Draped satellite imagery, building/road extrusion, gauge sprites,
evacuation routes in 3D, animation of the local-inertial run (2D frames
only), and any change to the flood engine.

## v2.1 — 3D anywhere

The view no longer requires a built model: with no model, opening 3D
fetches elevation for the visible map box (`fetchDemWindow`, cell ~45 m,
clamped to a 30 km box around the map centre) and shows draped terrain
only — the flood water still appears wherever modelled tiles exist. At
country zooms there is no sensible DEM to fetch, hence the clamp; the
Australia-wide globe remains a deferred idea.

## v2 — the "Earth look" (follow-up)

1. **Imagery drape**: bake the 2D map's loaded satellite tiles into one
   canvas (Leaflet tile imgs drawn at their projected positions for a
   chosen zoom, canvas ≤ 4096²) and use it as the terrain material's
   albedo map, model bounds ↔ texture UVs. Requires the drape basemap's
   tile layer to be created with `crossOrigin: 'anonymous'` (Esri,
   CARTO, OSM all allow CORS); a tainted canvas or no tiles falls back
   to the hypsometric vertex colours. The SW's mode-compatibility
   checks already make cors-mode tile caching safe.
2. **Lighting**: lit material (Lambert) with a fixed directional sun so
   shading stays correct while orbiting; baked hillshade colours become
   the albedo (fallback keeps them unlit).
3. **Camera**: fly-in animation on open (high → framed), OrbitControls
   damping, zoom-to-cursor.
4. **Water quality**: alpha ramps with depth (shoreline feather), the
   depth band colours slightly desaturated, `polygonOffset` instead of
   the y-lift, so the surface reads as water not paint.
5. **Edges**: skirt + rim fade so NoData/model-boundary edges don't read
   as torn white cliffs.

Deferred: timeline play, 3D markers, building extrusion, adaptive mesh
LOD, and a national-globe start view (each listed in docs/roadmap.md).

## Failure behaviour

- No WebGL2: inline hint in the panel ("this browser/device can't show
  3D"), 2D map unaffected.
- No model built: button hidden.
- Corrupt/short frame data: `waterMesh` returns null → water layer
  simply hidden for that step (2D keeps its own fallback).

## Test plan

- Node (`tests/terrain3d.test.js`): `decimateStep` caps sample counts;
  `terrainMesh` skips invalid cells and AHD heights land in bounds;
  `waterMesh` emits vertices only for wet cells and tracks a
  synthetic run; frame decode matches `showTimeStep`'s u8 → depth
  arithmetic on a synthetic timeline frame.
- Smoke: with a model open, the 3D button opens the overlay, the
  canvas renders (non-black), and closing restores the map — assert via
  a `__floodOpen3D`/`__flood3DState` test hook on one preset only.
- Browser: manual orbit/scrub/exaggeration pass on the live site.

## v3 — 3D slippy terrain (streaming, on demand)

v2 stitched whole modelled areas into one scene, which showed one lonely
tile when a single place was modelled and left the camera framing a vast
union with empty space between far-apart places. v3 makes the 3D view
work like the 2D slippy map instead:

- **Terrain streams on demand.** The scene keeps web-mercator tiles
  (`z/x/y`) covering the ground under the camera. As the camera orbits
  or pans, tiles that enter the ground footprint are fetched (DEM-H via
  `fetchDemWindow`, no WASM analysis needed — the mesh only wants
  `dem` + `valid`), decimated, skirted and added; tiles that fall out
  are disposed. Fetches run two at a time, closest to the target first,
  with an LRU cap so long flights don't accumulate the world.
- **Zoom refines.** The camera's ground view width selects the tile zoom
  band (and DEM cell: 90 m far, 45 m mid, 30 m near). Dollying in drops
  the band to finer tiles; already-loaded tiles are replaced by more
  detailed ones as they arrive.
- **Imagery refetches with it.** While the 3D view is open the hidden
  2D map's view is kept at the 3D ground centre and zoom (debounced,
  no animation), so the basemap streams imagery for exactly the ground
  in view — at the refined zoom when you zoom in. Each terrain tile's
  drape bakes from those loaded tiles (per-tile texture; retries while
  the imagery is still streaming; hypsometric fallback where the canvas
  is tainted or nothing is loaded).
- **Water stays model-based.** Modelled areas contribute water surfaces
  only (their terrain now comes from the stream): the analysis rebuild
  machinery (`areasFor3d`, `__area3d`) feeds the water meshes, the
  timeline scrub drives them per step.
- **Geometry conventions.** Scene origin fixed at open (the 2D map
  centre): +x east, +z south, y up (metres, ×exaggeration). Mesh local
  z is south-positive too (`pz = y * cell`), matching the group offsets.

Failure behaviour is unchanged except that sea-only windows are fine:
the elevation fetch returns them as flat sea planes (no throw), fetch
errors still surface via `say()` once
and the tile is skipped (retry on the next camera change); no WebGL2
still shows the inline hint; corrupt frame data hides just the water.

Test plan additions (node): `mercatorTiles(s, w, n, e, z)` range math;
stream tile bounds round-trip against the drape bake's mercator math.

## v4 — one projection, tile terrain with LOD, imagery per tile

Full plan and per-phase outcomes: [3d-view-v4-plan.md](3d-view-v4-plan.md).
v4 replaces v3's terrain, imagery and camera (the chrome, mini-globe,
compass, scrub and the water-from-model idea stay).

- **Projection.** Scene coordinates are local web mercator
  (`makeProjection` in `terrain3d.js`): x east, z south, y up, scaled by
  cos(origin latitude). Tile corners come from the integer tile grid
  alone (`tileToScene`), so neighbours share bit-identical edges; water
  meshes take their per-column x / per-row z from the same projection
  (mercator is separable), so nothing needs per-group offsets or stretch.
- **Terrain source.** AWS Terrain Tiles (terrarium PNGs, z0–14 used),
  decoded without colour management; sea-floor bathymetry is clamped to
  the -1.5 m "sea" level the DEM-H path uses. Three consecutive failures
  (CORS, blocked) switch the session to DEM-H requested for each tile's
  exact bounds (`fetchDemBox`), with one `say()` and the source named in
  the bar and `__flood3DState().source`.
- **LOD.** `selectTiles` splits a quadtree (from z6) by on-screen tile
  size (~1.5 × 256 px), culls by frustum (using each tile's height range)
  and horizon, and caps the count. `resolveDraw` draws a built ancestor
  until its children are ready (and built descendants when zooming out),
  never overlapping surfaces. Fetches are ordered by on-screen size with
  coarse ancestors first; built tiles live in an LRU (300) and are
  disposed (geometry, material, texture) when evicted or on close.
- **Meshes.** 33 × 33 grid per tile, normals from the height grid, skirts
  copying the edge vertex's normal/UV/colour (no dark seams). Tiles over
  a modelled area use a finer grid (up to 128²).
- **Imagery.** Each drawn tile loads its own picture from the active 2D
  basemap's XYZ template (CORS-enabled ones; otherwise the default
  satellite layer) as a texture, and meanwhile wears a sub-rect of its
  nearest ancestor's texture, else relief colours. The hidden-map
  following and canvas baking are gone. The bar toggles Imagery/Relief;
  if imagery can't load at all the view falls back to relief with one
  message.
- **Water on the ground.** Inside a modelled area the terrain height is
  the model's own DEM (`overrideHeight`, blended over a few cells at the
  border), so the water surface (`wse`, or dem + depth from timeline
  frames) sits on the drawn ground. Tiles over areas are rebuilt when
  areas arrive/change/leave. Water is a Phong material, lifted 0.05 m,
  drawn after the terrain (polygonOffset does nothing with a
  logarithmic depth buffer, so there is none).
- **Camera.** `MapControls`: left-drag pans along the ground, right-drag
  (two fingers) turns/tilts, wheel zooms to the cursor, double-click
  flies to the point. The orbit target follows the terrain (camera and
  target move together) and the camera keeps a clearance over the hills;
  tilt is limited to 85°. Logarithmic depth buffer; sky dome gradient
  plus fog in the horizon colour; vertical exaggeration defaults to 1.5×
  (slider 1–10), applied as one group's scale.y.
- **State hook.** `window.__flood3DState()` returns `{ open, source,
  tiles: { drawn, byZoom, pending, cached, failed }, imagery: { on,
  loaded, failed, pending }, water: [{ key, verts }], cam, target, step,
  exag, fps, frames, ground }` for the CI screenshots (`tests/shots3d.js`).
- **Tests.** `tests/terrain3d.test.js`: projection round trip, shared
  tile edges, terrarium decode, bilinear sampling, skirt normals/UVs,
  `selectTiles` (refines near, coarsens far, cap, frustum, horizon),
  `resolveDraw`, height override and blending, water in scene coordinates.
