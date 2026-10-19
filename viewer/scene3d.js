/* Experimental 3D flood view (docs/3d-view-design.md, docs/3d-view-v4-plan.md): three.js glue.
 *
 * v4: one projection for everything (local web mercator, terrain3d.js), and
 * terrain streamed as web-mercator tiles — AWS Terrain Tiles (terrarium
 * PNGs), or the Geoscience Australia DEM-H service when those can't be
 * reached — each a 33x33 mesh with skirts placed from the tile grid alone, so
 * neighbours meet exactly. Modelled areas contribute water surfaces
 * (positioned by the same projection); the timeline scrub drives them per
 * step. Vertical exaggeration is the world group's scale.y, so the slider
 * never rebuilds anything.
 */
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import {
  makeProjection, parseKey, parentKey, tileToScene, decodeTerrarium, sampleRaster, selectTiles, resolveDraw,
  tileHeights, tileMesh, TILE_SEGS, decimateStep, waterMesh, waterFromFrame,
} from './terrain3d.js';

const EXAG_DEFAULT = 1.5;
const TERRARIUM_URL = (z, x, y) => `https://s3.amazonaws.com/elevation-tiles-prod/terrarium/${z}/${x}/${y}.png`;
const FETCH_CONCURRENCY = { terrarium: 6, demh: 3 };
const MAX_Z = { terrarium: 14, demh: 12 };
const CACHE_CAP = 300;            // built terrain tiles kept
const RETRY_MS = 60000;           // don't refetch a failed tile for a minute
const MIN_Z = 6;                  // quadtree roots (~500 km tiles)
const HEIGHT_GUESS = [-5, 1200];  // a tile's height range until it (or its parent) is known
const FAR = 800000;

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

/* AWS terrarium PNG -> Float32 metres (256x256). Decoded without colour
 * management so the RGB bytes survive exactly. */
async function fetchTerrarium(z, x, y) {
  const res = await fetch(TERRARIUM_URL(z, x, y), { mode: 'cors' });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const blob = await res.blob();
  let bmp;
  try { bmp = await createImageBitmap(blob, { colorSpaceConversion: 'none', premultiplyAlpha: 'none' }); } catch (err) { bmp = await createImageBitmap(blob); }
  const n = bmp.width;
  const c = typeof OffscreenCanvas !== 'undefined' ? new OffscreenCanvas(n, n) : Object.assign(document.createElement('canvas'), { width: n, height: n });
  const ctx = c.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(bmp, 0, 0);
  if (bmp.close) bmp.close();
  return { data: decodeTerrarium(ctx.getImageData(0, 0, n, n).data, n), n };
}

class Scene3d {
  constructor(canvas, hooks) {
    this.hooks = hooks;
    this.dirty = true;
    this.pollCount = 0;
    this.areaTiles = new Map();   // area key -> { area, water, runRef }  (modelled areas: water only)
    this.cache = new Map();       // 'z/x/y' -> terrain tile { key, z, x, y, state, heights, mesh, last }
    this.queue = new Map();       // key -> priority (bigger first)
    this.fetching = 0;
    this.source = 'terrarium';    // or 'demh' after repeated failures
    this.failStreak = 0;
    this.said = new Set();
    this.drawn = new Set();
    this.frame = 0;
    this.fps = 0;
    this.lastNow = 0;
    this.exag = EXAG_DEFAULT;
    this.needSelect = true;
    this.lastSelect = 0;

    // scene origin: the 2D map centre, falling back to the modelled areas.
    // The projection is fixed for the life of the view.
    const centre = hooks.getCentre ? hooks.getCentre() : null;
    let origin = centre && Number.isFinite(centre[0]) && Number.isFinite(centre[1]) ? [centre[1], centre[0]] : null;
    if (!origin) {
      const b = this.areaBox();
      origin = b ? [(b[1] + b[3]) / 2, (b[0] + b[2]) / 2] : [133.8, -25.3];
    }
    this.origin = origin;
    this.proj = makeProjection(origin[0], origin[1]);

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
        #view3dChrome{position:fixed;inset:0;z-index:1004;pointer-events:none}
        #view3dChrome .bar3d{position:absolute;right:14px;bottom:calc(env(safe-area-inset-bottom,0px) + 14px);display:flex;flex-wrap:wrap;max-width:calc(100vw - 28px);gap:8px 14px;align-items:center;padding:9px 14px;background:rgba(10,22,36,.92);color:#dce8f2;font:14px system-ui,sans-serif;border-radius:12px;box-shadow:0 4px 18px rgba(0,0,0,.4);pointer-events:auto}
        #view3dChrome .bar3d label{display:flex;gap:6px;align-items:center}
        #view3dChrome button{font:inherit;color:#dce8f2;background:#17334d;border:1px solid #3d5a75;border-radius:6px;padding:4px 12px;cursor:pointer}
        #view3dChrome .compass{font-weight:600;min-width:2.5em;text-align:center}
        #view3dChrome .dim{font-size:12px;opacity:.75}
        #view3dChrome .attr3d{flex-basis:100%;font-size:11px;opacity:.7;line-height:1.3}
        #globe3dWrap{position:absolute;right:14px;bottom:calc(env(safe-area-inset-bottom,0px) + 76px);width:68px;height:68px;border-radius:50%;background:rgba(8,20,32,.72);border:1px solid #3d5a75;box-shadow:0 4px 18px rgba(0,0,0,.4);cursor:grab;overflow:hidden;pointer-events:auto}
        #globe3dWrap:active{cursor:grabbing}
        #globe3d{width:100%;height:100%;display:block}
      </style>`;

    const bar = document.createElement('div');
    // not `.bar`: styles.css has a global .bar (a 10px progress track) that
    // clipped this to a sliver
    bar.className = 'bar3d';
    bar.innerHTML = `
      <button type="button" id="close3d">Back to map (Esc)</button>
      <label>vertical ×<input id="exag3d" type="range" min="1" max="10" step="0.5" value="${EXAG_DEFAULT}" style="width:120px"><span id="exagVal">${EXAG_DEFAULT}</span></label>
      <span id="scrub3dWrap" hidden><label>step <input id="scrub3d" type="range" min="0" max="0" value="0" style="width:220px"><span id="scrubVal"></span></label></span>
      <span class="compass" id="compass3d">S</span>
      <span id="tiles3d" class="dim"></span>
      <span style="margin-left:auto;font-size:12px;opacity:.75">experimental</span>
      <div class="attr3d" id="attr3d"></div>`;

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
    document.body.appendChild(overlay);
    // the chrome sits on the body, not in #view3d (z-index 5 is its own
    // stacking context, which would keep the bar under the panel cards)
    document.body.appendChild(chrome);
    document.body.classList.add('in3d');   // hide the map fabs (they act on
    // the map we've covered); the bar's Back-to-map handles the way out

    // a logarithmic depth buffer keeps distant terrain from z-fighting with
    // a near plane close enough to see the ground under the camera
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true, logarithmicDepthBuffer: true });
    this.renderer.setPixelRatio(Math.min(devicePixelRatio || 1, 2));

    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color('#0b1622');
    this.camera = new THREE.PerspectiveCamera(55, 1, 5, FAR);
    this.controls = new OrbitControls(this.camera, canvas);
    this.controls.enableDamping = true;   // smooth, Earth-like camera feel
    this.controls.dampingFactor = 0.08;
    this.controls.minDistance = 300;
    this.controls.maxDistance = 400000;
    this.controls.maxPolarAngle = Math.PI / 2 + 0.28;   // ~106°: horizon and a bit past
    this.controls.addEventListener('change', () => { this.dirty = true; this.needSelect = true; this.updateCompass(); });
    // fixed afternoon sun from the north-west + enough ambient for the
    // south faces; lighting stays correct as the camera orbits
    const sun = new THREE.DirectionalLight(0xfff4e0, 2.2);
    sun.position.set(-0.6, 1, -0.5);
    this.scene.add(sun);
    this.scene.add(new THREE.AmbientLight(0xbfd4e8, 1.1));

    // everything on the ground lives under one group, so the vertical
    // exaggeration is a single scale.y
    this.world = new THREE.Group();
    this.world.scale.y = this.exag;
    this.scene.add(this.world);

    this.buildWaterTiles();
    this.frameCamera(true);
    this.initGlobe();
    this.updateAttribution();

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

    const tick = (now) => {
      this.raf = requestAnimationFrame(tick);
      if (this.lastNow) this.fps = this.fps ? this.fps * 0.9 + (1000 / Math.max(1, now - this.lastNow)) * 0.1 : 1000 / Math.max(1, now - this.lastNow);
      this.lastNow = now;
      // fly-in easing (~2s), damping then settles into user control
      if (this.flyT != null && this.flyT < 1) {
        this.flyT = Math.min(1, this.flyT + 1 / 120);
        const t = this.flyT, e = t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2;   // easeInOutQuad
        this.camera.position.lerpVectors(this.flyFrom, this.flyTo, e);
        this.dirty = true; this.needSelect = true;
        if (t >= 1) { this.flyT = null; this.flyFrom = this.flyTo = null; }
      }
      this.controls.update();
      if (!this.camera.position.toArray().every(Number.isFinite) || !this.controls.target.toArray().every(Number.isFinite)) this.frameCamera(false);   // never render from NaN
      this.updateCameraPlanes();
      // terrain selection when the camera moved (or tiles arrived), at most
      // ~8 times a second, and once a second regardless (retries)
      if ((this.needSelect && now - this.lastSelect > 120) || now - this.lastSelect > 1000) { this.lastSelect = now; this.needSelect = false; this.updateTiles(); }
      // late water tiles (inactive places whose analysis was rebuilt)
      if (++this.pollCount >= 45) { this.pollCount = 0; this.pollAreas(); }
      this.drawGlobe();
      if (this.dirty) { this.renderer.render(this.scene, this.camera); this.dirty = false; this.frame++; }
    };
    tick(0);
  }

  /* What the 3D view is doing, for window.__flood3DState (tests, CI). */
  snapshot() {
    const byZoom = {};
    let cached = 0, failed = 0;
    for (const st of this.cache.values()) {
      if (st.state === 'ready') cached++; else if (st.state === 'failed') failed++;
    }
    for (const key of this.drawn) { const z = key.split('/')[0]; byZoom[z] = (byZoom[z] || 0) + 1; }
    return {
      open: !!document.getElementById('view3d'),
      source: this.source,
      tiles: { drawn: this.drawn.size, byZoom, pending: this.fetching + this.queue.size, cached, failed },
      imagery: { loaded: 0, failed: 0 },
      water: [...this.areaTiles.entries()].map(([key, t]) => ({ key, verts: t.water ? t.water.geometry.attributes.position.count : 0 })),
      cam: this.camera.position.toArray().map((v) => Math.round(v)),
      target: this.controls.target.toArray().map((v) => Math.round(v)),
      step: this.step || 0,
      exag: this.exag,
      fps: Math.round(this.fps),
      frames: this.frame,
      dbg: this.dbg || null,
    };
  }

  /* ---------- terrain tiles ---------- */

  maxZ() { return MAX_Z[this.source]; }

  /* The view as selectTiles() wants it: camera, projection, frustum planes
   * and the horizon distance for this altitude. */
  selectionView() {
    this.camera.updateMatrixWorld();
    const f = new THREE.Frustum().setFromProjectionMatrix(new THREE.Matrix4().multiplyMatrices(this.camera.projectionMatrix, this.camera.matrixWorldInverse));
    const cam = this.camera.position.toArray();
    const alt = Math.max(200, cam[1] / this.exag);
    return {
      cam, proj: this.proj, exag: this.exag, minZ: MIN_Z, maxZ: this.maxZ(), cap: 320, thresholdPx: 384,
      focalPx: window.innerHeight / (2 * Math.tan((this.camera.fov * Math.PI) / 360)),
      frustum: f.planes.map((p) => [p.normal.x, p.normal.y, p.normal.z, p.constant]),
      maxDist: Math.min(300000, Math.sqrt(2 * 6371000 * alt) + 60000),
      heightRange: (key) => this.heightRange(key),
    };
  }

  /* [lo, hi] metres for a tile: its own once built, else the nearest built ancestor's. */
  heightRange(key) {
    for (let k = key; k; k = parentKey(k)) {
      const st = this.cache.get(k);
      if (st && st.state === 'ready') return [st.hmin, st.hmax];
    }
    return HEIGHT_GUESS;
  }

  isReady(key) { const st = this.cache.get(key); return !!(st && st.state === 'ready' && st.mesh); }

  updateTiles() {
    const view = this.selectionView();
    const wanted = selectTiles(view);
    const draw = resolveDraw(wanted, (k) => this.isReady(k));
    const cam = view.cam, now = Date.now();
    const want = new Map();   // key -> fetch priority (bigger first)
    const need = (key, pri) => {
      const st = this.cache.get(key);
      if (st && (st.state === 'loading' || st.state === 'ready')) return;
      if (st && st.state === 'failed' && now - st.failAt < RETRY_MS) return;
      if (!(want.get(key) >= pri)) want.set(key, pri);
    };
    for (const key of wanted) {
      const [z, x, y] = parseKey(key), c = tileToScene(this.proj, z, x, y);
      const dx = Math.max(c.x0 - cam[0], 0, cam[0] - c.x1), dz = Math.max(c.z0 - cam[2], 0, cam[2] - c.z1);
      need(key, c.size / Math.max(1, Math.hypot(dx, cam[1], dz)));   // on-screen size
      const st = this.cache.get(key);
      if (st && st.state === 'ready') st.last = this.frame;
      // with nothing built above it yet, fetch the ancestors too, coarsest
      // first: they are what stands in while the detail loads
      let covered = this.isReady(key);
      for (let p = parentKey(key); p && !covered; p = parentKey(p)) {
        if (this.isReady(p)) covered = true;
        else need(p, 1e6 - parseKey(p)[0]);
      }
    }
    this.queue = want;
    this.applyDraw(draw);
    this.kick();
    this.evict(draw);
    this.updateStatus();
  }

  applyDraw(draw) {
    let changed = draw.size !== this.drawn.size;
    for (const key of draw) {
      const st = this.cache.get(key);
      st.last = this.frame;
      if (!this.drawn.has(key)) { st.mesh.visible = true; changed = true; }
    }
    for (const key of this.drawn) {
      if (!draw.has(key)) { const st = this.cache.get(key); if (st && st.mesh) st.mesh.visible = false; changed = true; }
    }
    this.drawn = draw;
    if (changed) this.dirty = true;
  }

  kick() {
    const limit = FETCH_CONCURRENCY[this.source];
    while (this.fetching < limit && this.queue.size) {
      let best = null, bp = -Infinity;
      for (const [k, p] of this.queue) if (p > bp) { best = k; bp = p; }
      this.queue.delete(best);
      this.loadTile(best);
    }
  }

  async loadTile(key) {
    const [z, x, y] = parseKey(key);
    const st = { key, z, x, y, state: 'loading', heights: null, mesh: null, last: this.frame, failAt: 0 };
    this.cache.set(key, st);
    this.fetching++;
    const source = this.source;
    try {
      const raster = source === 'terrarium' ? await fetchTerrarium(z, x, y) : await this.fetchDemhTile(z, x, y);
      if (!this.controls) return;   // closed meanwhile
      if (source === 'terrarium') this.failStreak = 0;
      this.buildTile(st, raster);
    } catch (err) {
      st.state = 'failed'; st.failAt = Date.now();
      if (!this.controls) return;
      if (source === 'terrarium' && ++this.failStreak >= 3 && this.hooks.fetchDemBox) {
        // CORS-blocked or unreachable: use the national DEM for this session
        this.source = 'demh';
        this.failStreak = 0;
        this.say('terrain', "3D: the terrain tile service can't be reached, so the 3D view is using Geoscience Australia's DEM-H (coarser).");
        for (const t of [...this.cache.values()]) if (t.state === 'failed') this.cache.delete(t.key);
        this.updateAttribution();
      } else if (source === 'demh') {
        this.say('terrain-demh', `3D: couldn't fetch terrain here (${(err && err.message) || err}).`);
      }
    } finally {
      this.fetching--;
      this.needSelect = true;
    }
  }

  /* DEM-H for a tile's exact bounds (the fallback source). */
  async fetchDemhTile(z, x, y) {
    const t = tileToScene(this.proj, z, x, y);
    const [w, n] = this.proj.fromScene(t.x0, t.z0), [e, s] = this.proj.fromScene(t.x1, t.z1);
    return this.hooks.fetchDemBox([w, s, e, n], 65);
  }

  buildTile(st, raster) {
    const heightAt = (u, v) => sampleRaster(raster.data, raster.n, u, v);
    st.heights = tileHeights(heightAt, TILE_SEGS);
    const m = tileMesh(this.proj, st.z, st.x, st.y, st.heights, TILE_SEGS);
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(m.positions, 3));
    geo.setAttribute('normal', new THREE.BufferAttribute(m.normals, 3));
    geo.setAttribute('uv', new THREE.BufferAttribute(m.uvs, 2));
    geo.setAttribute('color', new THREE.BufferAttribute(m.colors, 3));
    geo.setIndex(new THREE.BufferAttribute(m.indices, 1));
    st.mesh = new THREE.Mesh(geo, new THREE.MeshLambertMaterial({ vertexColors: true, side: THREE.DoubleSide }));
    st.mesh.position.set(m.origin[0], 0, m.origin[1]);
    st.mesh.visible = false;
    st.hmin = m.hmin; st.hmax = m.hmax;
    st.state = 'ready';
    this.world.add(st.mesh);
  }

  /* LRU: dispose built tiles beyond the cap, oldest first, never ones in use. */
  evict(draw) {
    if (this.cache.size <= CACHE_CAP) return;
    const idle = [...this.cache.values()].filter((st) => st.state !== 'loading' && !draw.has(st.key)).sort((a, b) => a.last - b.last);
    for (const st of idle) {
      if (this.cache.size <= CACHE_CAP) break;
      this.disposeTile(st);
      this.cache.delete(st.key);
    }
  }

  disposeTile(st) {
    if (!st.mesh) return;
    this.world.remove(st.mesh);
    st.mesh.geometry.dispose();
    if (st.mesh.material.map) st.mesh.material.map.dispose();
    st.mesh.material.dispose();
    st.mesh = null;
  }

  say(kind, text) {
    if (this.said.has(kind)) return;
    this.said.add(kind);
    if (this.hooks.onUnsupported) this.hooks.onUnsupported(text);
  }

  updateStatus() {
    const el = document.getElementById('tiles3d');
    if (!el) return;
    const pending = this.fetching + this.queue.size;
    el.textContent = pending ? `loading ${pending} tile${pending === 1 ? '' : 's'}` : `${this.drawn.size} tiles`;
  }

  updateAttribution() {
    const el = document.getElementById('attr3d');
    if (!el) return;
    el.textContent = this.source === 'terrarium'
      ? 'Terrain: AWS Terrain Tiles (Mapzen, SRTM and others)'
      : 'Terrain: Geoscience Australia DEM-H';
  }

  /* Camera clip planes follow the distance, so the near plane stays close
   * to the ground under the camera without wasting depth range. */
  updateCameraPlanes() {
    const d = this.camera.position.distanceTo(this.controls.target);
    const near = Math.max(2, Math.min(500, d * 0.01)), far = FAR;
    if (Math.abs(near - this.camera.near) > near * 0.05 || Math.abs(far - this.camera.far) > far * 0.05) {
      this.camera.near = near; this.camera.far = far;
      this.camera.updateProjectionMatrix();
    }
  }

  /* ---------- modelled areas: water surfaces ---------- */

  pollAreas() {
    const areas = this.hooks.getAreas ? this.hooks.getAreas() : [];
    let added = false;
    for (const area of areas) {
      if (area.a && area.bounds && !this.areaTiles.has(area.key)) { this.addWaterTile(area); added = true; }
    }
    if (added) this.dirty = true;
  }

  buildWaterTiles() {
    const areas = this.hooks.getAreas ? this.hooks.getAreas() : [];
    for (const area of areas) this.addWaterTile(area);
  }

  addWaterTile(area) {
    if (!area || !area.a || !area.bounds || this.areaTiles.has(area.key)) return;
    const t = { area, water: null, runRef: null };
    // per-column x and per-row z in scene metres: mercator is separable, so
    // the water follows the same projection as the terrain tiles
    const [w, s, e, n] = area.bounds, { W, H } = area.a;
    t.colX = new Float64Array(W);
    t.rowZ = new Float64Array(H);
    for (let i = 0; i < W; i++) t.colX[i] = this.proj.xOfLon(w + ((i + 0.5) / W) * (e - w));
    for (let j = 0; j < H; j++) t.rowZ[j] = this.proj.zOfLat(n - ((j + 0.5) / H) * (n - s));
    this.areaTiles.set(area.key, t);
    this.buildTileWater(t, this.hooks.getStep ? this.hooks.getStep() : 0);
    this.dirty = true;
  }

  buildTileWater(t, k) {
    if (t.water) { this.world.remove(t.water); t.water.geometry.dispose(); t.water.material.dispose(); t.water = null; }
    const a = t.area.a;
    const skip = decimateStep(a.W, a.H);
    const opts = { colX: t.colX, rowZ: t.rowZ, lift: 0.05 };
    let m = null;
    const tl = t.area.timeline;
    if (tl && tl.depthFrames && tl.depthFrames.length >= (k + 1) * a.N && tl.depthFrameMax && tl.depthFrameMax.length > k) {
      m = waterFromFrame(a, tl.depthFrames.subarray(k * a.N, (k + 1) * a.N), tl.depthFrameMax[k] || 0, skip, opts).mesh;
    } else if (t.area.run) {
      const r = t.area.run;   // slim runs omit wse; level (= dem + depth) is kept
      m = waterMesh(a, r.level, r.depth, r.wet, skip, opts);
    }
    if (!m) return;
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(m.positions, 3));
    geo.setAttribute('color', new THREE.BufferAttribute(m.colors, 4));
    geo.setIndex(new THREE.BufferAttribute(m.indices, 1));
    geo.computeVertexNormals();
    // depth-scaled per-vertex alpha (shoreline feather) needs RGBA colours.
    // With a logarithmic depth buffer polygonOffset does nothing, so the
    // surface is lifted (0.05 m, in the mesh) and drawn after the terrain.
    const mat = new THREE.MeshLambertMaterial({ vertexColors: true, transparent: true, side: THREE.DoubleSide, depthWrite: false });
    t.water = new THREE.Mesh(geo, mat);
    t.water.renderOrder = 2;
    this.world.add(t.water);
    this.dirty = true;
  }

  /* Scrub/play drives every area that has a timeline; areas without one
   * keep their static run. */
  scrubAll(k) {
    this.step = k;
    for (const t of this.areaTiles.values()) this.buildTileWater(t, k);
    if (this.hooks.onScrub) this.hooks.onScrub(k);   // keeps the 2D view in sync
  }

  activeTimeline() {
    for (const t of this.areaTiles.values()) if (t.area.active && t.area.timeline) return t.area.timeline;
    return null;
  }

  /* Called by the app after the 2D view redraws; picks up new/removed areas
   * and changed runs (water rebuilds by run identity). */
  refresh() {
    const areas = this.hooks.getAreas ? this.hooks.getAreas() : [];
    const seen = new Set();
    for (const area of areas) {
      seen.add(area.key);
      if (!area.a || !area.bounds) continue;
      if (!this.areaTiles.has(area.key)) { this.addWaterTile(area); continue; }
      const t = this.areaTiles.get(area.key);
      t.area = area;
      const run = area.run;
      if (run !== t.runRef) {
        t.runRef = run;
        if (!t.area.timeline) this.buildTileWater(t, this.hooks.getStep ? this.hooks.getStep() : this.step);
      }
    }
    for (const [key, t] of this.areaTiles) {
      if (!seen.has(key)) {   // the area was removed from the map
        if (t.water) { this.world.remove(t.water); t.water.geometry.dispose(); t.water.material.dispose(); t.water = null; }
        this.areaTiles.delete(key);
      }
    }
    this.dirty = true;
  }

  setExaggeration(x) {
    this.exag = x;
    this.world.scale.y = x;
    this.needSelect = true;
    this.dirty = true;
  }

  /* [s, w, n, e] of the modelled areas, the fallback framing when the 2D
   * map can't tell us what it was showing (hidden or not yet sized). */
  areaBox() {
    const areas = this.hooks.getAreas ? this.hooks.getAreas() : [];
    let box = null;
    for (const ar of areas) {
      const b = ar.bounds;   // [w, s, e, n]
      if (!b || !b.every(Number.isFinite)) continue;
      box = box ? [Math.min(box[0], b[1]), Math.min(box[1], b[0]), Math.max(box[2], b[3]), Math.max(box[3], b[2])] : [b[1], b[0], b[3], b[2]];
    }
    return box;
  }

  frameCamera(fly = false) {
    // frame the ground the 2D map was showing when the view opened. The
    // box must be real: a hidden or unsized Leaflet map reports a
    // degenerate one, which put the camera on its own target (NaN orbit).
    const okBox = (b) => b && b.length === 4 && b.every(Number.isFinite) && b[2] > b[0] && b[3] > b[1] && (b[3] - b[1]) * 111320 * Math.cos(((b[0] + b[2]) / 2) * Math.PI / 180) > 300;
    let box = this.hooks.getViewBox ? this.hooks.getViewBox() : null;
    if (!okBox(box)) box = this.areaBox();
    if (!okBox(box)) box = [this.origin[1] - 0.05, this.origin[0] - 0.05, this.origin[1] + 0.05, this.origin[0] + 0.05];
    const [s, w, n, e] = box;
    const [xw, zn] = this.proj.toScene(w, n), [xe, zs] = this.proj.toScene(e, s);
    const cx = (xw + xe) / 2, cz = (zn + zs) / 2;
    const d = Math.max(Math.abs(xe - xw), Math.abs(zs - zn), 2000) * 0.9;
    this.dbg = { box, origin: this.origin.slice(), d: Math.round(d) };
    this.controls.target.set(cx, 0, cz);
    const dest = new THREE.Vector3(cx, d * 0.55, cz + d);
    // always start the camera at a real distance from the target:
    // OrbitControls.update() on position == target is where NaN came from
    this.camera.position.copy(dest);
    if (fly) {
      // fly-in: start high above and settle into the framed view (the
      // Google Earth opening move), animated in the tick loop
      this.flyFrom = new THREE.Vector3(cx, d * 2.4, cz + d * 1.6);
      this.flyTo = dest;
      this.flyT = 0;
      this.camera.position.copy(this.flyFrom);
    }
    this.controls.update();
    this.needSelect = true;
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
    this.needSelect = true;
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
    this.needSelect = true;
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

  close() {
    cancelAnimationFrame(this.raf);
    document.body.classList.remove('in3d');
    window.removeEventListener('keydown', this.onKey, true);
    window.removeEventListener('resize', this.onResize);
    for (const st of this.cache.values()) this.disposeTile(st);
    this.cache.clear();
    this.queue.clear();
    for (const t of this.areaTiles.values()) {
      if (t.water) { t.water.geometry.dispose(); t.water.material.dispose(); }
    }
    this.areaTiles.clear();
    this.controls.dispose();
    this.renderer.dispose();
    if (this.globeRenderer) this.globeRenderer.dispose();
    this.controls = null;
    const overlay = document.getElementById('view3d');
    if (overlay) overlay.remove();
    const chrome = document.getElementById('view3dChrome');
    if (chrome) chrome.remove();
    if (this.hooks.onClose) this.hooks.onClose();
    controller = null;
  }
}
