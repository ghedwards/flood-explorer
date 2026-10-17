/*
 * Flood Explorer — model core
 *
 * Pure functions, no DOM. Works in the browser (global `FloodCore`)
 * and in Node (`require('./src/flood-core.js')`) for tests.
 *
 * Pipeline
 *   1. Terrain grid (synthetic sample, or a DEM the user loads)
 *   2. Ocean mask: cells at or below 0 m connected to the grid edge
 *   3. Priority-flood depression filling (Barnes et al. 2014, with epsilon)
 *   4. D8 flow directions and flow accumulation
 *   5. Stream network from a contributing-area threshold
 *   6. Water surface along the network, driven by a gauge level and a
 *      downstream (bay) level
 *   7. Connected inundation: a cell floods when it sits below the water
 *      surface of the stream it drains to (HAND-style) AND it touches
 *      water through 4-connected wet cells
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
  const DD = [1, 1, 1, 1, Math.SQRT2, Math.SQRT2, Math.SQRT2, Math.SQRT2];

  /* ---------------------------------------------------------------- RNG + noise */

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

  /* -------------------------------------------------------------------- heap */

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

  /* -------------------------------------------------------------- hydrology */

  /**
   * Run the terrain analysis once per DEM.
   * grid: { W, H, cell, dem, valid?, inflow?, d8? }
   *   d8: optional Whitebox D8 pointer codes (from the RustGIS pipeline).
   *       When present, flow routing comes from it instead of being
   *       computed here.
   * opts: { streamAreaKm2 }
   */
  function analyse(grid, opts) {
    const o = Object.assign({ streamAreaKm2: 4 }, opts || {});
    const { W, H, cell, dem } = grid;
    const N = W * H;
    const valid = grid.valid || new Uint8Array(N).fill(1);

    // --- sea: cells <= 0 m connected to the edge or to nodata (for display,
    //     stats and seeding; the river network still runs through it)
    const ocean = new Uint8Array(N);
    const q = new Int32Array(N);
    let qh = 0, qt = 0;
    const touchesBoundary = (x, y) => {
      if (x === 0 || y === 0 || x === W - 1 || y === H - 1) return true;
      for (let k = 0; k < 4; k++) if (!valid[(y + DY[k]) * W + x + DX[k]]) return true;
      return false;
    };
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
      const i = y * W + x;
      if (valid[i] && dem[i] <= 0 && touchesBoundary(x, y)) { ocean[i] = 1; q[qt++] = i; }
    }
    while (qh < qt) {
      const c = q[qh++], cx = c % W, cy = (c - cx) / W;
      for (let k = 0; k < 4; k++) {
        const nx = cx + DX[k], ny = cy + DY[k];
        if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue;
        const n = ny * W + nx;
        if (!ocean[n] && valid[n] && dem[n] <= 0) { ocean[n] = 1; q[qt++] = n; }
      }
    }

    // --- flow routing: receivers (rec), step lengths, and an order in which
    //     every receiver comes before its donors (downstream first)
    const routed = grid.d8
      ? routeFromPointers(grid.d8, W, H, cell, valid)
      : routeByPriorityFlood(dem, W, H, cell, valid, touchesBoundary);
    const { rec, recDist, order, nOrder } = routed;
    const filled = routed.filled || null;

    // --- accumulation (cells), chainage to outlet (m)
    const acc = new Float64Array(N);
    const inflow = grid.inflow;
    for (let j = nOrder - 1; j >= 0; j--) {
      const c = order[j];
      acc[c] += 1 + (inflow ? inflow[c] : 0);
      if (rec[c] >= 0) acc[rec[c]] += acc[c];
    }
    const chain = new Float64Array(N);
    for (let j = 0; j < nOrder; j++) {
      const c = order[j];
      chain[c] = rec[c] >= 0 ? chain[rec[c]] + recDist[c] : 0;
    }

    // --- streams and the stream each cell drains to
    const cellAreaKm2 = (cell * cell) / 1e6;
    const thresh = o.streamAreaKm2 / cellAreaKm2;
    const stream = new Uint8Array(N);
    for (let c = 0; c < N; c++) if (valid[c] && acc[c] >= thresh) stream[c] = 1;
    const recvStream = new Int32Array(N).fill(-1);
    for (let j = 0; j < nOrder; j++) {
      const c = order[j];
      if (stream[c]) recvStream[c] = c;
      else if (rec[c] >= 0) recvStream[c] = recvStream[rec[c]];
    }

    // --- main outlet (largest catchment reaching the sea/edge)
    let mainOutlet = -1, mainAcc = -1;
    for (let c = 0; c < N; c++) {
      if (stream[c] && rec[c] < 0 && acc[c] > mainAcc) { mainAcc = acc[c]; mainOutlet = c; }
    }

    const a = {
      W, H, cell, N, dem, valid, ocean, filled, order, nOrder,
      routedBy: grid.d8 ? 'pointers' : 'priority-flood',
      rec, acc, chain, stream, recvStream, mainOutlet,
      streamAreaKm2: o.streamAreaKm2,
    };
    a.defaultGauge = defaultGauge(a);
    return a;
  }

  /**
   * Route flow ourselves: priority-flood depression filling (Barnes 2014,
   * epsilon variant) then steepest-descent D8. Used for the sample terrain
   * and for raw DEMs loaded in the browser.
   */
  function routeByPriorityFlood(dem, W, H, cell, valid, touchesBoundary) {
    const N = W * H;
    const filled = Float64Array.from(dem);
    const closed = new Uint8Array(N);
    const heap = new MinHeap(N);
    for (let i = 0; i < N; i++) if (!valid[i]) closed[i] = 1;
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
      const i = y * W + x;
      if (!valid[i]) continue;
      // Outlets are the grid edge and nodata. Sea cells are routed through
      // (not treated as sinks) so estuaries stay part of the river network.
      if (touchesBoundary(x, y)) { closed[i] = 1; heap.push(filled[i], i); }
    }
    const order = new Int32Array(N);
    let nOrder = 0;
    const EPS = 1e-5;
    while (heap.n > 0) {
      const c = heap.pop();
      order[nOrder++] = c;
      const cx = c % W, cy = (c - cx) / W;
      for (let k = 0; k < 8; k++) {
        const nx = cx + DX[k], ny = cy + DY[k];
        if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue;
        const n = ny * W + nx;
        if (closed[n]) continue;
        closed[n] = 1;
        if (filled[n] <= filled[c]) filled[n] = filled[c] + EPS;
        heap.push(filled[n], n);
      }
    }
    const rec = new Int32Array(N).fill(-1);
    const recDist = new Float32Array(N);
    for (let c = 0; c < N; c++) {
      if (!valid[c]) continue;
      const cx = c % W, cy = (c - cx) / W;
      let best = 0, bn = -1, bd = 0;
      for (let k = 0; k < 8; k++) {
        const nx = cx + DX[k], ny = cy + DY[k];
        if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue;
        const n = ny * W + nx;
        if (!valid[n]) continue;
        const s = (filled[c] - filled[n]) / DD[k];
        if (s > best) { best = s; bn = n; bd = DD[k]; }
      }
      rec[c] = bn; recDist[c] = bd * cell;
    }
    return { rec, recDist, order, nOrder, filled };
  }

  // Whitebox / GeoLibre D8 pointer codes (esri_pntr=false), as written by
  // the `d8_pointer` tool that RustGIS runs:
  //   64 128   1        NW  N  NE
  //   32   0   2   =>    W  .   E      0 = no outflow, other = nodata
  //   16   8   4        SW  S  SE
  const WBT_CODES = [1, 2, 4, 8, 16, 32, 64, 128];
  const WBT_DX = [1, 1, 1, 0, -1, -1, -1, 0];
  const WBT_DY = [-1, 0, 1, 1, 1, 0, -1, -1];

  /**
   * Route flow from a precomputed D8 pointer raster (the pipeline's
   * `d8.tif`). Builds a downstream-first order with Kahn's algorithm; any
   * cell left over (a cycle, which a valid pointer grid never has) becomes
   * an outlet so the model still runs.
   */
  function routeFromPointers(codes, W, H, cell, valid) {
    const N = W * H;
    const rec = new Int32Array(N).fill(-1);
    const recDist = new Float32Array(N);
    const lut = new Int8Array(256).fill(-1);
    WBT_CODES.forEach((c, k) => { lut[c] = k; });
    for (let c = 0; c < N; c++) {
      if (!valid[c]) continue;
      const code = codes[c];
      const k = code >= 0 && code < 256 ? lut[code] : -1;
      if (k < 0) continue;
      const cx = c % W, cy = (c - cx) / W;
      const nx = cx + WBT_DX[k], ny = cy + WBT_DY[k];
      if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue;
      const n = ny * W + nx;
      if (!valid[n]) continue;
      rec[c] = n;
      recDist[c] = (WBT_DX[k] && WBT_DY[k] ? Math.SQRT2 : 1) * cell;
    }
    // upstream-first topological order, then reverse it
    const indeg = new Int32Array(N);
    for (let c = 0; c < N; c++) if (rec[c] >= 0) indeg[rec[c]]++;
    const up = new Int32Array(N);
    let n = 0, head = 0;
    for (let c = 0; c < N; c++) if (valid[c] && indeg[c] === 0) up[n++] = c;
    while (head < n) {
      const c = up[head++];
      const r = rec[c];
      if (r >= 0 && --indeg[r] === 0) up[n++] = r;
    }
    if (n < validCount(valid)) {
      // break cycles: cells never released become outlets
      for (let c = 0; c < N; c++) if (valid[c] && indeg[c] > 0) { rec[c] = -1; indeg[c] = 0; }
      return routeFromRec(rec, recDist, valid, N);
    }
    const order = new Int32Array(n);
    for (let j = 0; j < n; j++) order[j] = up[n - 1 - j];
    return { rec, recDist, order, nOrder: n };
  }

  function validCount(valid) { let k = 0; for (let i = 0; i < valid.length; i++) k += valid[i]; return k; }

  function routeFromRec(rec, recDist, valid, N) {
    const indeg = new Int32Array(N);
    for (let c = 0; c < N; c++) if (rec[c] >= 0) indeg[rec[c]]++;
    const up = new Int32Array(N);
    let n = 0, head = 0;
    for (let c = 0; c < N; c++) if (valid[c] && indeg[c] === 0) up[n++] = c;
    while (head < n) {
      const c = up[head++];
      const r = rec[c];
      if (r >= 0 && --indeg[r] === 0) up[n++] = r;
    }
    const order = new Int32Array(n);
    for (let j = 0; j < n; j++) order[j] = up[n - 1 - j];
    return { rec, recDist, order, nOrder: n };
  }

  /** Encode an analysis' receivers as Whitebox D8 codes (tests, exports). */
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

  function defaultGauge(a) {
    const stem = mainStem(a);
    if (!stem.length) return -1;
    const L = a.chain[stem[0]];
    // gauge ~45% of the way up the main stem from the mouth
    let best = stem[0], bd = Infinity;
    for (const c of stem) {
      const d = Math.abs(a.chain[c] - 0.45 * L);
      if (d < bd) { bd = d; best = c; }
    }
    return best;
  }

  // Snap a clicked cell to the nearest stream cell within r cells whose
  // flow accumulation is at least minAcc cells (default: any stream)
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

  /* ---------------------------------------------------------- water surface */

  /**
   * Water surface elevation for every stream cell.
   * s: { gauge (cell), gaugeLevel (m), bayLevel (m), upstreamGradient (m/km) }
   *
   * - Between the gauge and the mouth the surface varies linearly with
   *   river distance from bayLevel to gaugeLevel.
   * - Upstream of the gauge, and on tributaries, the surface rises at
   *   upstreamGradient from the point where the reach joins that path.
   * - Streams reaching the sea by another route rise from bayLevel.
   */
  // Water surface along the stream network. The gauge and any extra control
  // points (s.controls: [{cell, level}]) fix the level at those cells; along
  // the flow path below each one the level runs linearly to the next control
  // point downstream (or to the bay level at the outlet). Where two paths
  // share cells (below a junction) the higher level wins. Streams not on a
  // controlled path rise from where they join one at upstreamGradient m/km.
  function streamSurface(a, s) {
    const { N, order, nOrder, rec, chain, stream } = a;
    const ctrl = [];
    if (s.gauge >= 0) ctrl.push({ cell: s.gauge, level: s.gaugeLevel });
    (s.controls || []).forEach((c) => { if (c && c.cell >= 0 && c.cell < N && Number.isFinite(c.level)) ctrl.push(c); });
    const ctrlLevel = new Map();
    ctrl.forEach((c) => ctrlLevel.set(c.cell, Math.max(ctrlLevel.get(c.cell) ?? -Infinity, c.level)));
    const onPath = new Uint8Array(N);
    const pathWse = new Float64Array(N).fill(-Infinity);
    // Backwater pre-pass (two-boundary standard step)
    const bwStage = new Map();
    if (s.backwater && s.gauge >= 0) {
      const path = [];
      let c = s.gauge;
      while (c >= 0) { path.push(c); c = rec[c]; }
      if (path.length >= 2) {
        const stages = new Array(path.length).fill(NaN);
        stages[path.length-1] = s.bayLevel;
        for (let i = path.length-2; i >= 0; i--) {
          const c0 = path[i], c1 = path[i+1];
          const dx = Math.max(a.cell, Math.abs(chain[c0]-chain[c1]));
          const h0 = stages[i+1];
          const depth0 = Math.max(0.1, h0 - a.dem[c1]);
          const sf = (0.035*0.035) / Math.pow(depth0, 4/3);
          stages[i] = h0 + sf * dx;
        }
        const err = s.gaugeLevel - stages[0];
        for (let i = 0; i < path.length; i++) {
          if (Number.isFinite(stages[i])) stages[i] += err * (1 - i/(path.length-1));
        }
        for (let i = 0; i < path.length; i++) if (Number.isFinite(stages[i])) bwStage.set(path[i], stages[i]);
      }
    }
    for (const { cell: p0 } of ctrl) {
      const L0 = ctrlLevel.get(p0);
      // find the next control downstream (or the outlet)
      let q = rec[p0], end = -1;
      while (q >= 0) { if (ctrlLevel.has(q)) { end = q; break; } q = rec[q]; }
      const cU = chain[p0], cD = end >= 0 ? chain[end] : 0, LD = end >= 0 ? ctrlLevel.get(end) : s.bayLevel;
      let c = p0;
      while (c >= 0 && c !== end) {
        const tRaw = cU > cD ? (chain[c] - cD) / (cU - cD) : 1;
        const t = Math.max(0, Math.min(1, tRaw));
        let v;
        if (s.backwater && bwStage.has(c)) v = bwStage.get(c);
        else if (s.backwater) v = LD + (L0 - LD) * Math.pow(t, 1.3);
        else v = LD + (L0 - LD) * t;
        if (v > pathWse[c]) pathWse[c] = v;
        onPath[c] = 1;
        c = rec[c];
      }
      if (end >= 0) onPath[end] = 1;
    }
    for (const [c, v] of ctrlLevel) if (v > pathWse[c]) pathWse[c] = v;
    const grad = s.upstreamGradient / 1000;
    // closed flood gates: the river's level doesn't pass up the channel
    // beyond them (the channel behind a gate stays at its normal level)
    const gate = new Uint8Array(N);
    (s.gates || []).forEach((c) => { if (c >= 0 && c < N) gate[c] = 1; });

    const junc = new Int32Array(N).fill(-1);
    const wse = new Float64Array(N).fill(NaN);
    // highest levee between a stream cell and the controlled channel it
    // joins: backwater can't pass a levee crest above its own level. (Only
    // levees count: road embankments over creeks have culverts.)
    const lev = s.levee || null;
    const crest = new Float64Array(N).fill(-Infinity);
    for (let j = 0; j < nOrder; j++) {
      const c = order[j];
      if (!stream[c]) continue;
      if (onPath[c]) { junc[c] = c; wse[c] = pathWse[c]; continue; }
      const r = rec[c];
      junc[c] = gate[c] ? -2 : (r >= 0 && stream[r]) ? junc[r] : -1;
      if (junc[c] >= 0) {
        if (lev) {
          crest[c] = Math.max(crest[r], lev[r] || lev[c] ? a.dem[lev[c] ? c : r] : -Infinity);
          if (crest[c] > wse[junc[c]]) junc[c] = -2;
        }
      }
      if (junc[c] === -2) wse[c] = a.dem[c];
      else if (junc[c] >= 0) wse[c] = wse[junc[c]] + grad * (chain[c] - chain[junc[c]]);
      else wse[c] = s.bayLevel + grad * chain[c];
    }
    return { wse, onPath };
  }

  /* --------------------------------------------------------------- inundation */

  /**
   * Connected inundation for one scenario.
   * Returns { wet (Uint8), depth (Float32), level (Float32), wse, onPath }
   */
  function inundate(a, s) {
    const { W, H, N, dem, valid, ocean, stream, recvStream } = a;
    // s.wse: a water surface supplied by the caller (the flood over time)
    const { wse, onPath } = s.wse ? { wse: s.wse, onPath: new Uint8Array(N) } : streamSurface(a, s);
    const level = new Float32Array(N).fill(NaN);
    for (let c = 0; c < N; c++) {
      if (!valid[c]) continue;
      if (recvStream[c] >= 0) level[c] = wse[recvStream[c]];
      else level[c] = s.bayLevel; // sea, or land draining straight to it
    }
    const wet = new Uint8Array(N);
    const q = new Int32Array(N);
    let qh = 0, qt = 0;
    for (let c = 0; c < N; c++) {
      if (!valid[c]) continue;
      if ((ocean[c] || stream[c]) && dem[c] < level[c]) { wet[c] = 1; q[qt++] = c; }
    }
    // Levees (s.levee: a mask of levee cells): water that gets onto or past
    // a levee (over the top, through a breach or a failed section) carries
    // the level from the side it came from, so the land behind fills to the
    // river's level rather than its own drain's.
    const lev = s.levee || null;
    const carried = lev ? new Uint8Array(N) : null;
    const cellArea = a.cell * a.cell;
    let budget = Infinity, spent = 0;
    if (lev) {
      let b = 0;
      for (let c = 0; c < N; c++) {
        if (!lev[c]) continue;
        const stage = level[c];
        const crest = dem[c];
        const do_ = stage - crest;
        if (do_ > 0) {
          const q = 0.6 * (2/3) * Math.sqrt(2*9.81) * a.cell * Math.pow(do_, 1.5);
          b += q * (24*3600);
        }
      }
      if (b > 0) budget = b;
    }
    while (qh < qt) {
      const c = q[qh++], cx = c % W, cy = (c - cx) / W;
      for (let k = 0; k < 4; k++) {
        const nx = cx + DX[k], ny = cy + DY[k];
        if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue;
        const n = ny * W + nx;
        if (wet[n] || !valid[n]) continue;
        let L = level[n];
        let carry = false;
        if (lev && (lev[n] || carried[c]) && level[c] > L) {
          const vol = (level[c] - L) * cellArea;
          if (spent + vol <= budget) { L = level[c]; carry = true; }
        }
        if (dem[n] < L) {
          wet[n] = 1;
          if (carry) { level[n] = L; carried[n] = 1; spent += (L - dem[n]) * cellArea; }
          q[qt++] = n;
        }
      }
    }
    const depth = new Float32Array(N);
    for (let c = 0; c < N; c++) if (wet[c]) depth[c] = level[c] - dem[c];
    return { wet, depth, level, wse, onPath };
  }

  /* ------------------------------------------------------- flood over time */

  /**
   * A flood wave through the model: the gauge rises smoothly from o.baseLevel
   * to the scenario's peak over o.riseHours and falls back over o.fallHours;
   * the wave travels along the river at o.speedKmh, so places downstream of
   * the gauge see it later and places upstream earlier. The water surface at
   * any moment is interpolated between the surfaces for two gauge levels
   * (it is linear in the gauge level along each channel). Returns, per cell,
   * the first and last time step it is wet and at least 0.3 m deep (-1:
   * never), the time axis, and the number of cells wet at each step.
   */
  //   o.hydro: optional recorded readings [[hours, level], ...]; their shape
  //   is used, shifted so the recorded peak matches the scenario's peak
  //   o.flatten: how much the wave spreads out downstream (hours of spread
  //   per square root of km travelled); 0 keeps its shape
  //   o.route: route the flood down the river from the gauge instead
  //   (Muskingum-Cunge, with the wave's spreading worked out from the
  //   river's slope and flood depth, and tributaries joining below the
  //   gauge adding their own, usually earlier, flood)
  //   o.tide: { amp (m), atPeak: 'high' | 'low' }: the sea rises and falls
  //   with the tide (period 12.42 h) instead of staying at the scenario's
  //   sea level, which becomes the high-tide level
  function waveSetup(a, s, o) {
    const rec = o.hydro && o.hydro.length > 1 ? o.hydro : null;
    let recShift = 0, recMin = 0;
    if (rec) {
      const pk = Math.max(...rec.map((r) => r[1]));
      recShift = s.gaugeLevel - pk;
      recMin = Math.min(...rec.map((r) => r[1])) + recShift;
    }
    const base = rec ? recMin : o.baseLevel, peak = s.gaugeLevel;
    const lo = Math.min(base, peak - 0.5), hi = Math.max(peak, lo + 0.5);
    // with tides, the river surfaces are worked out at low water; the tide
    // then rises over them near the mouth
    // o.sea: recorded sea levels for a recorded flood [[hours, m above mean
    // sea level]], used as the sea instead of the scenario's bay level
    const sea = o.sea && o.sea.length > 1 ? o.sea : null;
    const seaLo = sea ? Math.min(...sea.map((r) => r[1])) : 0, seaHi = sea ? Math.max(...sea.map((r) => r[1])) : 0;
    const amp = sea ? Math.max(0.01, (seaHi - seaLo) / 2) : o.tide && o.tide.amp > 0 ? o.tide.amp : 0;
    const sLow = sea ? Object.assign({}, s, { bayLevel: seaLo }) : amp ? Object.assign({}, s, { bayLevel: s.bayLevel - 2 * amp }) : s;
    const w0 = streamSurface(a, Object.assign({}, sLow, { gaugeLevel: lo })).wse;
    const w1 = streamSurface(a, Object.assign({}, sLow, { gaugeLevel: hi })).wse;
    const cells = [];
    for (let c = 0; c < a.N; c++) if (a.stream[c] && Number.isFinite(w0[c]) && Number.isFinite(w1[c])) cells.push(c);
    const g = s.gauge >= 0 ? s.gauge : a.mainOutlet;
    const speed = Math.max(0.1, o.speedKmh || 3);
    const arrive = new Float32Array(a.N);
    let minA = 0, maxA = 0;
    for (const c of cells) {
      const h = (a.chain[g] - a.chain[c]) / 1000 / speed;   // + downstream, - upstream
      arrive[c] = h;
      if (h < minA) minA = h;
      if (h > maxA) maxA = h;
    }
    const rise = Math.max(0.5, o.riseHours || 24), fall = Math.max(0.5, o.fallHours || 48);
    let gaugeAt, tStart, tEnd;
    if (rec) {
      tStart = rec[0][0]; tEnd = rec[rec.length - 1][0];
      gaugeAt = (t) => {
        if (t <= rec[0][0]) return rec[0][1] + recShift;
        if (t >= tEnd) return rec[rec.length - 1][1] + recShift;
        let lo2 = 0, hi2 = rec.length - 1;
        while (hi2 - lo2 > 1) { const m = (lo2 + hi2) >> 1; if (rec[m][0] <= t) lo2 = m; else hi2 = m; }
        const [t0, v0] = rec[lo2], [t1, v1] = rec[hi2];
        return v0 + ((v1 - v0) * (t - t0)) / Math.max(1e-9, t1 - t0) + recShift;
      };
    } else {
      tStart = 0; tEnd = rise + fall;
      gaugeAt = (t) => (t <= 0 ? base : t < rise ? base + (peak - base) * 0.5 * (1 - Math.cos((Math.PI * t) / rise))
        : t < rise + fall ? base + (peak - base) * 0.5 * (1 + Math.cos((Math.PI * (t - rise)) / fall)) : base);
    }
    // A dam release upstream (o.release: { startHours, hours, frac }): extra
    // flow, as a fraction of the flood's peak flow at the gauge, arriving at
    // the gauge from startHours for hours, ramping up and down over 3 h.
    // Levels and flows are related as for routing: flow ~ (level - bed)^b,
    // with the gauge's measured rating where there is one.
    let releaseInfo = null;
    if (o.release && o.release.frac > 0 && o.release.hours > 0) {
      const rt = o.rating && o.rating.b > 0.5 && o.rating.depth > 0 ? o.rating : null;
      const zb = rt ? lo - Math.max(0.1, rt.depth) : Math.min(a.dem[g] - 1, lo - 0.5);
      const bx = rt ? Math.min(4, Math.max(0.8, rt.b)) : 5 / 3, span = hi - zb;
      const qOf = (h) => Math.pow(Math.max(0, (h - zb) / span), bx), hOf = (q) => zb + span * Math.pow(Math.max(0, q), 1 / bx);
      const qPeak = qOf(peak), t0 = o.release.startHours, t1 = t0 + o.release.hours, ramp = Math.min(3, o.release.hours / 2);
      const rel = (t) => (t <= t0 || t >= t1 ? 0 : Math.min(1, (t - t0) / ramp, (t1 - t) / ramp)) * o.release.frac * qPeak;
      const g0 = gaugeAt;
      gaugeAt = (t) => { const r = rel(t); return r > 0 ? hOf(qOf(g0(t)) + r) : g0(t); };
      tStart = Math.min(tStart, t0 - 1); tEnd = Math.max(tEnd, t1 + 1);
      let top = -Infinity;
      for (let t = tStart; t <= tEnd; t += 0.5) top = Math.max(top, gaugeAt(t));
      releaseInfo = { frac: o.release.frac, peakWith: top, rise: top - peak };
    }
    // the wave flattening as it travels downstream: the gauge's record
    // smoothed with a Gaussian whose spread grows with distance
    const flatten = Math.max(0, o.flatten || 0);
    const bandKm = [0, 1, 2, 5, 10, 20, 40, 80, 160];
    const band = new Uint8Array(a.N);
    let at = [gaugeAt];
    if (flatten > 0) {
      const pad = Math.ceil(3 * flatten * Math.sqrt(bandKm[bandKm.length - 1])) + 2;
      const T0 = Math.floor(tStart - pad), T1 = Math.ceil(tEnd + pad), n = T1 - T0 + 1;
      const raw = new Float64Array(n);
      for (let i = 0; i < n; i++) raw[i] = gaugeAt(T0 + i);
      at = bandKm.map((km, b) => {
        if (!b) return gaugeAt;
        const sig = flatten * Math.sqrt(km), r = Math.ceil(3 * sig), sm = new Float64Array(n);
        const wts = []; let wsum = 0;
        for (let k = -r; k <= r; k++) { const wv = Math.exp(-(k * k) / (2 * sig * sig)); wts.push(wv); wsum += wv; }
        for (let i = 0; i < n; i++) {
          let acc = 0;
          for (let k = -r; k <= r; k++) acc += wts[k + r] * raw[Math.min(n - 1, Math.max(0, i + k))];
          sm[i] = acc / wsum;
        }
        return (t) => { const x = Math.min(n - 1, Math.max(0, t - T0)), i0 = Math.floor(x), f = x - i0; return sm[i0] + (sm[Math.min(n - 1, i0 + 1)] - sm[i0]) * f; };
      });
      for (const c of cells) {
        if (arrive[c] <= 0) continue;
        const km = arrive[c] * speed;
        let b = 0;
        for (let k = 1; k < bandKm.length; k++) if (Math.abs(bandKm[k] - km) < Math.abs(bandKm[b] - km)) b = k;
        band[c] = b;
      }
    }
    const tPeak = rec ? rec.reduce((m, r) => (r[1] > m[1] ? r : m))[0] : rise;
    const w = { lo, hi, w0, w1, cells: Int32Array.from(cells), arrive, minA, maxA, rise, fall, gaugeAt, at, band, tStart, tEnd, tPeak, routed: null };
    w.release = releaseInfo;
    if (o.route && g >= 0) w.routed = routeDown(a, s, w, g, speed, o.rating);
    if (rec && o.others && o.others.length && g >= 0) w.up = betweenGauges(a, w, g, speed, o.others);
    if (w.routed) w.maxA = Math.max(w.maxA, w.routed.extraHours);
    // the tide: high water (the scenario's sea level) at the river's peak,
    // or low water at the peak
    w.bayAt = sea
      ? (t) => {
        if (t <= sea[0][0]) return sea[0][1];
        if (t >= sea[sea.length - 1][0]) return sea[sea.length - 1][1];
        let i0 = 0, i1 = sea.length - 1;
        while (i1 - i0 > 1) { const m = (i0 + i1) >> 1; if (sea[m][0] <= t) i0 = m; else i1 = m; }
        return sea[i0][1] + ((sea[i1][1] - sea[i0][1]) * (t - sea[i0][0])) / Math.max(1e-9, sea[i1][0] - sea[i0][0]);
      }
      : amp
      ? (t) => s.bayLevel - amp * (1 - Math.cos((2 * Math.PI * (t - tPeak - (o.tide.atPeak === 'low' ? 6.21 : 0))) / 12.42))
      : () => s.bayLevel;
    w.tide = amp;
    w.seaRecorded = sea ? { lo: seaLo, hi: seaHi } : null;
    return w;
  }

  /**
   * Other gauges on the river with readings for the same flood (o.others:
   * [{cell, hydro}], above or below the main gauge): along the river
   * between two gauges the level blends their readings by distance, each
   * shifted by the wave's travel time from it; above the top gauge the
   * level follows that gauge, earlier by the travel time. Below the lowest
   * gauge the flood is routed (or shifted) from the main gauge as usual. Readings are used as a rise from each gauge's lowest to
   * highest reading, mapped to the scenario's range at the main gauge.
   */
  function betweenGauges(a, w, g, speedKmh, others) {
    const { N, rec, chain, order, nOrder, stream } = a;
    const cms = speedKmh * 1000;
    const base = w.gaugeAt(w.tStart), pk = Math.max(...Array.from({ length: 200 }, (_, i) => w.gaugeAt(w.tStart + ((w.tEnd - w.tStart) * i) / 199)));
    const rng = Math.max(0.01, pk - base);
    const rel = [(t) => (w.gaugeAt(t) - base) / rng];
    const cells = [g], used = [];
    for (const ot of others) {
      if (!ot || ot.cell < 0 || ot.cell >= N || !stream[ot.cell] || !ot.hydro || ot.hydro.length < 2 || cells.includes(ot.cell)) continue;
      let c = ot.cell, n = 0;
      while (c >= 0 && c !== g && n < N) { c = rec[c]; n++; }
      let below = false;
      if (c !== g) {   // not upstream of the main gauge: is it downstream of it?
        for (let d = rec[g]; d >= 0; d = rec[d]) if (d === ot.cell) { below = true; break; }
        if (!below) continue;
      }
      const h = ot.hydro, lo = Math.min(...h.map((r) => r[1])), hi = Math.max(...h.map((r) => r[1]));
      const span2 = Math.max(0.01, hi - lo);
      rel.push((t) => {
        if (t <= h[0][0]) return (h[0][1] - lo) / span2;
        if (t >= h[h.length - 1][0]) return (h[h.length - 1][1] - lo) / span2;
        let i0 = 0, i1 = h.length - 1;
        while (i1 - i0 > 1) { const m = (i0 + i1) >> 1; if (h[m][0] <= t) i0 = m; else i1 = m; }
        const f = (t - h[i0][0]) / Math.max(1e-9, h[i1][0] - h[i0][0]);
        return (h[i0][1] + (h[i1][1] - h[i0][1]) * f - lo) / span2;
      });
      cells.push(ot.cell); used.push(ot.name || '');
    }
    if (cells.length < 2) return null;
    const gi = new Map(cells.map((c, k) => [c, k]));
    const belowMain = new Set();
    for (let d = rec[g]; d >= 0; d = rec[d]) if (gi.has(d)) belowMain.add(d);
    const cellsDown = (c) => belowMain.has(c);
    const k1 = new Int16Array(N).fill(-1), k2 = new Int16Array(N).fill(-1), f = new Float32Array(N), d1 = new Float32Array(N), d2 = new Float32Array(N);
    // between each gauge and the next gauge down (the main gauge included,
    // when another gauge lies below it)
    const down = new Uint8Array(N);
    for (let k = 0; k < cells.length; k++) {
      const U = cells[k];
      let L = rec[U];
      while (L >= 0 && !gi.has(L)) L = rec[L];
      if (L < 0) continue;
      const len = Math.max(1, chain[U] - chain[L]);
      let isDown = U === g;
      for (let x = rec[g]; x >= 0 && !isDown; x = rec[x]) if (x === U) isDown = true;
      for (let c = U; c !== L; c = rec[c]) {
        k1[c] = k; k2[c] = gi.get(L); f[c] = (chain[U] - chain[c]) / len;
        d1[c] = (chain[U] - chain[c]) / cms; d2[c] = (chain[c] - chain[L]) / cms;
        if (isDown) down[c] = 1;
      }
    }
    // the lowest gauge itself follows its own readings
    for (let k = 1; k < cells.length; k++) if (k1[cells[k]] < 0) { k1[cells[k]] = k; k2[cells[k]] = -1; f[cells[k]] = 0; d1[cells[k]] = 0; }
    // above each upstream gauge: that gauge's readings, earlier
    const first = new Int32Array(N).fill(-1);
    for (let j = 0; j < nOrder; j++) {
      const c = order[j];
      first[c] = gi.has(c) ? c : rec[c] >= 0 ? first[rec[c]] : -1;
      if (first[c] >= 0 && first[c] !== g && k1[c] < 0 && stream[c] && !down[first[c]] && !cellsDown(first[c])) {
        k1[c] = gi.get(first[c]); k2[c] = -1; f[c] = 0; d1[c] = -(chain[c] - chain[first[c]]) / cms;
      } else if (k1[c] < 0 && stream[c] && rec[c] >= 0 && down[rec[c]]) {
        // a tributary joining between gauges below the main gauge backs up
        // from the river there
        k1[c] = k1[rec[c]]; k2[c] = k2[rec[c]]; f[c] = f[rec[c]]; d1[c] = d1[rec[c]]; d2[c] = d2[rec[c]]; down[c] = 1;
      }
    }
    return { rel, k1, k2, f, d1, d2, base, rng, gauges: cells.length - 1, below: belowMain.size, names: used };
  }

  // Time of concentration (hours) for a catchment of A km² (ARR)
  const tcHours = (Akm2) => 0.76 * Math.pow(Math.max(Akm2, 0.01), 0.38);

  /**
   * Route the gauge's flood down the river below it (Muskingum-Cunge).
   * Flow is taken as proportional to depth^(5/3) (a wide channel, Manning),
   * so the gauge's levels become relative flows. Below the gauge the river
   * is split into reaches at least one time step of travel long; each
   * reach's spreading (diffusion D = q / 2S, here 0.3·c·h/S for wave speed
   * c, flood depth h and water-surface slope S) sets the Muskingum X, and
   * long, flat, deep reaches get longer reaches so X stays >= 0. Each
   * tributary joining below the gauge adds the gauge's flood scaled by its
   * catchment area and shifted by the difference in time of concentration
   * (small creeks peak sooner); local runoff between tributaries is added
   * the same way. Each cell's level is then the gauge level that gives the
   * same fraction of its peak flow (if everything peaked together, as the
   * steady scenario assumes, levels match the steady surface at the peak).
   * Tributary channels below the gauge follow the river's level where they
   * join it (backwater, as in the steady surface).
   */
  //   rating: optional { b, depth } from the gauge's measured flows: flow
  //   goes as (level - bed)^b, with the bed 'depth' metres below the
  //   river's normal level (instead of b = 5/3 and a bed 1 m down)
  function routeDown(a, s, w, g, speedKmh, rating) {
    const { N, rec, chain, stream, acc, order, nOrder } = a;
    const cellKm2 = (a.cell * a.cell) / 1e6;
    const Ag = Math.max(acc[g] * cellKm2, 0.01), tcg = tcHours(Ag);
    const useR = rating && rating.b > 0.5 && rating.depth > 0;
    const zb = useR ? w.lo - Math.max(0.1, rating.depth) : Math.min(a.dem[g] - 1, w.lo - 0.5);   // bed at the gauge
    const bx = useR ? Math.min(4, Math.max(0.8, rating.b)) : 5 / 3;
    const span = w.hi - zb;
    const qOf = (h) => Math.pow(Math.max(0, (h - zb) / span), bx);
    const hOf = (q) => zb + span * Math.pow(Math.max(0, q), 1 / bx);
    // the path below the gauge
    const path = [];
    const onP = new Int32Array(N).fill(-1);
    for (let c = g; c >= 0; c = rec[c]) { onP[c] = path.length; path.push(c); }
    if (path.length < 3) return null;
    // tributary entries along the path, and which entry each tributary cell is on
    const entry = new Int32Array(N).fill(-1);   // -1 none, -2 above the gauge
    entry[g] = -2;
    for (let j = 0; j < nOrder; j++) {
      const c = order[j];
      if (c === g || onP[c] >= 0) continue;
      const r = rec[c];
      if (r < 0) continue;
      if (r === g || entry[r] === -2) { entry[c] = -2; continue; }
      if (!stream[c]) continue;
      if (onP[r] >= 0) entry[c] = c;
      else if (stream[r] && entry[r] >= 0) entry[c] = entry[r];
    }
    const cms = speedKmh * 1000;   // m/h
    const T = w.tEnd - w.tStart;
    const dt = Math.min(1, Math.max(0.1, Math.min(w.rise, T) / 12));
    const travel = chain[g] / cms;   // hours from the gauge to the outlet
    let minLag = 0;
    const inflow = new Map();   // path index of the junction -> [{A, lag}]
    for (let c = 0; c < N; c++) {
      if (entry[c] !== c) continue;
      const A = acc[c] * cellKm2, lag = tcHours(A) - tcg;
      const k = onP[rec[c]];
      (inflow.get(k) || inflow.set(k, []).get(k)).push({ A, lag });
      if (lag < minLag) minLag = lag;
    }
    // local runoff along the path: catchment gained beyond the tributaries
    for (let k = 1; k < path.length; k++) {
      const c = path[k], up = path[k - 1];
      let A = (acc[c] - acc[up]) * cellKm2;
      for (const e of inflow.get(k) || []) A -= e.A;
      if (A > 0.01) {
        const lag = tcHours(A) - tcg;
        (inflow.get(k) || inflow.set(k, []).get(k)).push({ A, lag, local: true });
        if (lag < minLag) minLag = lag;
      }
    }
    const T0 = Math.floor(w.tStart + minLag - 2);
    const nT = Math.ceil((w.tEnd + travel * 2 + 48 - T0) / dt) + 1;
    const qg = new Float64Array(nT);
    for (let i = 0; i < nT; i++) qg[i] = qOf(w.gaugeAt(T0 + i * dt));
    const shifted = (lag, scale, out) => {
      for (let i = 0; i < nT; i++) {
        const x = i - lag / dt, i0 = Math.floor(x), f = x - i0;
        const v0 = qg[Math.min(nT - 1, Math.max(0, i0))], v1 = qg[Math.min(nT - 1, Math.max(0, i0 + 1))];
        out[i] += scale * (v0 + (v1 - v0) * f);
      }
    };
    // depth and slope along the path (slope over about 3 km)
    const depth = (c) => Math.max(0.5, w.w1[c] - Math.min(a.dem[c] - 1, w.w0[c] - 0.5));
    const slopeAt = (k) => {
      let u = k, d = k;
      while (u > 0 && chain[path[u]] - chain[path[k]] < 1500) u--;
      while (d < path.length - 1 && chain[path[k]] - chain[path[d]] < 1500) d++;
      const L = chain[path[u]] - chain[path[d]];
      return L > 0 ? Math.max(2e-5, Math.abs(w.w1[path[u]] - w.w1[path[d]]) / L) : 2e-5;
    };
    // reaches: nodes at path indices
    const nodes = [0];
    let k = 0;
    while (k < path.length - 1) {
      const D = Math.min(0.3 * cms * depth(path[k]) / slopeAt(k), 5e8);
      const Lmin = Math.min(Math.max(cms * dt, (2 * D) / cms, a.cell), 60000);
      let j = k + 1;
      while (j < path.length - 1 && chain[path[k]] - chain[path[j]] < Lmin) j++;
      nodes.push(j);
      k = j;
    }
    // route, reach by reach; peak reference flows add up the same inflows
    const flows = [];
    let Q = Float64Array.from(qg), Qref = Math.max(...qg);
    const addInflows = (k0, k1, into) => {   // inflows joining at path index k0 < k <= k1
      let ref = 0;
      for (let kk = k0 + 1; kk <= k1; kk++) for (const e of inflow.get(kk) || []) {
        const sc = e.A / Ag;
        shifted(e.lag, sc, into);
        ref += sc * Math.max(...qg);
      }
      return ref;
    };
    flows.push({ k: 0, Q, ref: Qref });
    for (let n = 1; n < nodes.length; n++) {
      const k0 = nodes[n - 1], k1 = nodes[n];
      const I = Float64Array.from(Q);
      Qref += addInflows(k0, k1, I);
      const L = Math.max(a.cell, chain[path[k0]] - chain[path[k1]]);
      let D = 0;
      for (let kk = k0; kk < k1; kk++) D += 0.3 * cms * depth(path[kk]) / slopeAt(kk);
      D = Math.min(D / Math.max(1, k1 - k0), 5e8);
      // Floodplain storage: widen K by floodplain area near the reach.
      let fpCells = 0;
      const bed = a.dem[path[k0]];
      for (let kk = k0; kk <= k1; kk++) {
        const c = path[kk], cx = c % a.W, cy = (c - cx) / a.W;
        for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) {
          const nx = cx + dx, ny = cy + dy;
          if (nx < 0 || ny < 0 || nx >= a.W || ny >= a.H) continue;
          const nn = ny * a.W + nx;
          if (!a.valid[nn]) continue;
          if (Math.abs(a.dem[nn] - bed) <= 2) fpCells++;
        }
      }
      const fpRatio = fpCells / Math.max(1, k1 - k0 + 1);
      const K = (L / cms) * (1 + 0.3 * fpRatio);
      const X = Math.max(0, Math.min(0.5 - D / (cms * L), (cms * dt) / (2 * L), 0.5));
      const den = K * (1 - X) + dt / 2;
      const C0 = (dt / 2 - K * X) / den, C1 = (dt / 2 + K * X) / den, C2 = (K * (1 - X) - dt / 2) / den;
      const O = new Float64Array(nT);
      O[0] = I[0];
      for (let i = 1; i < nT; i++) O[i] = Math.max(0, C0 * I[i] + C1 * I[i - 1] + C2 * O[i - 1]);
      Q = O;
      flows.push({ k: k1, Q, ref: Qref, K, X });
    }
    // each path cell sits between two nodes
    const cellA = new Int32Array(N).fill(-1), cellF = new Float32Array(N);
    for (let n = 1; n < flows.length; n++) {
      const k0 = flows[n - 1].k, k1 = flows[n].k, L = chain[path[k0]] - chain[path[k1]];
      for (let kk = k0; kk <= k1; kk++) {
        cellA[path[kk]] = n - 1;
        cellF[path[kk]] = L > 0 ? (chain[path[k0]] - chain[path[kk]]) / L : 1;
      }
    }
    // tributary channels below the gauge back up from the river they join
    // (as in the steady surface), so they follow its level at the junction
    for (let c = 0; c < N; c++) {
      const e = entry[c];
      if (e < 0 || !stream[c]) continue;
      const j = rec[e];
      cellA[c] = cellA[j]; cellF[c] = cellF[j];
    }
    const qPk = Math.max(...qg);
    return {
      T0, dt, nT, flows, cellA, cellF, hOf, qPk, exponent: bx, rated: !!useR,
      reaches: flows.slice(1).map((f) => ({ km: (chain[path[0]] - chain[path[f.k]]) / 1000, K: f.K, X: f.X })),
      tributaries: Array.from(inflow.values()).flat().filter((e) => !e.local).length,
      extraHours: (T0 + nT * dt) - w.tEnd,
      peakAt(n) { const f = flows[n]; let m = 0, im = 0; for (let i = 0; i < nT; i++) if (f.Q[i] / f.ref > m) { m = f.Q[i] / f.ref; im = i; } return { frac: m, hours: T0 + im * dt }; },
    };
  }

  function waveSurface(a, w, t, out) {
    const wse = out || new Float64Array(a.N).fill(NaN);
    const span = w.hi - w.lo, R = w.routed;
    let ti = 0, tf = 0;
    if (R) { const x = Math.min(R.nT - 1, Math.max(0, (t - R.T0) / R.dt)); ti = Math.min(R.nT - 2, Math.floor(x)); tf = x - ti; }
    const bay = w.bayAt ? w.bayAt(t) : NaN;
    for (const c of w.cells) {
      let h;
      if (w.up && w.up.k1[c] >= 0) {
        const U = w.up, r1 = U.rel[U.k1[c]](t - U.d1[c]);
        const r = U.k2[c] >= 0 ? r1 * (1 - U.f[c]) + U.rel[U.k2[c]](t + U.d2[c]) * U.f[c] : r1;
        h = U.base + r * U.rng;
      } else if (R && R.cellA[c] >= 0) {
        const n = R.cellA[c], f = R.cellF[c], A = R.flows[n], B = R.flows[n + 1];
        const qa = (A.Q[ti] + (A.Q[ti + 1] - A.Q[ti]) * tf) / A.ref, qb = (B.Q[ti] + (B.Q[ti + 1] - B.Q[ti]) * tf) / B.ref;
        h = R.hOf((qa + (qb - qa) * f) * R.qPk);
      } else h = w.at[w.band[c]](t - w.arrive[c]);
      let v = w.w0[c] + ((w.w1[c] - w.w0[c]) * (h - w.lo)) / span;
      if (w.tide && bay > v) v = bay;
      wse[c] = v;
    }
    return wse;
  }
  function floodTimeline(a, s, o) {
    const w = waveSetup(a, s, o);
    const t0 = Math.floor(w.tStart + w.minA) - 1, t1 = Math.ceil(w.tEnd + w.maxA) + 1;
    const step = Math.max(o.stepHours || 1, (t1 - t0) / (o.maxSteps || 120));
    const steps = Math.ceil((t1 - t0) / step) + 1;
    const N = a.N;
    const firstWet = new Int16Array(N).fill(-1), lastWet = new Int16Array(N).fill(-1);
    const firstDeep = new Int16Array(N).fill(-1), lastDeep = new Int16Array(N).fill(-1);
    const wetCount = new Int32Array(steps), gauge = new Float32Array(steps);
    // Packed states retain dry gaps between tides or separate flood peaks
    // without keeping a full depth raster for every time step.
    const wordsPerStep = Math.ceil(N / 32);
    const wetBits = new Uint32Array(steps * wordsPerStep), deepBits = new Uint32Array(steps * wordsPerStep);
    const wse = new Float64Array(N).fill(NaN);
    for (let k = 0; k < steps; k++) {
      const t = t0 + k * step;
      gauge[k] = w.gaugeAt(t);
      waveSurface(a, w, t, wse);
      const run = inundate(a, Object.assign({}, s, { wse, bayLevel: w.bayAt(t) }));
      let n = 0;
      for (let c = 0; c < N; c++) {
        if (!run.wet[c] || (a.ocean && a.ocean[c])) continue;
        n++;
        const word = k * wordsPerStep + (c >>> 5), bit = 1 << (c & 31);
        wetBits[word] |= bit;
        if (run.depth[c] >= 0.3) deepBits[word] |= bit;
        if (firstWet[c] < 0) firstWet[c] = k;
        lastWet[c] = k;
        if (run.depth[c] >= 0.3) { if (firstDeep[c] < 0) firstDeep[c] = k; lastDeep[c] = k; }
      }
      wetCount[k] = n;
    }
    return { t0, step, steps, firstWet, lastWet, firstDeep, lastDeep, wetCount, gauge, wordsPerStep, wetBits, deepBits };
  }

  /* ------------------------------------------------------------- defences */

  /**
   * Burn levees into a terrain grid. defs.levees: [{ cells (grid indices
   * along the levee), height (m above the ground beside it) or null to take
   * the crest from the terrain itself (LiDAR shows most levees), failed,
   * breaches: [cell indices] }]. An intact levee raises its cells to the
   * crest; a failed levee, and the cells around each breach, are lowered to
   * the ground beside them. Returns a new grid; the input is untouched.
   */
  function burnDefences(grid, defs) {
    const { W, H, dem } = grid;
    const N = W * H;
    const out = Float32Array.from(dem);
    const isLev = new Uint8Array(N);
    const levees = (defs && defs.levees) || [];
    levees.forEach((l) => l.cells.forEach((c) => { if (c >= 0 && c < N) isLev[c] = 1; }));
    const around = (c, r, fn) => {
      const cx = c % W, cy = (c - cx) / W;
      for (let dy = -r; dy <= r; dy++) for (let dx = -r; dx <= r; dx++) {
        const x = cx + dx, y = cy + dy;
        if (x >= 0 && y >= 0 && x < W && y < H) fn(y * W + x);
      }
    };
    // the ground beside a levee: the median of the land around it (not the
    // lowest point, which is often the river channel next to it)
    const ground = (c) => {
      const v = [];
      around(c, 3, (n) => { if (!isLev[n]) v.push(dem[n]); });
      if (!v.length) return dem[c];
      v.sort((x, y) => x - y);
      return v[Math.floor(v.length / 2)];
    };
    const crestOf = (c) => { let m = -Infinity; around(c, 1, (n) => { if (dem[n] > m) m = dem[n]; }); return m; };
    for (const l of levees) {
      const breach = new Set();
      const br = Math.max(1, Math.round((l.breachWidth || 60) / 2 / grid.cell));
      (l.breaches || []).forEach((b) => around(b, br, (n) => breach.add(n)));
      for (const c of l.cells) {
        if (c < 0 || c >= N) continue;
        if (l.failed || breach.has(c)) {
          // lower the levee and anything left of it in the terrain
          const g = ground(c);
          around(c, 1, (n) => { if (isLev[n] || n === c) out[n] = Math.min(out[n], g); });
          out[c] = Math.min(out[c], g);
        } else {
          const crest = l.height != null ? ground(c) + l.height : crestOf(c);
          if (crest > out[c]) out[c] = crest;
        }
      }
    }
    return Object.assign({}, grid, { dem: out });
  }

  /** Grid cells along a polyline of [x, y] grid coordinates (8-connected). */
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

  /* ------------------------------------------------------------ flash flood */

  /**
   * Rainfall uplift for a warmer climate, following the draft Australian
   * Rainfall and Runoff climate guidance (2024): about 15% more rain per °C
   * of warming for storms of an hour or less and 8% per °C for a day or
   * longer, in between by the logarithm of the duration; compounded per
   * degree. Returns the factor to multiply rainfall by.
   */
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
  function flashFlood(a, o) {
    const { W, H, N, dem, valid, ocean, stream, recvStream, rec, chain, acc, filled, cell } = a;
    const rain = Math.max(0, o.rainMm || 0), hours = Math.max(0.1, o.hours || 1);
    const excessMm = Math.max(0, rain - (o.initialLoss ?? 15) - (o.contLoss ?? 2.5) * hours);
    const C = rain > 0 ? excessMm / rain : 0;
    // average intensity over the storm or over the time water takes to
    // reach a point (time of concentration, tc = 0.76·A^0.38 hours for A in
    // km², the Probabilistic Rational Method), whichever is longer, so big
    // catchments don't see a short storm's peak intensity all at once
    const iAt = (Akm2) => rain / Math.max(hours, 0.76 * Math.pow(Math.max(Akm2, 1e-4), 0.38)) / 1000 / 3600;   // m/s
    const cellA = cell * cell;
    const nCh = o.nChannel ?? 0.05, nOv = o.nOverland ?? 0.035, maxRise = o.maxRise ?? 10;
    const depth = new Float32Array(N), kind = new Uint8Array(N), wet = new Uint8Array(N);
    // built-up catchment area above each cell (cells), for the pipes
    const pipe = o.urban && o.pipeMmH > 0 ? o.pipeMmH / 1000 / 3600 : 0;   // m/s
    let ua = null, urbanCells = 0;
    if (pipe) {
      ua = new Float32Array(N);
      for (let j = a.nOrder - 1; j >= 0; j--) {
        const c = a.order[j];
        if (o.urban[c] && valid[c]) { ua[c] += 1; urbanCells++; }
        if (rec[c] >= 0) ua[rec[c]] += ua[c];
      }
    }
    const slopeAt = (c) => {
      // channel slope over ~10 cells downstream
      let d = c, k = 0;
      while (k < 10 && rec[d] >= 0) { d = rec[d]; k++; }
      const L = chain[c] - chain[d];
      return Math.max(0.002, L > 0 ? (dem[c] - dem[d]) / L : 0.002);
    };
    // creeks: rise at every stream cell
    const rise = new Float32Array(N);
    if (C > 0) {
      for (let c = 0; c < N; c++) {
        if (!stream[c] || !valid[c] || (ocean && ocean[c])) continue;
        const A = acc[c] * cellA, Akm2 = A / 1e6;
        const Q = C * iAt(Akm2) * A;
        const w = Math.max(cell, 20 * Math.pow(Akm2, 0.4));
        rise[c] = Math.min(maxRise, Math.pow((Q * nCh) / (w * Math.sqrt(slopeAt(c))), 0.6));
      }
    }
    // spread each creek's water surface to connected land beside it
    const level = new Float32Array(N).fill(NaN);
    const q = new Int32Array(N);
    let qh = 0, qt = 0;
    for (let c = 0; c < N; c++) {
      if (!valid[c]) continue;
      if (ocean && ocean[c]) { wet[c] = 1; kind[c] = 4; continue; }
      const r = recvStream[c];
      if (r >= 0 && rise[r] > 0.01) level[c] = dem[r] + rise[r];
      if (stream[c] && rise[c] > 0.01) { wet[c] = 1; kind[c] = 1; depth[c] = rise[c]; q[qt++] = c; }
    }
    while (qh < qt) {
      const c = q[qh++], cx = c % W, cy = (c - cx) / W;
      for (let k = 0; k < 4; k++) {
        const nx = cx + DX[k], ny = cy + DY[k];
        if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue;
        const n = ny * W + nx;
        if (wet[n] || !valid[n] || !(dem[n] < level[n])) continue;
        // land beside a creek floods to the creek's level, but a flash flood
        // has too little water to fill pits far below the creek (quarries)
        const r = recvStream[n];
        wet[n] = 1; kind[n] = 1; depth[n] = Math.min(level[n] - dem[n], (r >= 0 ? rise[r] : 0) + 0.5); q[qt++] = n;
      }
    }
    // overland flow away from creeks
    let overland = 0;
    if (C > 0) {
      for (let c = 0; c < N; c++) {
        if (!valid[c] || stream[c] || (ocean && ocean[c]) || rec[c] < 0) continue;
        const qw = Math.max(0, C * iAt((acc[c] * cellA) / 1e6) * acc[c] * cellA - (ua ? pipe * ua[c] * cellA : 0)) / cell;   // m²/s per metre width
        const S = Math.max(0.002, (dem[c] - dem[rec[c]]) / Math.max(cell, chain[c] - chain[rec[c]]));
        const d = Math.pow((qw * nOv) / Math.sqrt(S), 0.6);
        if (d >= 0.1 && d > depth[c]) { depth[c] = d; kind[c] = 2; wet[c] = 1; overland++; }
      }
    }
    // ponding in dips, up to the runoff draining into each
    let pondCells = 0;
    if (filled && excessMm > 0) {
      const lab = new Int32Array(N).fill(-1);
      const cells = [];
      for (let s0 = 0; s0 < N; s0++) {
        if (lab[s0] >= 0 || !valid[s0] || (ocean && ocean[s0]) || filled[s0] - dem[s0] < 0.02) continue;
        const id = cells.length, list = [s0];
        lab[s0] = id;
        for (let h = 0; h < list.length; h++) {
          const c = list[h], cx = c % W, cy = (c - cx) / W;
          for (let k = 0; k < 4; k++) {
            const nx = cx + DX[k], ny = cy + DY[k];
            if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue;
            const n = ny * W + nx;
            if (lab[n] >= 0 || !valid[n] || (ocean && ocean[n]) || filled[n] - dem[n] < 0.02) continue;
            lab[n] = id; list.push(n);
          }
        }
        cells.push(list);
      }
      const ex = excessMm / 1000;
      for (const list of cells) {
        let accMax = 0, cMax = list[0], lo = Infinity, hi = -Infinity;
        for (const c of list) { if (acc[c] > accMax) { accMax = acc[c]; cMax = c; } if (dem[c] < lo) lo = dem[c]; if (filled[c] > hi) hi = filled[c]; }
        // dips more than 5 m deep are quarries, dams or gaps in the data,
        // not places a storm newly floods
        if (hi - lo > (o.maxPondDepth ?? 5)) continue;
        const vol = (L) => { let v = 0; for (const c of list) if (L > dem[c]) v += Math.min(L, filled[c]) - dem[c]; return v * cellA; };
        // runoff in, less what the pipes take from the built-up part
        const piped = ua ? Math.min(ex, pipe * hours * 3600) * ua[cMax] * cellA : 0;
        const vin = ex * accMax * cellA - piped;
        if (vin <= 0) continue;
        let L = hi;
        if (vin < vol(hi)) {
          let a0 = lo, b0 = hi;
          for (let it = 0; it < 30; it++) { const m = (a0 + b0) / 2; if (vol(m) < vin) a0 = m; else b0 = m; }
          L = (a0 + b0) / 2;
        }
        for (const c of list) {
          const d = Math.min(L, filled[c]) - dem[c];
          if (d > 0.02 && d > depth[c]) { depth[c] = d; kind[c] = 3; wet[c] = 1; pondCells++; }
        }
      }
    }
    for (let c = 0; c < N; c++) if (wet[c] && !(ocean && ocean[c])) level[c] = dem[c] + depth[c];
    let creek = 0, maxRiseSeen = 0;
    for (let c = 0; c < N; c++) { if (kind[c] === 1) creek++; if (rise[c] > maxRiseSeen) maxRiseSeen = rise[c]; }
    const km2 = cellA / 1e6;
    return {
      wet, depth, level, kind, wse: rise, onPath: new Uint8Array(N),
      summary: {
        excessMm, runoffCoeff: C, creekKm2: creek * km2, overlandKm2: overland * km2, pondKm2: pondCells * km2,
        maxCreekRise: maxRiseSeen,
        pipedMm: pipe ? Math.min(excessMm, o.pipeMmH * hours) : 0, urbanKm2: urbanCells * km2,
      },
    };
  }

  /**
   * Flood hazard classes H1 to H6 (Australian Disaster Resilience
   * Guideline 7-3): limits on depth D, velocity V and their product DV.
   *   H1 D<=0.3, V<=2, DV<=0.3   generally safe
   *   H2 D<=0.5, V<=2, DV<=0.6   unsafe for small vehicles
   *   H3 D<=1.2, V<=2, DV<=0.6   unsafe for vehicles, children and the elderly
   *   H4 D<=2.0, V<=2, DV<=1.0   unsafe for vehicles and people
   *   H5 D<=4.0, V<=4, DV<=4.0   unsafe for people and vehicles; buildings need engineering design
   *   H6 beyond                  unsafe for all; all building types vulnerable
   */
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
  function hazard(a, run, vx, vy) {
    const { N, rec, chain, stream, recvStream, dem, ocean, cell } = a;
    const cls = new Uint8Array(N), vel = new Float32Array(N);
    const level = run.level;
    // water-surface slope along each stream cell, over about 500 m downstream
    const slope = new Float32Array(N);
    const reach = Math.max(2, Math.round(500 / cell));
    for (let c = 0; c < N; c++) {
      if (!stream[c] || !run.wet[c]) continue;
      let d = c, k = 0;
      while (k < reach && rec[d] >= 0) { d = rec[d]; k++; }
      const L = chain[c] - chain[d];
      const lc = Number.isFinite(level[c]) ? level[c] : dem[c] + run.depth[c];
      const ld = Number.isFinite(level[d]) && run.wet[d] ? level[d] : lc;
      slope[c] = L > 0 ? Math.max(0, (lc - ld) / L) : 0;
    }
    const km2 = [0, 0, 0, 0, 0, 0], cellKm2 = (cell * cell) / 1e6;
    for (let c = 0; c < N; c++) {
      if (!run.wet[c] || (ocean && ocean[c])) continue;
      const D = run.depth[c];
      if (!(D > 0)) continue;
      const kind = run.kind ? run.kind[c] : 0;
      let S = 0, n = 0.06, cap = 4;
      if (kind === 3) S = 0;                                   // ponding: still water
      else if (kind === 2 && rec[c] >= 0) S = Math.max(0, (dem[c] - dem[rec[c]]) / Math.max(cell, chain[c] - chain[rec[c]]));
      else if (stream[c]) { S = slope[c]; n = 0.035; cap = 6; }
      else if (recvStream[c] >= 0) S = slope[recvStream[c]];
      let V;
      if (vx && vy && vx[c] !== undefined && vy[c] !== undefined) {
        V = Math.sqrt(vx[c]*vx[c] + vy[c]*vy[c]);
      } else {
        V = Math.min(cap, (Math.pow(D, 2 / 3) * Math.sqrt(Math.min(S, 0.2))) / n);
      }
      vel[c] = V;
      cls[c] = hazardClass(D, V);
      km2[cls[c] - 1] += cellKm2;
    }
    return { cls, vel, km2 };
  }

  /**
   * Compare two runs cell by cell: 1 wet in both, 2 wet only in the current
   * run, 3 wet only in the pinned one; plus the depth change where wet in
   * both. Returns { diff, dDepth, km2: { both, onlyNow, onlyPinned }, deeperKm2, shallowerKm2 }.
   */
  function compareRuns(a, now, pinned) {
    const N = a.N, diff = new Uint8Array(N), dDepth = new Float32Array(N), cellKm2 = (a.cell * a.cell) / 1e6;
    const km2 = { both: 0, onlyNow: 0, onlyPinned: 0 };
    let deeper = 0, shallower = 0;
    for (let c = 0; c < N; c++) {
      if (a.ocean && a.ocean[c]) continue;
      const w1 = now.wet[c], w0 = pinned.wet[c];
      if (w1 && w0) {
        diff[c] = 1; km2.both += cellKm2;
        dDepth[c] = now.depth[c] - pinned.depth[c];
        if (dDepth[c] > 0.05) deeper += cellKm2; else if (dDepth[c] < -0.05) shallower += cellKm2;
      } else if (w1) { diff[c] = 2; km2.onlyNow += cellKm2; } else if (w0) { diff[c] = 3; km2.onlyPinned += cellKm2; }
    }
    return { diff, dDepth, km2, deeperKm2: deeper, shallowerKm2: shallower };
  }

  /** Combine two runs, keeping the deeper water in each cell. */
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
  function stats(a, run, base) {
    const cellKm2 = (a.cell * a.cell) / 1e6;
    let land = 0, extra = 0, rawMax = 0, sumD = 0, deep = 0;
    const offChannel = [];
    for (let c = 0; c < a.N; c++) {
      if (!run.wet[c] || a.ocean[c]) continue;
      land++;
      if (base && base.wet[c]) continue;
      extra++;
      const d = run.depth[c];
      sumD += d;
      if (d > rawMax) rawMax = d;
      if (d >= 1) deep++;
      if (!a.stream[c]) offChannel.push(d);
    }
    // "Deepest water" is the 99th percentile of newly flooded land away from
    // stream channels: single pits, quarries and carved channel cells in the
    // elevation model otherwise dominate the maximum.
    let p99 = 0;
    if (offChannel.length) {
      offChannel.sort((x, y) => x - y);
      p99 = offChannel[Math.min(offChannel.length - 1, Math.floor(offChannel.length * 0.99))];
    }
    return {
      wetLandKm2: land * cellKm2,
      floodedKm2: extra * cellKm2,
      deepKm2: deep * cellKm2,
      maxDepth: p99,
      rawMaxDepth: rawMax,
      meanDepth: extra ? sumD / extra : 0,
    };
  }

  /* ---------------------------------------------------------- DEM helpers */

  /** Parse an ESRI ASCII grid (.asc) string into { W, H, cell, dem, valid }. */
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
  function parseSimpleTiff(buffer) {
    const dv = new DataView(buffer);
    const bo = dv.getUint16(0);
    if (bo !== 0x4949 && bo !== 0x4d4d) throw new Error('not a TIFF file');
    const le = bo === 0x4949;
    if (dv.getUint16(2, le) !== 42) throw new Error('BigTIFF is not supported');
    const ifd = dv.getUint32(4, le);
    const n = dv.getUint16(ifd, le);
    const SIZE = { 1: 1, 2: 1, 3: 2, 4: 4, 5: 8, 11: 4, 12: 8, 16: 8 };
    const tags = {};
    for (let i = 0; i < n; i++) {
      const e = ifd + 2 + i * 12;
      const tag = dv.getUint16(e, le), type = dv.getUint16(e + 2, le), count = dv.getUint32(e + 4, le);
      const bytes = (SIZE[type] || 1) * count;
      const at = bytes <= 4 ? e + 8 : dv.getUint32(e + 8, le);
      const vals = [];
      if (type === 2) {
        let str = '';
        for (let k = 0; k < count; k++) { const c = dv.getUint8(at + k); if (c) str += String.fromCharCode(c); }
        tags[tag] = str;
        continue;
      }
      for (let k = 0; k < count; k++) {
        const o = at + k * (SIZE[type] || 1);
        if (type === 3) vals.push(dv.getUint16(o, le));
        else if (type === 4 || type === 16) vals.push(dv.getUint32(o, le));
        else if (type === 11) vals.push(dv.getFloat32(o, le));
        else if (type === 12) vals.push(dv.getFloat64(o, le));
        else vals.push(dv.getUint8(o));
      }
      tags[tag] = vals;
    }
    const W = tags[256][0], H = tags[257][0];
    const bits = (tags[258] || [32])[0], fmt = (tags[339] || [1])[0], comp = (tags[259] || [1])[0];
    const spp = (tags[277] || [1])[0];
    if (comp !== 1 || bits !== 32 || fmt !== 3 || spp !== 1) throw new Error('unsupported TIFF layout');
    const nodata = tags[42113] != null ? parseFloat(tags[42113]) : NaN; // GDAL_NODATA
    const fill = Number.isFinite(nodata) ? nodata : NaN;
    const data = new Float32Array(W * H).fill(fill);
    const read = (off, count, w, h, x0, y0, bw) => {
      if (!off || !count || off + count > buffer.byteLength) return; // sparse or truncated: leave no data
      for (let r = 0; r < h; r++) {
        const y = y0 + r;
        if (y >= H) break;
        for (let c = 0; c < w; c++) {
          const x = x0 + c;
          if (x >= W) break;
          data[y * W + x] = dv.getFloat32(off + (r * bw + c) * 4, le);
        }
      }
    };
    if (tags[322]) {
      const tw = tags[322][0], th = tags[323][0];
      const offs = tags[324], cnts = tags[325];
      const across = Math.ceil(W / tw);
      offs.forEach((off, t) => read(off, cnts[t], tw, th, (t % across) * tw, Math.floor(t / across) * th, tw));
    } else {
      const rps = (tags[278] || [H])[0];
      tags[273].forEach((off, k) => read(off, tags[279][k], W, rps, 0, k * rps, W));
    }
    let bounds = null;
    if (tags[33550] && tags[33922]) {
      const [sx, sy] = tags[33550], tp = tags[33922];
      const west = tp[3] - tp[0] * sx, north = tp[4] + tp[1] * sy;
      bounds = [west, north - H * sy, west + W * sx, north];
    }
    return { W, H, data, nodata, bounds };
  }

  return {
    syntheticTerrain, analyse, mainStem, snapToStream, encodeWhiteboxD8,
    streamSurface, inundate, stats, flashFlood, mergeRuns, burnDefences, lineCells, waveSetup, waveSurface, floodTimeline,
    hazard, hazardClass, compareRuns, stormUplift,
    parseAsciiGrid, downsample, cleanNodata, parseSimpleTiff,
    // exposed for tests
    _internal: { MinHeap, chamferDistance, mulberry32 },
  };
});
