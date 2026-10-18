/*
 * Flood Explorer — shared model utilities
 *
 * Pure functions, no DOM. Works in the browser (global `FloodCore`)
 * and in Node (`viewer/flood-core.js`) for tests.
 *
 * The flood model itself lives in Rust (flood-core), compiled to
 * WebAssembly and bridged by flood-wasm.js. This module keeps only the
 * helpers with no wasm bridge: the synthetic-test-terrain generator,
 * grid tools (D8 encoding, stream snapping, line rasterisation),
 * run merging, the Australian depth-velocity hazard classes, storm
 * rainfall uplift and DEM text/raster ingestion. If WebAssembly
 * can't load, the app refuses to run (see app.js's gate) rather than
 * duplicating the model in JavaScript.
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (typeof self !== 'undefined') root.FloodCore = api;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  // 8-neighbour offsets; first four are the 4-neighbours
  const DX = [1, -1, 0, 0, 1, 1, -1, -1];
  const DY = [0, 0, 1, -1, 1, -1, 1, -1];
  function mulberry32(seed) {
    let a = seed >>> 0;
    return function () {
      a = (a + 0x6d2b79f5) >>> 0;
      let t = a;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  function makeValueNoise(seed) {
    const rnd = mulberry32(seed);
    const P = 256;
    const vals = new Float64Array(P * P);
    for (let i = 0; i < vals.length; i++) vals[i] = rnd();
    const at = (ix, iy) => vals[((iy & (P - 1)) * P) + (ix & (P - 1))];
    const fade = (t) => t * t * (3 - 2 * t);
    function noise(x, y) {
      const ix = Math.floor(x), iy = Math.floor(y);
      const fx = fade(x - ix), fy = fade(y - iy);
      const a = at(ix, iy), b = at(ix + 1, iy), c = at(ix, iy + 1), d = at(ix + 1, iy + 1);
      return (a + (b - a) * fx) + ((c + (d - c) * fx) - (a + (b - a) * fx)) * fy;
    }
    return function fbm(x, y, octaves) {
      let sum = 0, amp = 0.5, freq = 1, norm = 0;
      for (let o = 0; o < (octaves || 5); o++) {
        sum += amp * noise(x * freq, y * freq);
        norm += amp; amp *= 0.5; freq *= 2.03;
      }
      return sum / norm; // 0..1
    };
  }

  const smoothstep = (a, b, x) => {
    const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
    return t * t * (3 - 2 * t);
  };

  /* --------------------------------------------------------- distance transform */

  // Two-pass chamfer distance (in cells) from cells where src[i] === 1.
  function chamferDistance(src, W, H) {
    const INF = 1e9;
    const d = new Float64Array(W * H);
    for (let i = 0; i < d.length; i++) d[i] = src[i] ? 0 : INF;
    const a = 1, b = Math.SQRT2;
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
      const i = y * W + x; let v = d[i];
      if (x > 0) v = Math.min(v, d[i - 1] + a);
      if (y > 0) {
        v = Math.min(v, d[i - W] + a);
        if (x > 0) v = Math.min(v, d[i - W - 1] + b);
        if (x < W - 1) v = Math.min(v, d[i - W + 1] + b);
      }
      d[i] = v;
    }
    for (let y = H - 1; y >= 0; y--) for (let x = W - 1; x >= 0; x--) {
      const i = y * W + x; let v = d[i];
      if (x < W - 1) v = Math.min(v, d[i + 1] + a);
      if (y < H - 1) {
        v = Math.min(v, d[i + W] + a);
        if (x < W - 1) v = Math.min(v, d[i + W + 1] + b);
        if (x > 0) v = Math.min(v, d[i + W - 1] + b);
      }
      d[i] = v;
    }
    return d;
  }

  function rasterisePolyline(pts, W, H, out) {
    for (let k = 0; k < pts.length - 1; k++) {
      const [x0, y0] = pts[k], [x1, y1] = pts[k + 1];
      const n = Math.ceil(Math.hypot(x1 - x0, y1 - y0) * 2) + 1;
      for (let s = 0; s <= n; s++) {
        const x = Math.round(x0 + (x1 - x0) * s / n), y = Math.round(y0 + (y1 - y0) * s / n);
        if (x >= 0 && y >= 0 && x < W && y < H) out[y * W + x] = 1;
      }
    }
  }

  /* ---------------------------------------------------------- synthetic terrain */

  /**
   * Illustrative lower-river terrain: a meandering river running west to
   * east into a bay, low floodplain flats, hills, and two tributary creeks.
   * NOT real Brisbane elevation. Used so the app works with no data loaded.
   */
  function syntheticTerrain(opts) {
    const o = Object.assign({ W: 420, H: 300, cell: 50, seed: 1974 }, opts || {});
    const { W, H, cell } = o;
    const fbm = makeValueNoise(o.seed);
    const fbm2 = makeValueNoise(o.seed + 11);
    const coastX = Math.round(W * 0.84);

    // River centreline: west edge to the coast, with meander loops
    const river = [];
    for (let x = -2; x <= coastX + 6; x += 1) {
      const t = x / coastX;
      const y = H * 0.5
        + 46 * Math.sin(t * Math.PI * 3.1 + 0.4)
        + 22 * Math.sin(t * Math.PI * 7.3 + 1.1) * (1 - t * 0.6)
        + 10 * (fbm2(x / 40, 3.3, 3) - 0.5);
      river.push([x, y]);
    }
    // Two tributary creeks joining from the north and south
    const creekA = [], creekB = [];
    const jA = river[Math.round(coastX * 0.35)], jB = river[Math.round(coastX * 0.62)];
    for (let s = 0; s <= 1.0001; s += 0.02) {
      creekA.push([jA[0] - 30 * s + 8 * Math.sin(s * 9), jA[1] - (jA[1] - 8) * s]);
      creekB.push([jB[0] + 18 * s + 7 * Math.sin(s * 11), jB[1] + (H - 8 - jB[1]) * s]);
    }

    const rMask = new Uint8Array(W * H), cMask = new Uint8Array(W * H);
    rasterisePolyline(river, W, H, rMask);
    rasterisePolyline(creekA, W, H, cMask);
    rasterisePolyline(creekB, W, H, cMask);
    const dR = chamferDistance(rMask, W, H);
    const dC = chamferDistance(cMask, W, H);

    const dem = new Float32Array(W * H);
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        const i = y * W + x;
        const coast = coastX + 10 * (fbm(3.1, y / 30, 3) - 0.5) * 2;
        const t = Math.min(1, Math.max(0, x / coastX));
        const base = 1.2 + 9.5 * Math.pow(1 - t, 1.6); // floodplain base, m
        const dm = dR[i] * cell; // metres from river
        const plainW = 900 + 1400 * fbm(x / 70, y / 70, 3) * (0.6 + 0.6 * t);
        const hills = smoothstep(plainW, plainW + 1600, dm) * (14 + 85 * fbm(x / 55, y / 55, 5));
        let z = base + 1.6 * (dm / 1000) + hills + 1.2 * (fbm(x / 9, y / 9, 3) - 0.5);
        // creek valleys
        const dcm = dC[i] * cell;
        z -= (6 + hills * 0.6) * Math.exp(-dcm / 260);
        if (dcm < 60) z = Math.min(z, base + 1.0 + 0.004 * dm - 1.5);
        // main channel, ~240 m wide, ~6 m deep
        if (dm < 160) {
          const f = 1 - dm / 160;
          z = Math.min(z, base - 6.2 * f * f + 0.4);
        }
        // bay
        if (x > coast) z = Math.min(z, -1.5 - (x - coast) * 0.06);
        else if (x > coast - 14) z = Math.min(z, 0.4 + (coast - x) * 0.09 + (hills * 0.1));
        dem[i] = z;
      }
    }
    // Upstream inflow: the river enters from the west edge carrying a large
    // catchment that is outside the grid. Mark the entry cell so flow
    // accumulation knows about it.
    // (a few cells in from the edge, so the entry cell is not itself an outlet)
    let entry = 0, best = Infinity;
    for (let y = 0; y < H; y++) if (dem[y * W + 4] < best) { best = dem[y * W + 4]; entry = y * W + 4; }
    const inflow = new Float32Array(W * H);
    inflow[entry] = 1e6; // cells; effectively ~2500 km² at 50 m cells

    return {
      W, H, cell, dem,
      valid: null, inflow,
      name: 'Sample terrain (illustrative)',
      synthetic: true,
    };
  }

  function MinHeap(cap) {
    this.k = new Float64Array(cap);
    this.v = new Int32Array(cap);
    this.n = 0;
  }
  MinHeap.prototype.push = function (key, val) {
    let i = this.n++;
    const k = this.k, v = this.v;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (k[p] <= key) break;
      k[i] = k[p]; v[i] = v[p]; i = p;
    }
    k[i] = key; v[i] = val;
  };
  MinHeap.prototype.pop = function () {
    const k = this.k, v = this.v;
    const top = v[0];
    const lk = k[--this.n], lv = v[this.n];
    let i = 0;
    for (;;) {
      let c = 2 * i + 1;
      if (c >= this.n) break;
      if (c + 1 < this.n && k[c + 1] < k[c]) c++;
      if (k[c] >= lk) break;
      k[i] = k[c]; v[i] = v[c]; i = c;
    }
    k[i] = lk; v[i] = lv;
    return top;
  };

  const WBT_CODES = [1, 2, 4, 8, 16, 32, 64, 128];
  const WBT_DX = [1, 1, 1, 0, -1, -1, -1, 0];
  const WBT_DY = [-1, 0, 1, 1, 1, 0, -1, -1];
  function encodeWhiteboxD8(a) {
    const out = new Int16Array(a.N);
    for (let c = 0; c < a.N; c++) {
      if (!a.valid[c]) { out[c] = -32768; continue; }
      const r = a.rec[c];
      if (r < 0) { out[c] = 0; continue; }
      const dx = (r % a.W) - (c % a.W), dy = Math.floor(r / a.W) - Math.floor(c / a.W);
      for (let k = 0; k < 8; k++) if (WBT_DX[k] === dx && WBT_DY[k] === dy) { out[c] = WBT_CODES[k]; break; }
    }
    return out;
  }

  // Largest donor upstream of c (main-stem tracing)
  function mainDonor(a, c) {
    const { W, H, rec, acc } = a;
    const cx = c % W, cy = (c - cx) / W;
    let best = -1, bAcc = -1;
    for (let k = 0; k < 8; k++) {
      const nx = cx + DX[k], ny = cy + DY[k];
      if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue;
      const n = ny * W + nx;
      if (rec[n] === c && a.stream[n] && acc[n] > bAcc) { bAcc = acc[n]; best = n; }
    }
    return best;
  }

  // Main stem from the headwater (or grid edge) down to the main outlet
  function mainStem(a) {
    if (a.mainOutlet < 0) return [];
    const up = [];
    let c = a.mainOutlet;
    while (c >= 0) { up.push(c); c = mainDonor(a, c); }
    return up.reverse(); // upstream -> downstream
  }

  function snapToStream(a, x, y, r, minAcc) {
    const R = r || 10;
    const floor = minAcc || 0;
    let best = -1, bd = Infinity;
    for (let dy = -R; dy <= R; dy++) for (let dx = -R; dx <= R; dx++) {
      const nx = x + dx, ny = y + dy;
      if (nx < 0 || ny < 0 || nx >= a.W || ny >= a.H) continue;
      const n = ny * a.W + nx;
      if (!a.stream[n] || a.acc[n] < floor) continue;
      const d = dx * dx + dy * dy - Math.log10(a.acc[n]) * 0.01;
      if (d < bd) { bd = d; best = n; }
    }
    return best;
  }

  const HAZARD_LIMITS = [[0.3, 2, 0.3], [0.5, 2, 0.6], [1.2, 2, 0.6], [2.0, 2, 1.0], [4.0, 4, 4.0]];
  function hazardClass(D, V) {
    for (let k = 0; k < HAZARD_LIMITS.length; k++) {
      const [d, v, dv] = HAZARD_LIMITS[k];
      if (D <= d && V <= v && D * V <= dv) return k + 1;
    }
    return 6;
  }
  /**
   * Hazard for a run: a screening estimate of flow speed from Manning's
   * equation (V = d^(2/3) S^(1/2) / n) with the water-surface slope of the
   * river beside each cell (over about 500 m) for river flooding, the ground
   * slope for overland flow, still water in ponds and the sea; channel
   * n = 0.035, floodplain n = 0.06; speeds capped at 6 m/s in channels and
   * 4 m/s on floodplains. Returns { cls (0 dry, 1-6), vel, km2: [H1..H6] }.
   */
  function mergeRuns(r1, r2) {
    const N = r1.wet.length, wet = new Uint8Array(N), depth = new Float32Array(N), level = new Float32Array(N).fill(NaN);
    for (let c = 0; c < N; c++) {
      const a = r1.wet[c] ? r1.depth[c] : -1, b = r2.wet[c] ? r2.depth[c] : -1;
      if (a < 0 && b < 0) continue;
      wet[c] = 1;
      if (a >= b) { depth[c] = a; level[c] = r1.level[c]; } else { depth[c] = b; level[c] = r2.level[c]; }
    }
    return { wet, depth, level, wse: r1.wse, onPath: r1.onPath, kind: r2.kind, summary: r2.summary };
  }

  /**
   * Area statistics comparing a scenario against a baseline run.
   */
  function lineCells(pts, W, H) {
    const cells = [];
    for (let k = 1; k < pts.length; k++) {
      let [x0, y0] = pts[k - 1].map(Math.round), [x1, y1] = pts[k].map(Math.round);
      const dx = Math.abs(x1 - x0), dy = -Math.abs(y1 - y0), sx = x0 < x1 ? 1 : -1, sy = y0 < y1 ? 1 : -1;
      let err = dx + dy;
      for (;;) {
        if (x0 >= 0 && y0 >= 0 && x0 < W && y0 < H) cells.push(y0 * W + x0);
        if (x0 === x1 && y0 === y1) break;
        const e2 = 2 * err;
        if (e2 >= dy) { err += dy; x0 += sx; }
        if (e2 <= dx) { err += dx; y0 += sy; }
      }
    }
    return Int32Array.from(new Set(cells));
  }

  function stormUplift(hours, warmingC) {
    if (!(warmingC > 0)) return 1;
    const h = Math.max(1, Math.min(24, hours || 1));
    const rate = 0.15 + (0.08 - 0.15) * (Math.log(h) / Math.log(24));
    return Math.pow(1 + rate, warmingC);
  }

  /**
   * Flash flooding from a storm on the model area (screening level).
   *   rainMm, hours: storm depth and duration
   *   initialLoss (mm), contLoss (mm/h): soil and surface losses
   * Rain left after losses runs off. Peak runoff from each cell's catchment
   * uses the rational method (Q = C·i·A); creeks rise by the normal depth
   * that carries that flow (Manning, a channel that widens with catchment
   * size), spreading to connected low land beside them; elsewhere runoff
   * concentrating downhill shows as overland flow where it is at least
   * 10 cm deep; and runoff fills dips in the ground (the gaps the
   * depression-filled surface bridges) up to the volume draining into them;
   * dips over 5 m deep (quarries, dams, data gaps) are left out.
   * Stormwater pipes (o.urban: a mask of built-up cells; o.pipeMmH: the
   * runoff rate the pipes carry, mm/h) take runoff from built-up land
   * before it flows overland or ponds: each point's overland flow loses
   * the pipes' share from the built-up part of its catchment, and each dip
   * loses the volume piped away over the storm. Pipes empty into the
   * creeks, so creek flows are unchanged. Culverts and timing are ignored.
   * Returns { wet, depth, level, kind (0 dry, 1 creek, 2 overland, 3 pond, 4 sea), summary }.
   */
  function parseAsciiGrid(text) {
    const lines = text.split(/\r?\n/);
    const hdr = {};
    let li = 0;
    for (; li < lines.length; li++) {
      const m = lines[li].trim().match(/^([A-Za-z_]+)\s+(-?[\d.eE+-]+)$/);
      if (!m) break;
      hdr[m[1].toLowerCase()] = parseFloat(m[2]);
    }
    const W = hdr.ncols, H = hdr.nrows, cell = hdr.cellsize;
    if (!(W > 0 && H > 0 && cell > 0)) throw new Error('Not an ASCII grid: missing ncols, nrows or cellsize.');
    const nd = 'nodata_value' in hdr ? hdr.nodata_value : -9999;
    const vals = lines.slice(li).join(' ').trim().split(/\s+/);
    if (vals.length < W * H) throw new Error(`ASCII grid has ${vals.length} values, expected ${W * H}.`);
    const dem = new Float32Array(W * H), valid = new Uint8Array(W * H);
    for (let i = 0; i < W * H; i++) {
      const v = parseFloat(vals[i]);
      if (Number.isFinite(v) && v !== nd) { dem[i] = v; valid[i] = 1; }
    }
    return { W, H, cell, dem, valid };
  }

  /** Block-average a grid so its longest side is at most maxSide cells. */
  function downsample(grid, maxSide) {
    const { W, H } = grid;
    const f = Math.ceil(Math.max(W, H) / maxSide);
    if (f <= 1) return grid;
    const w = Math.floor(W / f), h = Math.floor(H / f);
    const dem = new Float32Array(w * h), valid = new Uint8Array(w * h);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      let s = 0, n = 0;
      for (let j = 0; j < f; j++) for (let i = 0; i < f; i++) {
        const k = (y * f + j) * W + x * f + i;
        if (!grid.valid || grid.valid[k]) { s += grid.dem[k]; n++; }
      }
      // a block is valid if most of it is valid
      if (n * 2 >= f * f) { dem[y * w + x] = s / n; valid[y * w + x] = 1; }
    }
    return Object.assign({}, grid, { W: w, H: h, cell: grid.cell * f, dem, valid });
  }

  /** Mark values outside a plausible elevation range as nodata. */
  function cleanNodata(grid, nodata) {
    const N = grid.W * grid.H;
    const valid = grid.valid || new Uint8Array(N).fill(1);
    for (let i = 0; i < N; i++) {
      const v = grid.dem[i];
      if (!Number.isFinite(v) || v === nodata || v < -500 || v > 9000) valid[i] = 0;
    }
    grid.valid = valid;
    return grid;
  }


  /**
   * Read a single-band, uncompressed 32-bit float GeoTIFF (tiled or
   * stripped), as Geoscience Australia's elevation service returns. Tiles
   * with no data are often left out entirely (offset or byte count 0,
   * "sparse" tiles); they are filled with the no-data value.
   * Returns { W, H, data: Float32Array, nodata, bounds: [w, s, e, n] | null }
   * or throws if the file uses a layout this reader doesn't handle.
   */

  return {
    syntheticTerrain, mainStem, snapToStream, encodeWhiteboxD8,
    mergeRuns, lineCells, hazardClass, stormUplift,
    parseAsciiGrid, downsample, cleanNodata,
    // exposed for callers that need the internals (app.js uses MinHeap
    // for road-network routing)
    _internal: { MinHeap, chamferDistance, mulberry32 },
  };
});
