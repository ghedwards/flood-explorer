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
import { MapControls } from 'three/addons/controls/MapControls.js';
import {
  makeProjection, parseKey, parentKey, tileToScene, decodeTerrarium, sampleRaster, selectTiles, resolveDraw,
  tileHeights, tileMesh, tileGroundAt, BANDS3D, tileAt, TILE_SEGS, decimateStep, waterMesh, waterFromFrame, overrideHeight, boxesOverlap,
} from './terrain3d.js';

const EXAG_DEFAULT = 1.5;
const TERRARIUM_URL = (z, x, y) => `https://s3.amazonaws.com/elevation-tiles-prod/terrarium/${z}/${x}/${y}.png`;
const FETCH_CONCURRENCY = { terrarium: 6, demh: 3 };
const MAX_Z = { terrarium: 14, demh: 12 };
// imagery keeps refining past the terrain's finest level: tiles below it
// borrow their heights from that level's raster (upsampled) and load their
// own, sharper picture
const IMG_MAX_Z = 18;
const VIRTUAL_PER_SELECT = 24;    // upsampled tiles built per selection pass (cheap, but bounded)
// height grids kept at the terrain's finest level for building the tiles
// below it (~256 KB each); older ones are dropped and re-read from the
// browser's cache when needed again (same data, so no loss of detail)
const RASTER_KEEP = 32;
const CACHE_CAP = 300;            // built terrain tiles kept
const RETRY_MS = 60000;           // don't refetch a failed tile for a minute
const MIN_Z = 6;                  // quadtree roots (~500 km tiles)
const HEIGHT_GUESS = [-5, 1200];  // a tile's height range until it (or its parent) is known
const FAR = 800000;
const IMG_CONCURRENCY = 8;
const IMG_MATCH_Z = 13;           // Esri's coarser levels are differently processed mosaics: match them to z13's tone
const SKY_TOP = '#2f6aa8', SKY_HORIZON = '#c9dbe8';   // zenith, and the haze distant terrain fades into
const MAX_SEGS = 128;             // finer tile meshes where a model DEM replaces the terrain
const MAX_ANISO = 8;

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

function loadImage(url) {
  return new Promise((resolve, reject) => {
    const im = new Image();
    im.crossOrigin = 'anonymous';
    im.onload = () => resolve(im);
    im.onerror = () => reject(new Error('image'));
    im.src = url;
  });
}

// mean and standard deviation per channel (linear light) of a region, on a 16x16 grid
function statsRGB(im, sx, sy, sw, sh) {
  const c = document.createElement('canvas');
  c.width = c.height = 16;
  const ctx = c.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(im, sx, sy, sw, sh, 0, 0, 16, 16);
  const d = ctx.getImageData(0, 0, 16, 16).data, m = [0, 0, 0], q = [0, 0, 0], n = 256;
  for (let i = 0; i < d.length; i += 4) for (let k = 0; k < 3; k++) { const v = Math.pow(d[i + k] / 255, 2.2); m[k] += v; q[k] += v * v; }
  return { m: m.map((v) => v / n), s: q.map((v, k) => Math.sqrt(Math.max(0, v / n - (m[k] / n) ** 2))) };
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
    this.source = 'terrarium';    // or 'demh' after repeated failures, or when forced (?terrain3d=demh, for testing the fallback)
    try { if (hooks.fetchDemBox && new URLSearchParams(location.search).get('terrain3d') === 'demh') this.source = 'demh'; } catch (err) { /* no location */ }
    this.failStreak = 0;
    this.said = new Set();
    this.drawn = new Set();
    this.frame = 0;
    this.fps = 0;
    this.lastNow = 0;
    this.exag = EXAG_DEFAULT;
    this.needSelect = true;
    this.lastSelect = 0;
    this.knownBounds = [];        // [w, s, e, n] of every modelled area (tiles over them keep their raster)
    this.rasterLru = new Map();   // finest-level tile key -> true, oldest first (see RASTER_KEEP)
    this.areaSig = '';
    this.imgQueue = new Map();    // tile key -> priority (imagery waiting to load)
    this.imgLoading = 0;
    this.gains = {};              // imagery zoom (< 13) -> [r, g, b] linear multipliers that match its tone to z13's
    this.offs = {};               // ...and the matching [r, g, b] linear offsets (contrast and haze differ between mosaics, not just brightness)
    this.calibAt = null;          // scene [x, z] where the tone match was last measured
    this.imgLoaded = 0;
    this.imgFailed = 0;
    this.basemap = hooks.getBasemap ? hooks.getBasemap() : null;
    this.imageryOn = !!this.basemap;   // else relief colours only
    this.texLoader = new THREE.TextureLoader();
    this.texLoader.setCrossOrigin('anonymous');

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
        #view3dChrome .bar3d{position:absolute;left:50%;transform:translateX(-50%);bottom:calc(env(safe-area-inset-bottom,0px) + 22px);width:min(560px,calc(100vw - 2 * var(--gap,12px)));display:flex;flex-direction:column;overflow:hidden;background:var(--surface,#fff);color:var(--ink,#12202a);font:400 13px/1.35 var(--font-body,system-ui,sans-serif);border-radius:12px;box-shadow:var(--shadow,0 4px 18px rgba(0,0,0,.3));pointer-events:auto}
        #view3dChrome .head3d{display:flex;align-items:center;gap:10px;padding:8px 10px 8px 14px}
        #view3dChrome .title3d{font:700 1rem/1.2 var(--font-display,system-ui);font-stretch:85%;white-space:nowrap}
        #view3dChrome .dim{flex:1;min-width:0;font-size:12px;color:var(--muted,#586874);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
        #view3dChrome button{font:600 13px var(--font-body,system-ui);cursor:pointer}
        #view3dChrome #close3d{border:1px solid var(--accent,#0d5f8c);background:var(--accent,#0d5f8c);color:var(--accent-ink,#fff);border-radius:7px;padding:5px 12px;white-space:nowrap}
        #view3dChrome .fold3d{border:0;background:none;color:var(--ink,#12202a);padding:2px;display:flex}
        #view3dChrome .fold3d svg{width:20px;height:20px;stroke:currentColor;fill:none;stroke-width:2;transition:transform .15s}
        #view3dChrome .bar3d.collapsed .fold3d svg{transform:rotate(-90deg)}
        #view3dChrome .bar3d.collapsed .body3d{display:none}
        #view3dChrome .body3d{display:grid;gap:8px;padding:10px 14px 10px;border-top:1px solid var(--line,#d3dce2)}
        #view3dChrome .row3d{display:flex;flex-wrap:wrap;align-items:center;gap:8px 16px}
        #view3dChrome .row3d label{display:flex;gap:8px;align-items:center;color:var(--muted,#586874)}
        #view3dChrome .row3d input[type=range]{width:130px;accent-color:var(--accent,#0d5f8c)}
        #view3dChrome .val3d{font-variant-numeric:tabular-nums;color:var(--ink,#12202a);min-width:2.6em}
        #view3dChrome #mode3d{display:inline-flex;padding:0;border:1px solid var(--line,#d3dce2);border-radius:7px;background:var(--surface-2,#f4f7f9);overflow:hidden}
        #view3dChrome #mode3d span{padding:4px 10px;color:var(--muted,#586874)}
        #view3dChrome #mode3d span.on{background:var(--accent,#0d5f8c);color:var(--accent-ink,#fff)}
        #view3dChrome .key3d{display:flex;flex-wrap:wrap;gap:4px 12px;align-items:center;font-size:12px;color:var(--muted,#586874)}
        #view3dChrome .key3d i{display:inline-block;width:14px;height:10px;border-radius:2px;vertical-align:-1px;margin-right:5px}
        #view3dChrome .attr3d{font-size:11px;color:var(--muted,#586874);line-height:1.3}
        @media (max-width:760px){#view3dChrome .bar3d{bottom:calc(var(--bar,64px) + env(safe-area-inset-bottom,0px) + 8px)}#globe3dWrap{bottom:calc(var(--bar,64px) + env(safe-area-inset-bottom,0px) + 70px) !important}}
        #globe3dWrap{position:absolute;right:14px;bottom:calc(env(safe-area-inset-bottom,0px) + 22px);width:68px;height:68px;border-radius:50%;background:rgba(8,20,32,.72);border:1px solid #3d5a75;box-shadow:0 4px 18px rgba(0,0,0,.4);cursor:grab;overflow:hidden;pointer-events:auto}
        #globe3dWrap:active{cursor:grabbing}
        #globe3d{width:100%;height:100%;display:block}
      </style>`;

    const bar = document.createElement('div');
    // not `.bar`: styles.css has a global .bar (a 10px progress track) that
    // clipped this to a sliver
    bar.className = 'bar3d';
    bar.innerHTML = `
      <div class="head3d">
        <span class="title3d">3D view</span>
        <span id="tiles3d" class="dim"></span>
        <button type="button" id="close3d" title="Back to the map (Esc)">Back to map</button>
        <button type="button" class="fold3d" id="fold3d" aria-expanded="true" aria-label="Show or hide the 3D controls"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="m6 9 6 6 6-6"/></svg></button>
      </div>
      <div class="body3d">
        <div class="row3d">
          <label title="Vertical exaggeration: stretches heights so low relief reads">Height ×<input id="exag3d" type="range" min="1" max="10" step="0.5" value="${EXAG_DEFAULT}"><span class="val3d" id="exagVal">${EXAG_DEFAULT}</span></label>
          <button type="button" id="mode3d" title="Satellite/map imagery or plain relief colours" aria-pressed="false"><span data-m="img">Imagery</span><span data-m="rel">Relief</span></button>
        </div>
        <div class="row3d" id="scrub3dWrap" hidden><label>Time step <input id="scrub3d" type="range" min="0" max="0" value="0" style="width:200px"><span class="val3d" id="scrubVal"></span></label></div>
        <div class="key3d" title="Flood depth">Depth ${['<0.5', '0.5\u20131', '1\u20132', '2\u20134', '>4 m'].map((t, i) => `<span><i style="background:rgb(${BANDS3D[i][1].join(',')})"></i>${t}</span>`).join('')}</div>
        <div class="attr3d" id="attr3d"></div>
      </div>`;

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
    // Google-Earth-like: left-drag pans along the ground, right-drag (or two
    // fingers) turns and tilts, the wheel zooms toward the cursor
    this.controls = new MapControls(this.camera, canvas);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.08;
    this.controls.screenSpacePanning = false;
    this.controls.zoomToCursor = true;
    this.controls.minDistance = 150;
    this.controls.maxDistance = 400000;
    this.controls.maxPolarAngle = (85 * Math.PI) / 180;   // never look up from underground
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

    // sky: a gradient dome that follows the camera, and fog in its horizon
    // colour so coarse distant tiles fade into haze instead of ending
    this.sky = this.buildSky();
    this.scene.add(this.sky);
    this.scene.fog = new THREE.Fog(SKY_HORIZON, 50000, 200000);
    this.scene.background = new THREE.Color(SKY_HORIZON);
    this.raycaster = new THREE.Raycaster();
    canvas.addEventListener('dblclick', (e) => this.flyToPoint(e));

    this.buildWaterTiles();
    this.syncAreas();
    this.frameCamera(true);
    this.initGlobe();
    this.updateAttribution();

    const close = bar.querySelector('#close3d');
    close.addEventListener('click', () => closeScene3d());
    this.onKey = (e) => { if (e.key === 'Escape') { e.stopPropagation(); closeScene3d(); } };
    window.addEventListener('keydown', this.onKey, true);
    const modeBtn = bar.querySelector('#mode3d');
    modeBtn.hidden = !this.basemap;
    this.syncModeBtn();
    modeBtn.addEventListener('click', () => {
      this.imageryOn = !this.imageryOn;
      this.syncModeBtn();
      this.applyImageryMode();
    });
    const fold = bar.querySelector('#fold3d');
    fold.addEventListener('click', () => {
      const open = fold.getAttribute('aria-expanded') === 'true';
      fold.setAttribute('aria-expanded', String(!open));
      bar.classList.toggle('collapsed', open);
    });
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
      // fly animations (the opening move, double-click to a point): ~2 s of easing,
      // then damping settles into user control
      if (this.anim) {
        const an = this.anim;
        an.t = Math.min(1, an.t + 1 / an.frames);
        const t = an.t, e = t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2;   // easeInOutQuad
        this.camera.position.lerpVectors(an.camFrom, an.camTo, e);
        this.controls.target.lerpVectors(an.tgtFrom, an.tgtTo, e);
        this.dirty = true; this.needSelect = true;
        if (t >= 1) this.anim = null;
      }
      this.controls.update();
      if (!this.anim) this.followGround();
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
      memory: (() => {   // height grids held (each distinct array once) and imagery textures
        const seen = new Set(); let bytes = 0, tex = 0;
        for (const st of this.cache.values()) {
          if (st.raster && !seen.has(st.raster.data)) { seen.add(st.raster.data); bytes += st.raster.data.byteLength; }
          if (st.tex) tex++;
        }
        return { heightGrids: seen.size, heightMB: +(bytes / 1048576).toFixed(1), textures: tex, textureMB: +(tex * 0.33).toFixed(0) };
      })(),
      imagery: { on: this.imageryOn, loaded: this.imgLoaded, failed: this.imgFailed, pending: this.imgLoading + this.imgQueue.size },
      water: [...this.areaTiles.entries()].map(([key, t]) => ({ key, verts: t.water ? t.water.geometry.attributes.position.count : 0 })),
      cam: this.camera.position.toArray().map((v) => Math.round(v)),
      target: this.controls.target.toArray().map((v) => Math.round(v)),
      step: this.step || 0,
      exag: this.exag,
      fps: Math.round(this.fps),
      frames: this.frame,
      gains: Object.fromEntries(Object.entries(this.gains).map(([l, g]) => [l, g.map((v) => +v.toFixed(2))])),
      offs: Object.fromEntries(Object.entries(this.offs).map(([l, g]) => [l, g.map((v) => +v.toFixed(3))])),
      ground: this.groundAt(this.controls.target.x, this.controls.target.z),
      dbg: this.dbg || null,
    };
  }

  /* ---------- terrain tiles ---------- */

  maxZ() { return MAX_Z[this.source]; }

  /* Deepest level the tile tree splits to: the terrain's, or with imagery
   * on, the basemap's finest (capped) — deeper tiles reuse terrain heights. */
  drawMaxZ() {
    const tz = this.maxZ();
    if (!this.imageryOn || !this.basemap) return tz;
    return Math.max(tz, Math.min(IMG_MAX_Z, this.basemap.maxZoom || IMG_MAX_Z));
  }

  /* A tile below the terrain's finest level: same heights as its ancestor at
   * that level (a sub-rectangle of its raster), its own mesh and imagery. */
  buildVirtual(key, anc) {
    const [z, x, y] = parseKey(key), d = z - anc.z, s = 1 / 2 ** d;
    const raster = { data: anc.raster.data, n: anc.raster.n, sub: [(x - (anc.x << d)) * s, (y - (anc.y << d)) * s, s] };
    const st = { key, z, x, y, state: 'loading', heights: null, mesh: null, last: this.frame, failAt: 0, virtual: true };
    this.cache.set(key, st);
    this.rasterLru.delete(anc.key); this.rasterLru.set(anc.key, true);   // recently used
    this.buildTile(st, raster);
    this.needSelect = true;
  }

  /* The view as selectTiles() wants it: camera, projection, frustum planes
   * and the horizon distance for this altitude. */
  selectionView() {
    this.camera.updateMatrixWorld();
    const f = new THREE.Frustum().setFromProjectionMatrix(new THREE.Matrix4().multiplyMatrices(this.camera.projectionMatrix, this.camera.matrixWorldInverse));
    const cam = this.camera.position.toArray();
    const alt = Math.max(200, cam[1] / this.exag);
    return {
      cam, proj: this.proj, exag: this.exag, minZ: MIN_Z, maxZ: this.drawMaxZ(), cap: 360, thresholdPx: 384,
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
    const tz = this.maxZ();
    let virtualBudget = VIRTUAL_PER_SELECT;
    const need = (key, pri) => {
      const st = this.cache.get(key);
      if (st && (st.state === 'loading' || st.state === 'ready')) return;
      if (st && st.state === 'failed' && now - st.failAt < RETRY_MS) return;
      const [z, x, y] = parseKey(key);
      if (z > tz) {
        // below the terrain's finest level: built from that ancestor's raster
        const d = z - tz, anc = this.cache.get(`${tz}/${x >> d}/${y >> d}`);
        if (anc && anc.state === 'ready' && anc.raster) { if (virtualBudget-- > 0) this.buildVirtual(key, anc); }
        else if (anc && anc.state === 'ready' && anc.rasterGone) this.reloadRaster(anc);
        else need(`${tz}/${x >> d}/${y >> d}`, pri);
        return;
      }
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
    this.updateImagery(draw, cam);
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

  /* Modelled areas that have their analysis, as the height override wants them. */
  overrideAreas() {
    const out = [];
    for (const t of this.areaTiles.values()) if (t.area.a && t.area.bounds) out.push({ bounds: t.area.bounds, a: t.area.a });
    return out;
  }

  /* Inside a modelled area the ground IS the model's DEM (what the flood was
   * computed on), so the water surface sits exactly on it; the tile source
   * supplies the rest. Tiles over an area also get a finer vertex grid, so
   * the river channel isn't smoothed away, and keep their raster so they
   * can be rebuilt when an area arrives or leaves. */
  buildTile(st, raster) {
    const t = tileToScene(this.proj, st.z, st.x, st.y);
    const [w, n] = this.proj.fromScene(t.x0, t.z0), [e, s] = this.proj.fromScene(t.x1, t.z1);
    const box = [w, s, e, n];
    const areas = this.overrideAreas().filter((ar) => boxesOverlap(box, ar.bounds));
    // kept for rebuilds under modelled areas, and (a bounded few, see
    // RASTER_KEEP) at the terrain's finest level for the tiles below it.
    // Tiles below that level only keep a reference to their ancestor's grid
    // over a modelled area (to rebuild there); elsewhere they let it go
    const overArea = this.knownBounds.some((b) => boxesOverlap(box, b));
    st.overArea = overArea;
    st.raster = overArea || (!raster.sub && st.z === this.maxZ()) ? raster : null;
    st.rasterGone = false;
    if (st.raster && !raster.sub && !overArea) { this.rasterLru.delete(st.key); this.rasterLru.set(st.key, true); this.trimRasters(); }
    let segs = TILE_SEGS;
    if (areas.length) {
      const spacing = Math.max(25, ...areas.map((ar) => ar.a.cell || 0));
      segs = Math.max(TILE_SEGS, Math.min(MAX_SEGS, Math.ceil(t.size / spacing)));
    }
    const sub = raster.sub;
    const heightAt = (u, v) => {
      const h = sub ? sampleRaster(raster.data, raster.n, sub[0] + u * sub[2], sub[1] + v * sub[2]) : sampleRaster(raster.data, raster.n, u, v);
      return areas.length ? overrideHeight(h, areas, w + u * (e - w), this.proj.fromScene(t.x0, t.z0 + v * (t.z1 - t.z0))[1]) : h;
    };
    st.heights = tileHeights(heightAt, segs);
    st.segs = segs;
    const m = tileMesh(this.proj, st.z, st.x, st.y, st.heights, segs);
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(m.positions, 3));
    geo.setAttribute('normal', new THREE.BufferAttribute(m.normals, 3));
    geo.setAttribute('uv', new THREE.BufferAttribute(m.uvs, 2));
    geo.setAttribute('color', new THREE.BufferAttribute(m.colors, 3));
    geo.setIndex(new THREE.BufferAttribute(m.indices, 1));
    const mat = new THREE.MeshLambertMaterial({ vertexColors: true, side: THREE.DoubleSide });
    // imagery tone match = material colour (gain) + this offset, added to the
    // sampled picture (linear light) — see calibrateImagery
    mat.userData.uOff = { value: new THREE.Vector3() };
    mat.onBeforeCompile = (sh) => {
      sh.uniforms.uOff = mat.userData.uOff;
      sh.fragmentShader = `uniform vec3 uOff;\n${sh.fragmentShader.replace('#include <map_fragment>', '#include <map_fragment>\n#ifdef USE_MAP\ndiffuseColor.rgb = clamp(diffuseColor.rgb + uOff, 0.0, 1.0);\n#endif')}`;
    };
    mat.customProgramCacheKey = () => 'toneOffset';
    st.mesh = new THREE.Mesh(geo, mat);
    st.mesh.position.set(m.origin[0], 0, m.origin[1]);
    st.mesh.visible = false;
    st.hmin = m.hmin; st.hmax = m.hmax;
    st.uv0 = m.uvs.slice();   // the tile's own 0..1 UVs; imagery from an ancestor re-maps them
    if (st.tex === undefined) { st.tex = null; st.imgState = null; st.imgFrom = null; }
    st.state = 'ready';
    this.world.add(st.mesh);
  }

  /* Drop the oldest kept height grids beyond RASTER_KEEP (not ones over a
   * modelled area); reloadRaster brings one back when it's needed. */
  trimRasters() {
    for (const key of this.rasterLru.keys()) {
      if (this.rasterLru.size <= RASTER_KEEP) break;
      this.rasterLru.delete(key);
      const st = this.cache.get(key);
      if (st && st.raster && !st.overArea) { st.raster = null; st.rasterGone = true; }
    }
  }

  /* Re-read a dropped height grid (the browser's cache answers, so no
   * download); then optionally rebuild the tile with it. */
  reloadRaster(st, rebuild) {
    if (st.rasterLoading) return;
    st.rasterLoading = true;
    const source = this.source;
    (source === 'terrarium' ? fetchTerrarium(st.z, st.x, st.y) : this.fetchDemhTile(st.z, st.x, st.y)).then((raster) => {
      if (!this.controls || this.cache.get(st.key) !== st) return;
      if (rebuild && st.mesh) {
        const was = st.mesh, visible = was.visible;
        this.world.remove(was); was.geometry.dispose(); was.material.dispose();
        this.buildTile(st, raster);
        st.mesh.visible = visible; st.imgFrom = null;
      } else {
        st.raster = raster; st.rasterGone = false;
        this.rasterLru.delete(st.key); this.rasterLru.set(st.key, true); this.trimRasters();
      }
      this.needSelect = true; this.dirty = true;
    }).catch(() => { /* stays dropped; tried again when next needed */ }).finally(() => { st.rasterLoading = false; });
  }

  /* Rebuild the terrain under modelled areas when the set of areas (or
   * their grids) changes: swap geometry, keep the tile's imagery. */
  syncAreas() {
    const areas = this.hooks.getAreas ? this.hooks.getAreas() : [];
    this.knownBounds = areas.filter((a) => a.bounds && a.bounds.every(Number.isFinite)).map((a) => a.bounds);
    const sig = areas.map((a) => (a.a && a.bounds ? `${a.key}:${a.a.W}x${a.a.H}:${a.bounds.join(',')}` : '')).join('|');
    if (sig === this.areaSig) return;
    this.areaSig = sig;
    const tz = this.maxZ();
    for (const st of [...this.cache.values()]) {
      if (st.state !== 'ready') continue;
      if (!st.raster) {
        if (!this.knownBounds.length) continue;
        const t = tileToScene(this.proj, st.z, st.x, st.y);
        const [w, n] = this.proj.fromScene(t.x0, t.z0), [e, s2] = this.proj.fromScene(t.x1, t.z1);
        if (!this.knownBounds.some((b) => boxesOverlap([w, s2, e, n], b))) continue;
        // over a modelled area but its grid was let go: a tile below the
        // terrain's finest level is rebuilt from its ancestor, a finest-level
        // tile re-reads its grid
        if (st.virtual) { this.disposeTile(st); this.cache.delete(st.key); this.rasterLru.delete(st.key); }
        else if (st.z === tz && st.rasterGone) this.reloadRaster(st, true);
        continue;
      }
      const was = st.mesh, visible = was.visible;
      this.world.remove(was);
      was.geometry.dispose(); was.material.dispose();
      this.buildTile(st, st.raster);
      st.mesh.visible = visible;
      st.imgFrom = null;   // dress() puts the texture back on the new mesh
    }
    this.needSelect = true;
    this.dirty = true;
  }

  /* LRU: dispose built tiles beyond the cap, oldest first, never ones in use. */
  evict(draw) {
    if (this.cache.size <= CACHE_CAP) return;
    // a drawn tile may be wearing an ancestor's texture: keep those alive
    const lent = new Set();
    for (const k of draw) { const st = this.cache.get(k); if (st && st.imgFrom) lent.add(st.imgFrom); }
    const idle = [...this.cache.values()].filter((st) => st.state !== 'loading' && !draw.has(st.key) && !lent.has(st.key)).sort((a, b) => a.last - b.last);
    for (const st of idle) {
      if (this.cache.size <= CACHE_CAP) break;
      this.disposeTile(st);
      this.cache.delete(st.key);
      this.rasterLru.delete(st.key);
    }
  }

  disposeTile(st) {
    if (!st.mesh) return;
    this.world.remove(st.mesh);
    st.mesh.geometry.dispose();
    st.mesh.material.dispose();
    if (st.tex) st.tex.dispose();
    st.tex = null;
    st.mesh = null;
  }

  /* ---------- imagery: each tile loads its own picture from the active basemap ---------- */

  imageUrl(z, x, y) {
    const b = this.basemap, subs = b.subdomains || '';
    return b.template.replace('{s}', subs ? subs[(x + y) % subs.length] : '').replace('{z}', z).replace('{x}', x).replace('{y}', y).replace('{r}', '');
  }

  /* Queue imagery for drawn tiles lacking it, then dress every drawn tile
   * with its own texture, else the nearest ancestor's (a sub-rect of it),
   * else relief colours. */
  updateImagery(draw, cam) {
    if (!this.imageryOn || !this.basemap) return;
    for (const key of draw) {
      const st = this.cache.get(key);
      if (st.tex || st.imgState === 'loading' || (st.imgState === 'failed' && Date.now() - st.imgFailAt < RETRY_MS)) continue;
      const [z, x, y] = parseKey(key), c = tileToScene(this.proj, z, x, y);
      const dx = Math.max(c.x0 - cam[0], 0, cam[0] - c.x1), dz = Math.max(c.z0 - cam[2], 0, cam[2] - c.z1);
      this.imgQueue.set(key, c.size / Math.max(1, Math.hypot(dx, cam[1], dz)));
    }
    for (const key of [...this.imgQueue.keys()]) if (!draw.has(key)) this.imgQueue.delete(key);
    while (this.imgLoading < IMG_CONCURRENCY && this.imgQueue.size) {
      let best = null, bp = -Infinity;
      for (const [k, p] of this.imgQueue) if (p > bp) { best = k; bp = p; }
      this.imgQueue.delete(best);
      this.loadImagery(this.cache.get(best));
    }
    for (const key of draw) this.dress(this.cache.get(key));
  }

  loadImagery(st) {
    st.imgState = 'loading';
    this.imgLoading++;
    const epoch = this.imgEpoch || 0;
    this.texLoader.load(this.imageUrl(st.z, st.x, st.y), (tex) => {
      this.imgLoading--;
      if (!this.controls || !st.mesh || this.cache.get(st.key) !== st || epoch !== (this.imgEpoch || 0)) { tex.dispose(); return; }
      tex.colorSpace = THREE.SRGBColorSpace;
      tex.anisotropy = Math.min(MAX_ANISO, this.renderer.capabilities.getMaxAnisotropy());
      st.tex = tex; st.imgState = 'ready';
      this.imgLoaded++;
      this.calibrateImagery();
      this.needSelect = true;
    }, undefined, () => {
      this.imgLoading--;
      if (epoch !== (this.imgEpoch || 0)) return;
      st.imgState = 'failed'; st.imgFailAt = Date.now();
      this.imgFailed++;
      if (this.controls && this.imgLoaded === 0 && this.imgFailed >= 8) {
        // the basemap can't be used as texture (CORS, outage): plain relief
        this.say('imagery', "3D: couldn't load imagery for the terrain, showing relief colours instead.");
        this.imageryOn = false;
        this.syncModeBtn();
        this.applyImageryMode();
      }
      this.needSelect = true;
    });
  }

  /* Esri's imagery changes character with zoom (Landsat-like mosaics when
   * coarse, Maxar when fine), which showed as straight tonal bands where
   * tiles of different levels meet. Measure it where the user is looking:
   * at the tile under the orbit target at each level z6..13, compare the
   * average colour of the quadrant that holds the next level's tile with
   * that tile as a whole (same ground), and chain the ratios into a
   * per-channel (linear) gain bringing each level to z13's tone. dress()
   * applies it as the material colour. Re-measured when the target has
   * moved far (different ground, different mosaic). */
  async calibrateImagery() {
    if (this.calibBusy || !this.basemap || !/satellite/i.test(this.basemap.name)) return;
    const epoch = this.imgEpoch || 0;   // a basemap switch mid-measurement makes the result stale
    const t = this.controls.target;
    if (this.calibAt && Math.hypot(t.x - this.calibAt[0], t.z - this.calibAt[1]) < 60000) return;
    this.calibBusy = true;
    const at = [t.x, t.z], lo = 6;
    // five spots (the target and four around it): one patch of ground can
    // be sea, cloud or a town and say little about the mosaic as a whole
    const spots = [[0, 0], [25000, 0], [-25000, 0], [0, 25000], [0, -25000]];
    const sums = {}, counts = {};
    await Promise.all(spots.map(async ([ox, oz]) => {
      try {
        const px = at[0] + ox, pz = at[1] + oz;
        const imgs = await Promise.all(Array.from({ length: IMG_MATCH_Z - lo + 1 }, (_, k) => {
          const [x, y] = tileAt(this.proj, lo + k, px, pz);
          return loadImage(this.imageUrl(lo + k, x, y));
        }));
        for (let l = IMG_MATCH_Z - 1; l >= lo; l--) {
          const parent = imgs[l - lo], child = imgs[l + 1 - lo];
          const [cx, cy] = tileAt(this.proj, l + 1, px, pz);
          const w = parent.naturalWidth / 2, h = parent.naturalHeight / 2;
          const p = statsRGB(parent, (cx & 1) * w, (cy & 1) * h, w, h), c = statsRGB(child, 0, 0, child.naturalWidth, child.naturalHeight);
          // the affine map taking this level's tone to the next level's: scale
          // from the spread, offset so the means agree
          const sc = p.s.map((ps, k) => Math.max(0.6, Math.min(1.7, c.s[k] / Math.max(ps, 0.01))));
          const of = p.m.map((pm, k) => c.m[k] - sc[k] * pm);
          const t = sums[l] || (sums[l] = { s: [0, 0, 0], o: [0, 0, 0] });
          for (let k = 0; k < 3; k++) { t.s[k] += sc[k]; t.o[k] += of[k]; }
          counts[l] = (counts[l] || 0) + 1;
        }
      } catch (err) { /* this spot's imagery is unreachable */ }
    }));
    // chain the per-level mean maps down from z13: x -> S*x + O brings level l to z13's tone
    const gains = {}, offs = {};
    let S = [1, 1, 1], O = [0, 0, 0];
    for (let l = IMG_MATCH_Z - 1; l >= lo; l--) {
      if (counts[l]) {
        const sl = sums[l].s.map((v) => v / counts[l]), ol = sums[l].o.map((v) => v / counts[l]);
        O = O.map((o, k) => S[k] * ol[k] + o);
        S = S.map((v, k) => v * sl[k]);
      }
      gains[l] = S.map((v) => Math.max(0.4, Math.min(2.5, v)));
      offs[l] = O.map((v) => Math.max(-0.3, Math.min(0.3, v)));
    }
    if (epoch !== (this.imgEpoch || 0)) { this.calibBusy = false; return; }   // measured on the previous basemap
    if (Object.keys(counts).length) { this.gains = gains; this.offs = offs; }
    this.calibAt = at;
    this.needSelect = true;
    this.calibBusy = false;
  }

  /* Put the best available texture on a tile: its own, else an ancestor's. */
  dress(st) {
    let src = st.tex ? st : null, d = 0;
    if (!src) {
      for (let k = parentKey(st.key), n = 1; k && n <= 8; k = parentKey(k), n++) {
        const a = this.cache.get(k);
        if (a && a.tex && a.mesh) { src = a; d = n; break; }
      }
    }
    const from = src ? src.key : null;
    const mat = st.mesh.material, uv = st.mesh.geometry.attributes.uv;
    if (src) {   // tonal match of coarse imagery levels (see calibrateImagery)
      const g = this.gains[src.z] || [1, 1, 1], o = this.offs[src.z] || [0, 0, 0], u = mat.userData.uOff.value;
      if (mat.color.r !== g[0] || mat.color.g !== g[1] || mat.color.b !== g[2]) { mat.color.setRGB(g[0], g[1], g[2], THREE.LinearSRGBColorSpace); this.dirty = true; }
      if (u.x !== o[0] || u.y !== o[1] || u.z !== o[2]) { u.set(o[0], o[1], o[2]); this.dirty = true; }
    } else {
      if (mat.color.r !== 1 || mat.color.g !== 1 || mat.color.b !== 1) mat.color.setRGB(1, 1, 1, THREE.LinearSRGBColorSpace);
      mat.userData.uOff.value.set(0, 0, 0);
    }
    if (from === st.imgFrom) return;
    st.imgFrom = from;
    if (!src) { mat.map = null; mat.vertexColors = true; mat.needsUpdate = true; this.dirty = true; return; }
    // the tile's 0..1 UVs mapped into the source texture (the tile itself,
    // or its ancestor d levels up), pulled half a texel in from each edge so
    // neighbouring tiles sample pixel centres, not the clamped border
    const f = 2 ** d, [, ax, ay] = parseKey(src.key), fx = (st.x - ax * f) / f, fy = (st.y - ay * f) / f;
    const k = 1 - 1 / 256, o = 0.5 / 256;
    for (let i = 0; i < uv.count; i++) {
      const u = fx + st.uv0[i * 2] / f, v = 1 - (fy + (1 - st.uv0[i * 2 + 1]) / f);
      uv.setXY(i, u * k + o, v * k + o);
    }
    uv.needsUpdate = true;
    mat.map = src.tex; mat.vertexColors = false; mat.needsUpdate = true;
    this.dirty = true;
  }

  /* Imagery/Relief toggle: relief drops every texture reference. */
  applyImageryMode() {
    if (!this.imageryOn) {
      this.imgQueue.clear();
      for (const st of this.cache.values()) {
        if (!st.mesh) continue;
        st.imgFrom = null;
        st.mesh.material.map = null; st.mesh.material.vertexColors = true; st.mesh.material.needsUpdate = true;
        st.mesh.geometry.attributes.uv.array.set(st.uv0); st.mesh.geometry.attributes.uv.needsUpdate = true;
      }
    } else {
      for (const st of this.cache.values()) st.imgFrom = st.mesh ? null : st.imgFrom;
    }
    this.updateAttribution();
    this.needSelect = true;
    this.dirty = true;
  }

  say(kind, text) {
    if (this.said.has(kind)) return;
    this.said.add(kind);
    if (this.hooks.onUnsupported) this.hooks.onUnsupported(text);
  }

  updateStatus() {
    const el = document.getElementById('tiles3d');
    if (!el) return;
    const pending = this.fetching + this.queue.size + this.imgLoading + this.imgQueue.size;
    el.textContent = pending ? 'loading detail…' : '';
  }

  syncModeBtn() {
    const btn = document.getElementById('mode3d');
    if (!btn) return;
    btn.setAttribute('aria-pressed', String(!this.imageryOn));
    for (const sp of btn.querySelectorAll('span')) sp.classList.toggle('on', (sp.dataset.m === 'img') === this.imageryOn);
  }

  /* The 2D map's basemap changed: drape the new one. Textures (and the
   * tone match, measured per imagery service) are dropped and reloaded;
   * tiles show relief colours until theirs arrive. */
  setBasemap(bm) {
    if (!bm || (this.basemap && this.basemap.template === bm.template)) return;
    this.basemap = bm;
    this.imgEpoch = (this.imgEpoch || 0) + 1;
    this.gains = {}; this.offs = {}; this.calibAt = null;
    this.imgQueue.clear();
    this.imgLoaded = 0; this.imgFailed = 0;
    for (const st of this.cache.values()) {
      if (st.tex) st.tex.dispose();
      st.tex = null; st.imgState = null; st.imgFrom = null;
      if (!st.mesh) continue;
      const mat = st.mesh.material;
      mat.map = null; mat.vertexColors = true; mat.color.setRGB(1, 1, 1, THREE.LinearSRGBColorSpace); mat.userData.uOff.value.set(0, 0, 0); mat.needsUpdate = true;
      st.mesh.geometry.attributes.uv.array.set(st.uv0); st.mesh.geometry.attributes.uv.needsUpdate = true;
    }
    const btn = document.getElementById('mode3d');
    if (btn) btn.hidden = false;
    this.updateAttribution();
    this.needSelect = true;
    this.dirty = true;
  }

  updateAttribution() {
    const el = document.getElementById('attr3d');
    if (!el) return;
    const terrain = this.source === 'terrarium' ? 'Terrain: AWS Terrain Tiles (Mapzen, SRTM and others)' : 'Terrain: Geoscience Australia DEM-H';
    // the attribution strings are our own constants (BASEMAPS in app.js)
    el.innerHTML = terrain + (this.imageryOn && this.basemap ? ` · ${this.basemap.attr}` : '');
  }

  /* Ground height (scene metres, exaggerated) under a scene point, from the
   * finest built tile covering it; null before any tile is built. */
  groundAt(x, z) {
    for (let zoom = this.maxZ(); zoom >= MIN_Z; zoom--) {
      const [tx, ty] = tileAt(this.proj, zoom, x, z), st = this.cache.get(`${zoom}/${tx}/${ty}`);
      if (!st || st.state !== 'ready') continue;
      const h = tileGroundAt(this.proj, zoom, tx, ty, st.heights, x, z, st.segs);
      if (h != null) return h * this.exag;
    }
    return null;
  }

  /* Keep the orbit target on the ground and the camera above it: the
   * target follows the terrain (camera and target move together, so the
   * view doesn't swing), and the camera keeps a clearance over the hills
   * under it. */
  followGround() {
    const t = this.controls.target, c = this.camera.position;
    const gt = this.groundAt(t.x, t.z);
    if (gt != null && Math.abs(gt - t.y) > 0.05) {
      const dy = (gt - t.y) * 0.25;
      t.y += dy; c.y += dy;
      this.dirty = true;
    }
    const gc = this.groundAt(c.x, c.z);
    if (gc != null) {
      const clear = Math.max(30, 0.02 * c.distanceTo(t)) * Math.max(1, this.exag * 0.5);
      if (c.y < gc + clear) { c.y = gc + clear; this.dirty = true; }
    }
  }

  /* Double-click: fly to the point under the cursor, closer. */
  flyToPoint(ev) {
    const canvas = this.renderer.domElement, r = canvas.getBoundingClientRect();
    this.raycaster.setFromCamera(new THREE.Vector2(((ev.clientX - r.left) / r.width) * 2 - 1, -((ev.clientY - r.top) / r.height) * 2 + 1), this.camera);
    this.world.updateMatrixWorld(true);
    const meshes = [...this.drawn].map((k) => this.cache.get(k)).filter((st) => st && st.mesh).map((st) => st.mesh);
    const hit = this.raycaster.intersectObjects(meshes, false)[0];
    if (!hit) return;
    const t = this.controls.target, c = this.camera.position;
    const off = c.clone().sub(t).multiplyScalar(0.45);   // half the distance, same look direction
    if (off.length() < this.controls.minDistance * 1.2) off.setLength(this.controls.minDistance * 1.2);
    this.anim = { t: 0, frames: 50, camFrom: c.clone(), camTo: hit.point.clone().add(off), tgtFrom: t.clone(), tgtTo: hit.point.clone() };
  }

  buildSky() {
    // a dome whose vertex colours blend horizon haze into the zenith blue;
    // below the horizon it stays haze (fog lands there too)
    const geo = new THREE.SphereGeometry(FAR * 0.9, 24, 16);
    const top = new THREE.Color(SKY_TOP), hor = new THREE.Color(SKY_HORIZON), col = new THREE.Color();
    const pos = geo.attributes.position, colors = new Float32Array(pos.count * 3);
    for (let i = 0; i < pos.count; i++) {
      const y = Math.max(0, pos.getY(i) / (FAR * 0.9));
      col.copy(hor).lerp(top, Math.pow(y, 0.55));
      colors.set([col.r, col.g, col.b], i * 3);
    }
    geo.setAttribute('color', new THREE.BufferAttribute(colors, 3));
    const sky = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({ vertexColors: true, side: THREE.BackSide, depthWrite: false, depthTest: false, fog: false }));
    sky.renderOrder = -1000;
    sky.frustumCulled = false;
    return sky;
  }

  /* Camera clip planes, sky and fog follow the camera: near stays close to
   * the ground under it, fog starts at ~60 % of the horizon distance. */
  updateCameraPlanes() {
    const d = this.camera.position.distanceTo(this.controls.target);
    const near = Math.max(2, Math.min(500, d * 0.01)), far = FAR;
    if (Math.abs(near - this.camera.near) > near * 0.05) {
      this.camera.near = near; this.camera.far = far;
      this.camera.updateProjectionMatrix();
    }
    this.sky.position.copy(this.camera.position);
    const horizon = Math.min(300000, Math.sqrt(2 * 6371000 * Math.max(200, this.camera.position.y / this.exag)) + 60000);
    this.scene.fog.near = horizon * 0.4;
    this.scene.fog.far = horizon * 1.05;
  }

  /* ---------- modelled areas: water surfaces ---------- */

  pollAreas() {
    const areas = this.hooks.getAreas ? this.hooks.getAreas() : [];
    let added = false;
    for (const area of areas) {
      if (area.a && area.bounds && !this.areaTiles.has(area.key)) { this.addWaterTile(area); added = true; }
    }
    if (added) this.dirty = true;
    this.syncAreas();
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
    const opts = { colX: t.colX, rowZ: t.rowZ, lift: 0.05, soft: true };
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
    const mat = new THREE.MeshPhongMaterial({ vertexColors: true, transparent: true, side: THREE.DoubleSide, depthWrite: false, shininess: 60, specular: 0x334455 });
    // Far away the terrain under the water is a coarse tile (vertices
    // hundreds of metres apart) that pokes through shallow water in rows.
    // Pull the water towards the camera by 0.2 % of its distance: the same
    // place on screen (along the view ray), but it wins the depth test
    // against coarse ground (60 m at 30 km, 2 m at 1 km).
    mat.onBeforeCompile = (sh) => {
      sh.vertexShader = sh.vertexShader.replace('#include <project_vertex>', '#include <project_vertex>\nmvPosition.xyz *= 0.998;\ngl_Position = projectionMatrix * mvPosition;');
    };
    mat.customProgramCacheKey = () => 'waterPull';
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
    this.syncAreas();
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
    // controls.update() on position == target is where NaN came from
    this.camera.position.copy(dest);
    this.anim = null;
    if (fly) {
      // fly-in: start high above and settle into the framed view (the
      // Google Earth opening move), animated in the tick loop
      const from = new THREE.Vector3(cx, d * 2.4, cz + d * 1.6);
      this.anim = { t: 0, frames: 120, camFrom: from, camTo: dest, tgtFrom: this.controls.target.clone(), tgtTo: this.controls.target.clone() };
      this.camera.position.copy(from);
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
    this.imgQueue.clear();
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
