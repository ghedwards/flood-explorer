# 3D view v4 — plan

Status: planned (2026-10-19). Supersedes the v3 streaming design in
[3d-view-design.md](3d-view-design.md) for the terrain, imagery and camera;
keeps its scene/bar/globe chrome, the timeline scrub and the water-from-
model idea. Implementation goes on the branch `3d-v4`; every push there
builds the site in CI and screenshots the 3D view (see *Verification*).

## Baseline (live site, 2026-10-19, `shots3d` run on main 24bfd03)

At Rockhampton with a model built, **the 3D view draws nothing**: every
shot (opening, settled, zoomed, tilted, zoomed out) is the plain navy
background. `__flood3DState().cam` and `.target` are `[null, null,
null]`, i.e. the camera position is **NaN** from the start, so nothing
can render. The bar is also clipped at the bottom of the window
("experimental" cut off — `var(--bottom)` in its `calc()` is probably
undefined in the 3D chrome's context). No console errors besides one
404. Whatever v4 does, phase 0 is finding where the NaN comes from
(candidates: `frameCamera`/fly-in with a degenerate view box, OrbitControls
with target == position, the zoom-limit derivation in `updateStream`) and
guarding camera updates with `Number.isFinite` checks.

## Why: what's wrong with v3 (review of viewer/scene3d.js, terrain3d.js)

Geometry and data:

1. **Seams between tiles.** Each tile is placed with its own
   `cos(midLat)` (`placeGroup`), so tiles in different rows put the same
   longitude at different x (≈50 m apart 60 km from the origin). Within a
   tile, x and z both use one `cell` derived from the east–west span, but
   the DEM window's north–south span comes from `windowBox` and doesn't
   match the tile's — rows overlap or gap. The `W/(W-1)` stretch is only
   right at full resolution: after decimation the last vertex sits at
   `(cols-1)*skip ≤ W-1`, so tiles stop short of their edges. Edge heights
   come from each tile's own window, so neighbours disagree at the shared
   edge; with skirts removed, every disagreement is a crack to the
   background.
2. **One detail level for everything.** A single zoom band (z11–13) for
   the whole view: the ground near the camera is as coarse as the horizon,
   and the streamed box is a square around the orbit target, so anything
   tilted shows the box's edge dropping into the navy background.
3. **Zoom flushes the world.** Crossing a band disposes every tile before
   replacements arrive, so the screen goes empty and refills.
4. **Slow terrain.** Every tile is a separate Geoscience Australia WCS
   GeoTIFF request (`fetchDemWindow`), two at a time; dozens per view.
5. **Fragile imagery.** The drape is baked from the *hidden 2D map's*
   loaded Leaflet tiles, after moving that map to follow the camera
   (`syncMap`); it retries up to 40 times and falls back to hypsometric
   colours when the timing, zoom or CORS doesn't line up.
6. **Water can hide under or float over the terrain.** Water surfaces are
   the model's `wse` (its own DEM, often LiDAR or DEM-H at 20–30 m) but
   the terrain under them is a different, coarser DEM, so at 12× the
   river disappears under the banks in places and hovers elsewhere.

Look and feel:

7. **12× vertical exaggeration by default** turns a 30 m surface model's
   trees and buildings into spikes; 1.5–2× is the norm at this scale.
8. **Camera:** OrbitControls orbit a target at y = 0 (sea level), not the
   ground, so over high country the target is buried and orbiting swings
   underground; pan moves in the screen plane, not along the ground;
   wheel zoom goes to the target, not the cursor. Near 1 m / far 1000 km
   without a logarithmic depth buffer gives z-fighting at distance.
9. **No sky, fog or horizon** — the scene ends in a flat navy void.

Code health:

10. `window.__flood3DState` (app.js) still reads v2 fields
    (`tiles[].terrain`, `exag` from water tiles) and no test exercises the
    3D view in a browser.

## What v4 does

### 1. One projection for the whole scene (`viewer/terrain3d.js`)

- Scene coordinates are **local web mercator**: for the origin latitude
  φ₀ (fixed at open), `x = (mx − mx₀)·k`, `z = (my − my₀)·k` with `mx, my`
  in mercator metres (EPSG:3857) and `k = cos φ₀` (true metres at the
  origin; under 2 % scale error within 200 km — fine for viewing). +x
  east, +z south, +y up (metres × exaggeration).
- Pure helpers, node-tested: `lonLatToScene`, `sceneToLonLat`,
  `tileToScene(z, x, y)` (corner positions), so **adjacent tiles compute
  identical edge coordinates** (no per-tile cos, no stretch factors).

### 2. Terrain tiles from a tile service, with a fallback

- Primary: **AWS Terrain Tiles (Terrarium)**,
  `https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png`
  (public, no key, CORS, z0–15, 256 px; height
  `= R·256 + G + B/256 − 32768` m). Decode with `createImageBitmap` +
  `OffscreenCanvas`/canvas `getImageData` (fallback for Safari < 16.4).
- Fallback per tile: the existing `fetchDemWindow` (DEM-H WCS) requested
  for the tile's **exact** bounds, sampled onto the same vertex grid.
  Switch the whole session to the fallback after 3 consecutive Terrarium
  failures (CORS/blocked), and record which source is in use in the 3D
  state hook and the bar (`terrain: AWS Terrain Tiles | GA DEM-H`).
- Attribution in the bar: "Terrain: AWS Terrain Tiles (Mapzen, SRTM and
  others)" / "GA DEM-H"; imagery attribution as the 2D layer's.

### 3. Quadtree level of detail (`viewer/terrain3d.js` + scene)

- Pure function `selectTiles(view)` → the set of tiles to draw, node-
  tested. Start from the z8 tiles covering the visible ground; split a
  tile while its **screen-space size** (tile edge length / distance from
  camera × `screenHeight / (2·tan(fov/2))`) exceeds ~1.5 × 256 px and z <
  15 (14 if the source tops out); cull tiles outside the frustum (test
  the tile's bounding box, using its min/max height) and beyond a
  horizon distance (≈ `sqrt(2·R·h)` + margin, capped 300 km).
- Keep a **parent drawn until all its children are ready** (and children
  until the parent is ready when zooming out), so nothing ever goes
  blank. LRU cache of built tiles (~300), fetch queue sorted by screen
  size (biggest first), 6 concurrent fetches, at most 4 mesh builds per
  frame.
- Mesh per tile: regular **33 × 33 vertex grid** over the tile's exact
  corners (from `tileToScene`), heights bilinear-sampled from the tile's
  height grid; vertex normals computed with the neighbouring tiles'
  border heights where available, else one-sided (avoid shading seams).
- **Skirts** on all four edges (drop = max(5 m, tile size / 50)), with
  the edge vertex's **normal and UV copied** onto the skirt vertices so
  they shade and texture like the surface (v3's skirts were dark seams
  because they kept flat normals). Skirts hide cracks between different
  levels.

### 4. Imagery: fetched per tile, not baked from the hidden map

- Each terrain tile loads its own imagery tile(s) directly from the
  active 2D basemap's XYZ template (Esri World Imagery for "Satellite";
  CARTO/OSM/OpenTopoMap otherwise — all already `crossOrigin: true`):
  the same z/x/y when z ≤ 17, else the z-17 parent with UV sub-rect. Use
  `THREE.TextureLoader` with `crossOrigin = 'anonymous'`, sRGB,
  anisotropy = renderer max (≤ 8), mipmaps on.
- Until a tile's imagery loads, show the parent's texture via a UV
  sub-rect, else the hypsometric vertex colours (`terrainRGBA`).
- **Remove** `syncMap`, `bakeTexture`, `getTiles` and the hidden-map
  following — the 2D map stays where it was and is restored on close.
- A small basemap toggle in the bar: *Imagery* / *Relief* (hypsometric
  colours, no network).

### 5. Water that sits on the ground

- **Terrain height override inside modelled areas:** the tile height
  function is `h(lon, lat) = model DEM (bilinear) if inside a modelled
  area, else the tile source`. The model DEM is what the flood was
  computed on, so its water surface (`wse`, or `dem + depth` from the u8
  timeline frames) now sits on the drawn ground exactly. Tiles
  overlapping an area are rebuilt when the area's analysis arrives or
  leaves (`refresh()`).
- Water meshes as today (`waterMesh`, `waterFromFrame`) but positioned
  with the shared projection (per-vertex lon/lat → scene, no group
  offsets/stretch), drawn after the terrain with `polygonOffset`, a
  0.05 m lift (× exaggeration), depth-band colours, depth-ramped alpha,
  and a little specular (`MeshPhongMaterial`, shininess ~60) so it reads
  as water.
- The scrub keeps driving water per step; no change to the flood engine.

### 6. Camera and controls (Google Earth-like)

- Use three's **MapControls** (`three/addons/controls/MapControls.js`):
  left-drag pans along the ground, right-drag / two-finger rotates and
  tilts, wheel/pinch zooms **to the cursor** (`zoomToCursor = true`).
  `screenSpacePanning = false`.
- Every frame (cheap), keep `controls.target.y` on the ground: sample the
  height function under the target (from the loaded tile covering it).
  Keep the camera at least `max(30 m, 2 % of distance)` above the ground
  under it.
- Tilt limit: `maxPolarAngle` ≈ 85° (no looking up from underground);
  distance limits 200 m – 400 km.
- `logarithmicDepthBuffer: true` on the renderer (fixes far z-fighting);
  far plane = horizon distance × 1.2.
- Fly-in on open (kept), **double-click to fly to the point** under the
  cursor, compass/globe double-click resets north (kept).

### 7. Sky, fog and light

- Sky: a vertical gradient (horizon pale blue-grey → zenith deeper) as
  `scene.background` (CanvasTexture) or a large inverted sphere.
- `scene.fog = new THREE.Fog(horizonColour, near, far)` with near/far
  following the camera altitude (start fading at ~60 % of the horizon
  distance), so distant coarse tiles fade into haze instead of ending.
- Keep the directional sun + ambient; sun from the north-west.

### 8. Defaults, UI and hooks

- **Vertical exaggeration default 1.5×** (slider 1–10, step 0.5), applied
  to one world group's `scale.y` (terrain + water together; skirts too).
- Bar: Back to map · exaggeration · Imagery/Relief · step scrub (when a
  timeline exists) · compass · loading indicator ("loading 12 tiles") ·
  terrain source · experimental.
- `window.__flood3DState()` returns v4 state: `{ open, source, tiles:
  { drawn, byZoom: {z: n}, pending, cached, failed }, imagery: { loaded,
  failed }, water: [{ key, verts }], cam, target, exag, fps }`.
- Errors: one `say()` per kind (terrain source failed → fallback in use;
  imagery failed → relief colours), not one per tile.

### 9. Files

- `viewer/terrain3d.js`: projection helpers, `selectTiles`, terrarium
  decode, tile grid/skirt builder, height-override sampler, existing
  water helpers (re-expressed in lon/lat → scene). Pure, no three.
- `viewer/scene3d.js`: rewritten around a `TileManager` (fetch queue,
  LRU, parent/child readiness, mesh/texture building) and the MapControls
  camera. Keep the chrome markup/CSS, mini-globe, compass, scrub.
- `viewer/app.js`: `open3d` hooks (drop `getTiles`/`syncMap`, add
  `getBasemapTemplate()` returning `{ url, subdomains, maxZoom, attr }`
  for the active 2D basemap); fix `__flood3DState`.
- `viewer/sw.js`: cache Terrarium tiles like map tiles (add the
  `s3.amazonaws.com` elevation path to the tile rules, LRU-limited).
- Docs: add a *v4* section to `docs/3d-view-design.md`; roadmap line.

## Phases (each a commit on `3d-v4`, each verified by screenshots)

0. **Make v3 draw** (small, first): find and fix the NaN camera, fix the
   bar's bottom offset, point `__flood3DState` at real fields. *Accept:*
   the settled shot shows terrain. This gives a baseline to compare v4
   against and a fix that could ship on its own.
1. **Projection + tiles + terrain source**: shared projection, Terrarium
   decode + DEM-H fallback, 33×33 tile meshes with skirts, a fixed set of
   tiles (no LOD yet) around the target, relief colours. *Accept:* no
   cracks or row offsets in the zoomed-in and low-angle shots.
2. **LOD**: `selectTiles`, parent-until-children-ready, LRU, queue.
   *Accept:* low-angle shot shows near detail and terrain to the horizon;
   zoom-in shot never blank; tile counts by zoom in the report.
3. **Imagery per tile** + basemap toggle; remove hidden-map baking.
   *Accept:* imagery on all visible tiles within 20 s; no hypsometric
   patches in the settled shot.
4. **Water on the ground**: height override in modelled areas, water mesh
   in the shared projection, Phong water. *Accept:* the river at the
   modelled preset reads as continuous water at 1.5× and at 5×.
5. **Camera, sky, fog, defaults, hooks, docs**: MapControls + terrain-
   following target, log depth, fly-to, sky + fog, 1.5× default, new
   `__flood3DState`, SW rule, design doc. *Accept:* all shots look like a
   Google Earth view (sky, haze at the horizon, no void), the report shows
   no console errors.

## Verification

Locally (no npm registry here, so no vite/three/eslint):
`node --test tests/*.test.js` must pass — add tests in
`tests/terrain3d.test.js` for: projection round trip; adjacent tiles'
shared-edge vertices identical; `selectTiles` refines near and coarsens
far, never exceeds a cap, culls behind the camera; Terrarium decode
(known RGB → metres); skirt normals equal edge normals; height override
returns the model DEM inside the area and the source outside.

In CI, per push to `3d-v4`: `.github/workflows/shots3d.yml` builds the
branch, opens Rockhampton, opens 3D and screenshots it (opening, settled,
zoomed in, low angle, turned, zoomed out, 2×), then pushes the PNGs and
`report.json` (steps, console errors, 3D state) to the `shots-3d` branch:
`git fetch origin shots-3d && git show origin/shots-3d:report.json`, and
read the PNGs from a worktree. The run takes ~10 minutes; check
`gh run list -R ghedwards/flood-explorer --workflow shots3d.yml`. Also
watch the *Lint* workflow (eslint) on the branch. Update
`tests/shots3d.js` if the controls change (MapControls: left-drag pans,
right-drag rotates — use `page.mouse.down({ button: 'right' })` for the
tilt/turn poses).

## Out of scope

Buildings in 3D, the national globe start view, 3D markers/routes,
changes to the flood engine, terrain-RGB from our own pipeline.
