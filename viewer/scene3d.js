/* Experimental 3D flood view (docs/3d-view-design.md): three.js glue.
 *
 * The app lazy-imports this module and calls openScene3d() with accessors
 * for the analysis(es), relief renders, runs and timelines. Nothing here
 * touches the flood engine: terrain is each modelled tile's own grid, water
 * is the tile's run surface elevation (or a u8 timeline frame during
 * playback), decimated by viewer/terrain3d.js. All modelled tiles on the
 * map are stitched into one scene ("the whole map", docs 3d-view-design
 * v2.1): the active tile has live water, tiles that were deactivated get
 * their analysis rebuilt by the app (worker, fast) and appear as ready.
 * Vertical exaggeration is mesh.scale.y so the slider never rebuilds.
 */
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { decimateStep, terrainMesh, waterMesh, waterFromFrame } from './terrain3d.js';

const EXAG_DEFAULT = 12;

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
  const groups = [];
  for (const t of controller.tiles.values()) {
    groups.push({
      key: t.area.key,
      pos: t.group.position.toArray(),
      scale: t.terrain ? t.terrain.scale.y : null,
      normals: t.terrain ? !!t.terrain.geometry.attributes.normal : false,
    });
  }
  return {
    cam: controller.camera.position.toArray(),
    target: controller.controls.target.toArray(),
    groups,
  };
}

class Scene3d {
  constructor(canvas, hooks) {
    this.hooks = hooks;
    this.dirty = true;
    this.pollCount = 0;
    this.tiles = new Map();   // area key -> { area, group, terrain, water }

    const overlay = document.createElement('div');
    overlay.id = 'view3d';
    overlay.innerHTML = `
      <style>
        #view3d{position:fixed;inset:0;z-index:9998;background:#0b1622;display:flex;flex-direction:column}
        #view3d canvas{flex:1;min-height:0}
        #view3d .bar{display:flex;gap:14px;align-items:center;padding:10px 16px;background:rgba(10,22,36,.92);color:#dce8f2;font:14px system-ui,sans-serif}
        #view3d .bar label{display:flex;gap:6px;align-items:center}
        #view3d button{font:inherit;color:#dce8f2;background:#17334d;border:1px solid #3d5a75;border-radius:6px;padding:4px 12px;cursor:pointer}
        #view3d .compass{font-weight:600;min-width:2.5em;text-align:center}
        #globe3dWrap{position:absolute;right:14px;bottom:14px;width:68px;height:68px;border-radius:50%;background:rgba(8,20,32,.72);border:1px solid #3d5a75;box-shadow:0 4px 18px rgba(0,0,0,.4);cursor:grab;overflow:hidden}
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

    overlay.appendChild(canvas);
    overlay.appendChild(bar);
    overlay.appendChild(globeWrap);
    document.body.appendChild(overlay);

    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
    this.renderer.setPixelRatio(Math.min(devicePixelRatio || 1, 2));

    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color('#0b1622');
    this.camera = new THREE.PerspectiveCamera(55, 1, 1, 1e6);
    this.controls = new OrbitControls(this.camera, canvas);
    this.controls.enableDamping = true;   // smooth, Earth-like camera feel
    this.controls.dampingFactor = 0.08;
    this.controls.addEventListener('change', () => { this.dirty = true; this.updateCompass(); });
    // fixed afternoon sun from the north-west + enough ambient for the
    // south faces; lighting stays correct as the camera orbits (the baked
    // hillshade could not)
    const sun = new THREE.DirectionalLight(0xfff4e0, 2.2);
    sun.position.set(-0.6, 1, -0.5);
    this.scene.add(sun);
    this.scene.add(new THREE.AmbientLight(0xbfd4e8, 1.1));

    this.bakeTexture();
    this.buildTiles();
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
      // deactivated tiles whose rebuilt analysis finished since the last
      // frame get added here (the app's refresh() only runs on 2D redraws)
      if (++this.pollCount >= 45) { this.pollCount = 0; this.pollReady(); }
      this.drawGlobe();
      if (this.dirty) { this.renderer.render(this.scene, this.camera); this.dirty = false; }
    };
    tick();
  }

  pollReady() {
    const areas = this.hooks.getAreas ? this.hooks.getAreas() : [];
    let added = false;
    for (const area of areas) {
      if (area.a && area.bounds && !this.tiles.has(area.key)) { this.addTile(area); added = true; }
    }
    if (added) this.dirty = true;
  }

  /* One stitched scene tile per modelled area. Tiles whose analysis was
   * freed (inactive) arrive via their `ready` promise and are added then. */
  buildTiles() {
    const areas = this.hooks.getAreas ? this.hooks.getAreas() : [];
    for (const area of areas) this.addTile(area);
    this.updateTileCount();
  }

  addTile(area) {
    if (!area || !area.a || !area.bounds || this.tiles.has(area.key)) return;
    const t = { area, group: new THREE.Group(), terrain: null, water: null, runRef: null };
    this.tiles.set(area.key, t);
    this.buildTileTerrain(t);
    this.buildTileWater(t, this.hooks.getStep ? this.hooks.getStep() : 0);
    this.scene.add(t.group);
    this.updateTileCount();
    // tiles arrive asynchronously (inactive ones after their analysis is
    // rebuilt): frame the camera once the first one is really there — it
    // starts at the default (0,0,0), inside the terrain, otherwise
    if (!this.framed && t.terrain) {
      this.framed = true;
      this.frameCamera(true);
    }
    this.dirty = true;
  }

  /* World offset: the tile's NW corner in metres from the scene origin
   * (the west-most, north-most tile corner of the whole set). */
  place(t) {
    const b = t.area.bounds;   // [w, s, e, n]
    const origin = this.origin || (this.origin = [b[0], b[3]]);
    const midLat = (b[1] + b[3]) / 2;
    t.group.position.set(
      (b[0] - origin[0]) * 111320 * Math.cos((midLat * Math.PI) / 180),
      0,
      -(b[3] - origin[1]) * 110574,
    );
  }

  buildTileTerrain(t) {
    const a = t.area.a;
    const skip = decimateStep(a.W, a.H);
    const m = terrainMesh(a, t.area.terrain, skip);
    if (!m) return;
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(m.positions, 3));
    geo.setAttribute('color', new THREE.BufferAttribute(m.colors, 4));
    geo.setAttribute('uv', new THREE.BufferAttribute(m.uvs, 2));
    geo.setIndex(new THREE.BufferAttribute(m.indices, 1));
    geo.computeVertexNormals();
    // draped satellite imagery when the 2D map's tiles can be drawn untainted;
    // otherwise the baked hypsometric + hillshade colours, lit by a sun
    const tex = this.tex || (this.tex = this.bakeTexture());
    t.terrain = new THREE.Mesh(geo, tex
      ? new THREE.MeshLambertMaterial({ map: tex })
      : new THREE.MeshLambertMaterial({ vertexColors: true, side: THREE.DoubleSide }));
    t.terrain.scale.y = EXAG_DEFAULT;
    t.group.add(t.terrain);
    this.place(t);
  }

  buildTileWater(t, k) {
    if (t.water) { t.group.remove(t.water); t.water.geometry.dispose(); t.water = null; }
    const a = t.area.a;
    let m = null;
    const tl = t.area.timeline;
    if (tl && tl.depthFrames && tl.depthFrames.length >= (k + 1) * a.N && tl.depthFrameMax && tl.depthFrameMax.length > k) {
      m = waterFromFrame(a, tl.depthFrames.subarray(k * a.N, (k + 1) * a.N), tl.depthFrameMax[k] || 0, this.skip).mesh;
    } else if (t.area.run) {
      const r = t.area.run;   // slim runs omit wse; level (= dem + depth) is kept
      m = waterMesh(a, r.level, r.depth, r.wet, this.skip);
    }
    if (!m) return;
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(m.positions, 3));
    geo.setAttribute('color', new THREE.BufferAttribute(m.colors, 4));
    geo.setIndex(new THREE.BufferAttribute(m.indices, 1));
    // depth-scaled per-vertex alpha (shoreline feather) needs RGBA colours
    const mat = new THREE.MeshLambertMaterial({ vertexColors: true, transparent: true, side: THREE.DoubleSide, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2 });
    t.water = new THREE.Mesh(geo, mat);
    t.water.scale.y = t.terrain ? t.terrain.scale.y : EXAG_DEFAULT;
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
    if (el) el.textContent = this.tiles.size > 1 ? `${this.tiles.size} tiles` : '';
  }

  /* Called by the app after the 2D view redraws; picks up rebuilt analyses
   * (tiles that became ready), new/removed areas, and changed runs. */
  refresh() {
    const areas = this.hooks.getAreas ? this.hooks.getAreas() : [];
    const seen = new Set();
    for (const area of areas) {
      seen.add(area.key);
      if (!area.a || !area.bounds) continue;
      if (!this.tiles.has(area.key)) { this.addTile(area); continue; }
      const t = this.tiles.get(area.key);
      if (area.a !== t.area.a) {   // the tile was reanalysed or replaced
        this.disposeTileMeshes(t);
        t.area = area;
        t.runRef = null;
        this.buildTileTerrain(t);
      } else {
        t.area = area;
      }
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
    for (const t of this.tiles.values()) {
      if (t.terrain) t.terrain.scale.y = x;
      if (t.water) t.water.scale.y = x;
    }
    this.dirty = true;
  }

  /* Draw the active 2D basemap's loaded tiles into one canvas texture over
   * the model bounds. Tiles are cross-origin: where the layer was created
   * with crossOrigin (the CORS-verified hosts) the canvas stays clean; a
   * tainted canvas throws on the probe read and we fall back to colours. */
  bakeTexture() {
    const tiles = this.hooks.getTiles && this.hooks.getTiles();
    const bounds = this.hooks.getBounds && this.hooks.getBounds();
    if (!tiles || !tiles.length || !bounds) return null;
    const [w, s, e, n] = bounds;
    const clampLat = (la) => Math.max(-85, Math.min(85, la));
    const merc = (lon, lat) => [((lon + 180) / 360) * (1 << 21) * 32, (((1 - Math.log(Math.tan((clampLat(lat) * Math.PI) / 180) + 1 / Math.cos((clampLat(lat) * Math.PI) / 180)) / Math.PI) / 2) * (1 << 21) * 32)];
    // bake at the loaded tiles' own zoom (sharp), then step down until the
    // canvas fits the cap; a blurrier bake beats a holey one
    const list = tiles.slice().sort((x, y) => x.z - y.z);   // coarser drawn first
    let z = list.reduce((m, t) => Math.max(m, t.z || 0), 6);
    const spanX = merc(e, n)[0] - merc(w, n)[0];   // mercator px at z 26
    while (z > 5 && (spanX / (1 << (26 - z))) > 4096) z--;
    const scale = 1 / (1 << (26 - z));
    const x0 = merc(w, n)[0] * scale, y0 = merc(w, n)[1] * scale;   // canvas origin = NW corner
    const Wpx = Math.ceil(merc(e, n)[0] * scale - x0), Hpx = Math.ceil(merc(w, s)[1] * scale - y0);
    if (Wpx < 8 || Hpx < 8 || Wpx > 4096 || Hpx > 4096) return null;
    const canvas = document.createElement('canvas');
    canvas.width = Wpx; canvas.height = Hpx;
    const ctx = canvas.getContext('2d');
    const size = 256 * scale;   // a tile's side in bake pixels
    let drew = 0;
    for (const t of list) {
      if (!t.img || !(t.img.complete || t.img.naturalWidth)) continue;
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
    // frame the UNION of all tiles (the whole studied area)
    let west = Infinity, east = -Infinity, north = Infinity, south = Infinity;
    for (const t of this.tiles.values()) {
      const g = t.group.position;
      const a = t.area.a;
      west = Math.min(west, g.x); east = Math.max(east, g.x + (a.W - 1) * a.cell);
      north = Math.min(north, g.z); south = Math.max(south, g.z - (a.H - 1) * a.cell);
    }
    if (west === Infinity) return;
    const w = east - west, h = south - north;
    const cx = west + w / 2, cz = north + h / 2;
    this.controls.target.set(cx, 0, cz);
    const d = Math.max(w, h) * 0.9;
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
   * canvas means): theta across, phi down, both clamped. */
  orbitBy(dTheta, dPhi) {
    const t = this.controls.target;
    const sph = new THREE.Spherical().setFromVector3(this.camera.position.clone().sub(t));
    sph.theta -= dTheta;
    sph.phi = Math.max(0.05, Math.min(Math.PI - 0.05, sph.phi - dPhi));
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
    const bar = overlay.querySelector('.bar');
    const w = window.innerWidth, h = window.innerHeight - bar.offsetHeight;
    this.renderer.setSize(w, h, false);
    canvas.style.width = `${w}px`;
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
    window.removeEventListener('keydown', this.onKey, true);
    window.removeEventListener('resize', this.onResize);
    for (const t of this.tiles.values()) this.disposeTileMeshes(t);
    if (this.tex) { this.tex.dispose(); this.tex = null; }
    this.renderer.dispose();
    const overlay = document.getElementById('view3d');
    if (overlay) overlay.remove();
    if (this.hooks.onClose) this.hooks.onClose();
    controller = null;
  }
}
