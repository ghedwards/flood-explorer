/* Experimental 3D flood view (docs/3d-view-design.md): three.js glue.
 *
 * v3 — "3D slippy terrain": the scene works like the 2D map. Terrain tiles
 * (web-mercator z/x/y) stream on demand to cover the ground under the
 * camera — each is a DEM-H window (no WASM analysis; the mesh only wants
 * dem + valid), decimated and skirted by viewer/terrain3d.js, draped with
 * the basemap imagery the hidden 2D map is loading for the same ground.
 * Zooming in (dolly) refines the tile band, so DEM and imagery refetch at
 * more detail. Modelled areas contribute water surfaces only, positioned
 * by their bounds; the timeline scrub drives them per step.
 * Vertical exaggeration is mesh.scale.y so the slider never rebuilds.
 */
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { decimateStep, terrainMesh, waterMesh, waterFromFrame, mercatorTiles, tileBounds, streamZoom, streamCell } from './terrain3d.js';

const EXAG_DEFAULT = 12;
const STREAM_CONCURRENCY = 2;
const STREAM_RETRY_MS = 60000;   // don't refetch a failed tile for a minute

let controller = null;   // one open view at a time

export function openScene3d(hooks) {
  if (controller) return controller;
  const canvas = document.createElement('canvas');
  const gl = canvas.getContext('webgl2', { antialias: true });
  if (!gl) {
    if (hooks.onUnsupported) hooks.onUnsupported("This browser or device can't show the 3D view (no WebGL 2). The 2D map is unaffected.");
    return null;
  }
  controller = new Scene3d(canvas, hooks);
  return controller;
}

export function closeScene3d() {
  if (controller) controller.close();
}

// internals for debugging/testing (read-only)
export function debugState() {
  if (!controller) return null;
  return {
    cam: controller.camera.position.toArray(),
    target: controller.controls.target.toArray(),
    stream: [...controller.stream.keys()],
    water: [...controller.tiles.keys()],
  };
}

class Scene3d {
  constructor(canvas, hooks) {
    this.hooks = hooks;
    this.dirty = true;
    this.pollCount = 0;
    this.tiles = new Map();       // area key -> { area, group, water }
    this.stream = new Map();      // 'z/x/y' -> { key, bounds, a, group, terrain, tex }
    this.pending = new Set();     // stream keys being fetched
    this.queue = [];              // stream keys waiting to fetch
    this.failed = new Map();      // stream key -> failure time
    this.fetching = 0;
    this.streamZ = null;
    // scene origin: [lon, lat] fixed at open (the 2D map centre); group
    // offsets are metres from it, +x east, +z south
    const centre = hooks.getCentre ? hooks.getCentre() : null;
    this.origin = centre ? [centre[1], centre[0]] : null;

    const overlay = document.createElement('div');
    overlay.id = 'view3d';
    overlay.innerHTML = `
      <style>
        /* sits with the map (below the floating chrome, which stays live:
           the scenario sliders still drive the water while you're in 3D) */
        #view3d{position:fixed;inset:0;z-index:5;background:#0b1622}
        #view3d>canvas{position:absolute;inset:0}
        /* the 3D's own controls ride ABOVE the panels (they'd be hidden
           behind the key/panel cards otherwise); the fab corner is free
           while the 3D view is open, so the controls park on the right */
        #view3dChrome{position:fixed;inset:0;z-index:1002;pointer-events:none}
        #view3dChrome .bar{position:absolute;right:14px;bottom:calc(var(--bottom) + env(safe-area-inset-bottom,0px) + 14px);display:flex;gap:14px;align-items:center;padding:9px 14px;background:rgba(10,22,36,.92);color:#dce8f2;font:14px system-ui,sans-serif;border-radius:12px;box-shadow:0 4px 18px rgba(0,0,0,.4);pointer-events:auto}
        #view3dChrome .bar label{display:flex;gap:6px;align-items:center}
        #view3dChrome button{font:inherit;color:#dce8f2;background:#17334d;border:1px solid #3d5a75;border-radius:6px;padding:4px 12px;cursor:pointer}
        #view3dChrome .compass{font-weight:600;min-width:2.5em;text-align:center}
        #globe3dWrap{position:absolute;right:14px;bottom:calc(var(--bottom) + env(safe-area-inset-bottom,0px) + 76px);width:68px;height:68px;border-radius:50%;background:rgba(8,20,32,.72);border:1px solid #3d5a75;box-shadow:0 4px 18px rgba(0,0,0,.4);cursor:grab;overflow:hidden;pointer-events:auto}
        #globe3dWrap:active{cursor:grabbing}
        #globe3d{width:100%;height:100%;display:block}
      </style>`;

    const bar = document.createElement('div');
    bar.className = 'bar';
    bar.innerHTML = `
      <button type="button" id="close3d">Back to map (Esc)</button>
      <label>vertical ×<input id="exag3d" type="range" min="1" max="30" step="1" value="${EXAG_DEFAULT}" style="width:120px"><span id="exagVal">12</span></label>
      <span id="scrub3dWrap" hidden><label>step <input id="scrub3d" type="range" min="0" max="0" value="0" style="width:220px"><span id="scrubVal"></span></label></span>
      <span class="compass" id="compass3d">S</span>
      <span id="tiles3d"></span>
      <span style="margin-left:auto;font-size:12px;opacity:.75">experimental</span>`;

    // mini-globe navigation widget (Google-Earth style): a small shaded
    // sphere that mirrors where the camera looks; drag to orbit (yaw and
    // pitch), double-click to reset north
    const globeWrap = document.createElement('div');
    globeWrap.id = 'globe3dWrap';
    globeWrap.title = 'Drag to look around; double-click to reset north';
    globeWrap.innerHTML = '<canvas id="globe3d" width="128" height="128" aria-hidden="true"></canvas>';

    // the 3D's own chrome (bar + globe) in its own layer above the panels
    const chrome = document.createElement('div');
    chrome.id = 'view3dChrome';
    chrome.appendChild(bar);
    chrome.appendChild(globeWrap);

    overlay.appendChild(canvas);
    overlay.appendChild(chrome);
    document.body.appendChild(overlay);
    document.body.classList.add('in3d');   // hide the map fabs (they act on
    // the map we've covered); the bar's Back-to-map handles the way out

    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
    this.renderer.setPixelRatio(Math.min(devicePixelRatio || 1, 2));

    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color('#0b1622');
    this.camera = new THREE.PerspectiveCamera(55, 1, 1, 1e6);
    this.controls = new OrbitControls(this.camera, canvas);
    this.controls.enableDamping = true;   // smooth, Earth-like camera feel
    this.controls.dampingFactor = 0.08;
    // zoom limits until the first band is chosen; updateStream re-derives
    // them from the streamed tile size so you can't zoom past the data
    this.controls.minDistance = 250;
    this.controls.maxDistance = 400000;
    this.controls.maxPolarAngle = Math.PI / 2 + 0.28;   // ~106°: horizon and a bit past
    this.controls.addEventListener('change', () => { this.dirty = true; this.updateCompass(); });
    // fixed afternoon sun from the north-west + enough ambient for the
    // south faces; lighting stays correct as the camera orbits (the baked
    // hillshade could not)
    const sun = new THREE.DirectionalLight(0xfff4e0, 2.2);
    sun.position.set(-0.6, 1, -0.5);
    this.scene.add(sun);
    this.scene.add(new THREE.AmbientLight(0xbfd4e8, 1.1));

    this.buildWaterTiles();
    this.frameCamera(true);
    this.initGlobe();

    const close = bar.querySelector('#close3d');
    close.addEventListener('click', () => closeScene3d());
    this.onKey = (e) => { if (e.key === 'Escape') { e.stopPropagation(); closeScene3d(); } };
    window.addEventListener('keydown', this.onKey, true);
    const exag = bar.querySelector('#exag3d');
    exag.addEventListener('input', () => {
      bar.querySelector('#exagVal').textContent = exag.value;
      this.setExaggeration(parseFloat(exag.value));
    });
    const scrubWrap = bar.querySelector('#scrub3dWrap'), scrub = bar.querySelector('#scrub3d');
    if (this.activeTimeline()) {
      const tl = this.activeTimeline();
      scrubWrap.hidden = false;
      scrub.max = tl.steps - 1;
      scrub.value = hooks.getStep ? hooks.getStep() : 0;
      bar.querySelector('#scrubVal').textContent = `${(hooks.getStep ? hooks.getStep() : 0) + 1}/${tl.steps}`;
      scrub.addEventListener('input', () => {
        const k = parseInt(scrub.value, 10);
        bar.querySelector('#scrubVal').textContent = `${k + 1}/${tl.steps}`;
        this.scrubAll(k);
      });
    }
    this.onResize = () => { this.resize(); };
    window.addEventListener('resize', this.onResize);
    this.resize();

    const tick = () => {
      this.raf = requestAnimationFrame(tick);
      // fly-in easing (~2s), damping then settles into user control
      if (this.flyT != null && this.flyT < 1) {
        this.flyT = Math.min(1, this.flyT + 1 / 120);
        const t = this.flyT, e = t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2;   // easeInOutQuad
        this.camera.position.lerpVectors(this.flyFrom, this.flyTo, e);
        this.dirty = true;
        if (t >= 1) { this.flyT = null; this.flyFrom = this.flyTo = null; }
      }
      this.controls.update();
      // streaming terrain + late water tiles + drape retries, on a ~0.75s
      // cadence (cheap; keeps up with orbiting and dollying)
      if (++this.pollCount >= 45) { this.pollCount = 0; this.pollReady(); }
      this.drawGlobe();
      if (this.dirty) { this.renderer.render(this.scene, this.camera); this.dirty = false; }
    };
    tick();
  }

  /* Ground footprint of the camera as [s, w, n, e] — the target plus a
   * generous view radius, clamped so one orbit never fetches the planet. */
  groundBox() {
    const t = this.controls.target;
    const dist = this.camera.position.distanceTo(t);
    const half = Math.min(60000, Math.max(1500, dist * Math.tan((55 / 2) * Math.PI / 180) * 1.6));
    if (!this.origin) return null;
    const lat = this.origin[1] - t.z / 110574;
    const lon = this.origin[0] + t.x / (111320 * Math.cos((lat * Math.PI) / 180));
    const halfLat = half / 110574;
    const halfLon = half / (111320 * Math.cos((lat * Math.PI) / 180));
    return [lat - halfLat, lon - halfLon, lat + halfLat, lon + halfLon];
  }

  updateStream() {
    const box = this.groundBox();
    if (!box) return;
    const lat = (box[0] + box[2]) / 2;
    const viewM = (box[3] - box[1]) * 111320 * Math.cos((lat * Math.PI) / 180);
    const z = streamZoom(viewM, lat);
    if (z !== this.streamZ) {
      // zoom refined: drop everything and refetch at the new detail level,
      // and re-derive the zoom limits from the band — closest, a tile still
      // spans the view (its imagery/dem detail is the floor); furthest, the
      // streamed ground box (capped at 120 km) still fills the view
      this.streamZ = z;
      const ground = 40075016.7 * Math.cos((lat * Math.PI) / 180) / (1 << z);
      this.controls.minDistance = Math.max(150, ground * 0.7);
      this.controls.maxDistance = Math.max(3000, 120000 / 1.67);
      for (const st of this.stream.values()) this.disposeStreamTile(st);
      this.stream.clear();
      this.pending.clear();
    }
    this.syncMap(box);
    const r = mercatorTiles(box[0], box[1], box[2], box[3], z);
    const want = new Set();
    for (let y = r.y0; y <= r.y1; y++) for (let x = r.x0; x <= r.x1; x++) want.add(`${z}/${x}/${y}`);
    for (const [key, st] of this.stream) {
      if (!want.has(key)) { this.disposeStreamTile(st); this.stream.delete(key); }
    }
    // missing, closest to the view centre first; skip recent failures
    const now = Date.now();
    const missing = [];
    for (const key of want) {
      if (this.stream.has(key) || this.pending.has(key)) continue;
      const failAt = this.failed.get(key);
      if (failAt && now - failAt < STREAM_RETRY_MS) continue;
      missing.push(key);
    }
    const cx = (r.x0 + r.x1) / 2, cy = (r.y0 + r.y1) / 2;
    const td = (key) => { const [_, x, y] = key.split('/').map(Number); return Math.hypot(x - cx, y - cy); };
    missing.sort((a, b) => td(a) - td(b));
    this.queue = missing;
    this.kickFetch();
    this.updateTileCount();
  }

  kickFetch() {
    while (this.fetching < STREAM_CONCURRENCY && this.queue.length) {
      const key = this.queue.shift();
      if (this.stream.has(key) || this.pending.has(key)) continue;
      this.pending.add(key);
      this.fetching++;
      this.fetchStreamTile(key)
        .catch((err) => {
          this.failed.set(key, Date.now());
          if (!this.__saidFetch || Date.now() - this.__saidFetch > 8000) {
            this.__saidFetch = Date.now();
            if (this.hooks.onUnsupported) this.hooks.onUnsupported(`3D: couldn't fetch terrain here (${err.message || err}).`);
          }
        })
        .finally(() => {
          this.pending.delete(key);
          this.fetching--;
          this.kickFetch();
        });
    }
  }

  async fetchStreamTile(key) {
    const [z, x, y] = key.split('/').map(Number);
    const [w, s, e, n] = tileBounds(z, x, y);
    const lat = (s + n) / 2, lon = (w + e) / 2;
    const halfKm = ((e - w) * 111320 * Math.cos((lat * Math.PI) / 180)) / 2000;
    if (!this.hooks.fetchDem) throw new Error('no elevation source');
    const { grid } = await this.hooks.fetchDem(lat, lon, halfKm, streamCell(z));
    if (this.streamZ !== z) return;   // the zoom band moved on meanwhile
    // Pin the tile to its REQUESTED mercator bounds: the raster's own
    // tiffBounds can drift up to a cell from the request, and neighbouring
    // windows drift independently — cracks between tiles. With the
    // requested box the mesh and its imagery drape stay aligned and
    // adjacent tiles abut exactly.
    const spanM = (e - w) * 111320 * Math.cos((lat * Math.PI) / 180);
    const st = {
      key, bounds: [w, s, e, n], group: new THREE.Group(), terrain: null, tex: null,
      a: { W: grid.W, H: grid.H, cell: spanM / grid.W, dem: grid.dem, valid: grid.valid, N: grid.W * grid.H },
    };
    this.stream.set(key, st);
    this.scene.add(st.group);
    this.buildStreamTerrain(st);
    this.dirty = true;
  }

  buildStreamTerrain(st) {
    const skip = decimateStep(st.a.W, st.a.H);
    const rgba = this.hooks.terrainColors ? this.hooks.terrainColors(st.a) : null;
    // no skirt: adjacent windows abut exactly, and skirt walls shade as
    // dark seams at every tile edge; sea/NoData edges read fine raw
    const m = terrainMesh(st.a, rgba, skip, 0);
    if (!m) return;
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(m.positions, 3));
    geo.setAttribute('color', new THREE.BufferAttribute(m.colors, 4));
    geo.setAttribute('uv', new THREE.BufferAttribute(m.uvs, 2));
    geo.setIndex(new THREE.BufferAttribute(m.indices, 1));
    geo.computeVertexNormals();
    st.terrain = new THREE.Mesh(geo, new THREE.MeshLambertMaterial({ vertexColors: true, side: THREE.DoubleSide }));
    st.terrain.scale.y = EXAG_DEFAULT;
    st.group.add(st.terrain);
    this.placeGroup(st.group, st.bounds);
    // vertices span (W-1)*cell but the window covers W*cell — stretch the
    // group so tiles abut exactly instead of leaving one-cell gaps
    st.group.scale.x = st.a.W / (st.a.W - 1);
    st.group.scale.z = st.a.H / (st.a.H - 1);
    this.dirty = true;
  }

  disposeStreamTile(st) {
    if (st.terrain) {
      st.group.remove(st.terrain);
      if (st.terrain.material.map) st.terrain.material.map.dispose();
      st.terrain.geometry.dispose();
      st.terrain.material.dispose();
      st.terrain = null;
    }
    st.tex = null;
  }

  /* Keep the hidden 2D map over the same ground at the same mercator zoom
   * (the stream's own band), so its basemap streams the imagery the drape
   * bakes from — at the refined zoom when the camera dollies in. */
  syncMap(box) {
    if (!this.hooks.syncMap || !this.streamZ) return;
    const sig = box.map((v) => Math.round(v * 200)).join('|') + '|' + this.streamZ;
    if (sig === this.__syncSig) return;
    this.__syncSig = sig;
    this.hooks.syncMap(box, this.streamZ);
  }

  pollReady() {
    // late water tiles (inactive places whose analysis was rebuilt)
    const areas = this.hooks.getAreas ? this.hooks.getAreas() : [];
    let added = false;
    for (const area of areas) {
      if (area.a && area.bounds && !this.tiles.has(area.key)) { this.addWaterTile(area); added = true; }
    }
    if (added) this.dirty = true;
    // stream terrain + drape retries (imagery may still be loading)
    this.updateStream();
    for (const st of this.stream.values()) {
      if (!st.terrain || st.tex || (st.__bakeTries || 0) >= 40) continue;
      st.__bakeTries++;
      const tex = this.bakeTexture(st.bounds);
      if (tex) {
        st.tex = tex;
        st.terrain.material.dispose();
        st.terrain.material = new THREE.MeshLambertMaterial({ map: tex });
        this.dirty = true;
      }
    }
  }

  /* Modelled areas: water surfaces only (terrain comes from the stream). */
  buildWaterTiles() {
    const areas = this.hooks.getAreas ? this.hooks.getAreas() : [];
    for (const area of areas) this.addWaterTile(area);
    this.updateTileCount();
  }

  addWaterTile(area) {
    if (!area || !area.a || !area.bounds || this.tiles.has(area.key)) return;
    const t = { area, group: new THREE.Group(), water: null, runRef: null };
    this.tiles.set(area.key, t);
    this.buildTileWater(t, this.hooks.getStep ? this.hooks.getStep() : 0);
    this.scene.add(t.group);
    this.placeGroup(t.group, area.bounds);
    t.group.scale.x = area.a.W / (area.a.W - 1);
    t.group.scale.z = area.a.H / (area.a.H - 1);
    this.updateTileCount();
    this.dirty = true;
  }

  /* World offset: the bounds' NW corner in metres from the scene origin
   * (+x east, +z south). */
  placeGroup(group, b) {
    if (!this.origin) this.origin = [b[0], b[3]];
    const midLat = (b[1] + b[3]) / 2;
    group.position.set(
      (b[0] - this.origin[0]) * 111320 * Math.cos((midLat * Math.PI) / 180),
      0,
      -(b[3] - this.origin[1]) * 110574,
    );
  }

  buildTileWater(t, k) {
    if (t.water) { t.group.remove(t.water); t.water.geometry.dispose(); t.water = null; }
    const a = t.area.a;
    const skip = decimateStep(a.W, a.H);   // same decimation the terrain uses
    let m = null;
    const tl = t.area.timeline;
    if (tl && tl.depthFrames && tl.depthFrames.length >= (k + 1) * a.N && tl.depthFrameMax && tl.depthFrameMax.length > k) {
      m = waterFromFrame(a, tl.depthFrames.subarray(k * a.N, (k + 1) * a.N), tl.depthFrameMax[k] || 0, skip).mesh;
    } else if (t.area.run) {
      const r = t.area.run;   // slim runs omit wse; level (= dem + depth) is kept
      m = waterMesh(a, r.level, r.depth, r.wet, skip);
    }
    if (!m) return;
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(m.positions, 3));
    geo.setAttribute('color', new THREE.BufferAttribute(m.colors, 4));
    geo.setIndex(new THREE.BufferAttribute(m.indices, 1));
    // depth-scaled per-vertex alpha (shoreline feather) needs RGBA colours
    const mat = new THREE.MeshLambertMaterial({ vertexColors: true, transparent: true, side: THREE.DoubleSide, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2 });
    t.water = new THREE.Mesh(geo, mat);
    t.water.scale.y = EXAG_DEFAULT;
    t.group.add(t.water);
    this.dirty = true;
  }

  /* Scrub/play drives every tile that has a timeline; tiles without one
   * keep their static run. */
  scrubAll(k) {
    this.step = k;
    for (const t of this.tiles.values()) this.buildTileWater(t, k);
    if (this.hooks.onScrub) this.hooks.onScrub(k);   // keeps the 2D view in sync
  }

  activeTimeline() {
    for (const t of this.tiles.values()) if (t.area.active && t.area.timeline) return t.area.timeline;
    return null;
  }

  updateTileCount() {
    const el = document.getElementById('tiles3d');
    if (el) el.textContent = this.stream.size ? `${this.stream.size} terrain · ${this.tiles.size} modelled` : '';
  }

  /* Called by the app after the 2D view redraws; picks up new/removed areas
   * and changed runs (water rebuilds by run identity). */
  refresh() {
    const areas = this.hooks.getAreas ? this.hooks.getAreas() : [];
    const seen = new Set();
    for (const area of areas) {
      seen.add(area.key);
      if (!area.a || !area.bounds) continue;
      if (!this.tiles.has(area.key)) { this.addWaterTile(area); continue; }
      const t = this.tiles.get(area.key);
      t.area = area;
      const run = area.run;
      if (run !== t.runRef) {
        t.runRef = run;
        if (!t.area.timeline) this.buildTileWater(t, this.hooks.getStep ? this.hooks.getStep() : this.step);
      }
    }
    for (const [key, t] of this.tiles) {
      if (!seen.has(key)) {   // the area was removed from the map
        this.disposeTileMeshes(t);
        this.scene.remove(t.group);
        this.tiles.delete(key);
      }
    }
    this.updateTileCount();
  }

  setExaggeration(x) {
    for (const st of this.stream.values()) if (st.terrain) st.terrain.scale.y = x;
    for (const t of this.tiles.values()) if (t.water) t.water.scale.y = x;
    this.dirty = true;
  }

  /* Draw the active 2D basemap's loaded tiles into one canvas texture over
   * the given bounds. Tiles are cross-origin: where the layer was created
   * with crossOrigin (the CORS-verified hosts) the canvas stays clean; a
   * tainted canvas throws on the probe read and we fall back to colours. */
  bakeTexture(bounds) {
    const tiles = this.hooks.getTiles && this.hooks.getTiles();
    if (!tiles || !tiles.length || !bounds) return null;
    const [w, s, e, n] = bounds;
    const clampLat = (la) => Math.max(-85, Math.min(85, la));
    const merc = (lon, lat) => [((lon + 180) / 360) * (1 << 21) * 32, (((1 - Math.log(Math.tan((clampLat(lat) * Math.PI) / 180) + 1 / Math.cos((clampLat(lat) * Math.PI) / 180)) / Math.PI) / 2) * (1 << 21) * 32)];
    // merc() is web-mercator px at zoom 18 (2^26 px across the world).
    // Bake at the loaded tiles' own zoom (sharp), then step down until the
    // canvas fits the cap; a blurrier bake beats a holey one
    const list = tiles.slice().sort((x, y) => x.z - y.z);   // coarser drawn first
    let z = list.reduce((m, t) => Math.max(m, t.z || 0), 6);
    const spanX = merc(e, n)[0] - merc(w, n)[0];
    while (z > 5 && (spanX / (1 << (18 - z))) > 4096) z--;
    const scale = 1 / (1 << (18 - z));
    const x0 = merc(w, n)[0] * scale, y0 = merc(w, n)[1] * scale;   // canvas origin = NW corner
    const Wpx = Math.ceil(merc(e, n)[0] * scale - x0), Hpx = Math.ceil(merc(w, s)[1] * scale - y0);
    if (Wpx < 8 || Hpx < 8 || Wpx > 4096 || Hpx > 4096) return null;
    const canvas = document.createElement('canvas');
    canvas.width = Wpx; canvas.height = Hpx;
    const ctx = canvas.getContext('2d');
    let drew = 0;
    for (const t of list) {
      if (!t.img || !(t.img.complete || t.img.naturalWidth)) continue;
      const size = 256 * (1 << z) / (1 << t.z);   // the tile's side in bake px
      const px = merc(t.w, t.n)[0] * scale - x0, py = merc(t.w, t.n)[1] * scale - y0;
      try { ctx.drawImage(t.img, px, py, size + 1, size + 1); drew++; } catch (err) { return null; }
    }
    if (!drew) return null;
    try { ctx.getImageData(0, 0, 1, 1); } catch (err) { return null; }   // tainted: no CORS
    const tex = new THREE.CanvasTexture(canvas);
    tex.colorSpace = THREE.SRGBColorSpace;
    return tex;
  }

  frameCamera(fly = false) {
    // frame the ground the 2D map was showing when the view opened
    const box = this.hooks.getViewBox ? this.hooks.getViewBox() : null;
    if (!box || !this.origin) { this.controls.update(); return; }
    const [s, w, n, e] = box;
    const westM = (w - this.origin[0]) * 111320 * Math.cos(((s + n) / 2) * Math.PI / 180);
    const eastM = (e - this.origin[0]) * 111320 * Math.cos(((s + n) / 2) * Math.PI / 180);
    const northM = -(n - this.origin[1]) * 110574;
    const southM = -(s - this.origin[1]) * 110574;
    const cx = (westM + eastM) / 2, cz = (northM + southM) / 2;
    const d = Math.max(Math.abs(eastM - westM), Math.abs(southM - northM)) * 0.9;
    this.controls.target.set(cx, 0, cz);
    const dest = new THREE.Vector3(cx, d * 0.55, cz + d);
    if (!fly) {
      this.camera.position.copy(dest);
    } else {
      // fly-in: start high above and settle into the framed view (the
      // Google Earth opening move), animated in the tick loop
      this.flyFrom = new THREE.Vector3(cx, d * 2.4, cz + d * 1.6);
      this.flyTo = dest;
      this.flyT = 0;
    }
    this.controls.update();
    this.dirty = true;
  }

  /* ---------- mini-globe navigation widget ---------- */

  initGlobe() {
    const c = document.getElementById('globe3d');
    if (!c) return;
    this.globeRenderer = new THREE.WebGLRenderer({ canvas: c, antialias: true, alpha: true });
    this.globeRenderer.setPixelRatio(1);
    this.globeScene = new THREE.Scene();
    this.globeCam = new THREE.PerspectiveCamera(40, 1, 0.1, 10);
    this.globeCam.position.set(0, 0, 3.2);
    this.globeScene.add(new THREE.Mesh(new THREE.SphereGeometry(1.05, 24, 18), new THREE.MeshBasicMaterial({ color: 0x2a4d68 })));
    this.globeScene.add(new THREE.Mesh(new THREE.SphereGeometry(1.056, 12, 8), new THREE.MeshBasicMaterial({ color: 0x517aa0, wireframe: true })));
    this.globeDot = new THREE.Mesh(new THREE.SphereGeometry(0.1, 10, 8), new THREE.MeshBasicMaterial({ color: 0xe8632c }));
    this.globeScene.add(this.globeDot);
    let drag = null;
    c.addEventListener('pointerdown', (e) => { drag = { x: e.clientX, y: e.clientY }; c.setPointerCapture(e.pointerId); });
    c.addEventListener('pointermove', (e) => {
      if (!drag) return;
      this.orbitBy((e.clientX - drag.x) * 0.006, (e.clientY - drag.y) * 0.006);
      drag = { x: e.clientX, y: e.clientY };
    });
    c.addEventListener('pointerup', () => { drag = null; });
    c.addEventListener('dblclick', () => this.resetNorth());
  }

  /* Orbit the main camera around the target (what a drag on the widget or
   * canvas means): theta across, phi down, both clamped to the same limits
   * the drag-orbit enforces. */
  orbitBy(dTheta, dPhi) {
    const t = this.controls.target;
    const sph = new THREE.Spherical().setFromVector3(this.camera.position.clone().sub(t));
    sph.theta -= dTheta;
    sph.phi = Math.max(0.05, Math.min(this.controls.maxPolarAngle, sph.phi - dPhi));
    this.camera.position.copy(t).add(new THREE.Vector3().setFromSpherical(sph));
    this.camera.lookAt(t);
    this.dirty = true;
    this.updateCompass();
  }

  /* Back to the default view: looking from the south at ~60° pitch,
   * keeping the current orbit distance. */
  resetNorth() {
    const t = this.controls.target;
    const sph = new THREE.Spherical().setFromVector3(this.camera.position.clone().sub(t));
    sph.theta = 0;
    sph.phi = 1.05;
    this.camera.position.copy(t).add(new THREE.Vector3().setFromSpherical(sph));
    this.camera.lookAt(t);
    this.dirty = true;
    this.updateCompass();
  }

  drawGlobe() {
    if (!this.globeRenderer) return;
    const d = new THREE.Vector3();
    this.camera.getWorldDirection(d);
    // world → globe space: north (world -z) up, world up toward the viewer
    this.globeDot.position.set(d.x, -d.z, d.y).normalize().multiplyScalar(1.08);
    this.globeRenderer.render(this.globeScene, this.globeCam);
  }

  updateCompass() {
    const dir = new THREE.Vector3();
    this.camera.getWorldDirection(dir);
    const az = Math.atan2(dir.x, -dir.z) * (180 / Math.PI);
    const names = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'];
    const el = document.getElementById('compass3d');
    if (el) el.textContent = names[((Math.round(az / 45) % 8) + 8) % 8];
  }

  resize() {
    const overlay = document.getElementById('view3d');
    if (!overlay) return;
    const canvas = overlay.querySelector('canvas');
    const w = window.innerWidth, h = window.innerHeight;   // the bar floats
    this.renderer.setSize(w, h, false);
    canvas.style.width = `${w}px`;
    canvas.style.height = `${h}px`;
    this.camera.aspect = w / Math.max(1, h);
    this.camera.updateProjectionMatrix();
    this.dirty = true;
  }

  disposeTileMeshes(t) {
    for (const key of ['terrain', 'water']) {
      if (t[key]) {
        t.group.remove(t[key]);
        if (t[key].material.map) t[key].material.map.dispose();
        t[key].geometry.dispose();
        t[key].material.dispose();
        t[key] = null;
      }
    }
  }

  close() {
    cancelAnimationFrame(this.raf);
    document.body.classList.remove('in3d');
    window.removeEventListener('keydown', this.onKey, true);
    window.removeEventListener('resize', this.onResize);
    for (const st of this.stream.values()) this.disposeStreamTile(st);
    this.stream.clear();
    for (const t of this.tiles.values()) this.disposeTileMeshes(t);
    this.renderer.dispose();
    const overlay = document.getElementById('view3d');
    if (overlay) overlay.remove();
    if (this.hooks.onClose) this.hooks.onClose();
    controller = null;
  }
}
