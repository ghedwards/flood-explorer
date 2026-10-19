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
