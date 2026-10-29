/* A dam failure on one of the map's dam models: the reservoir behind the wall is given a bed and a volume, a breach is opened through the wall following
 * Froehlich's equations, and the nonlinear shallow-water solver (the lab's Rust/WebAssembly inundation model, with wetting and drying) carries the water
 * downstream. Everything here is pure: `plan` turns the area model into the solver's inputs, `runOnArea` turns the solver's extremes back into a flood run the
 * impact tools can use. The solver and the worker are elsewhere (dam-worker.js).
 *
 * What it assumes, in plain terms: the elevation model shows the reservoir as a flat surface with no bed, so the reservoir is given one level depth that holds the
 * dam's volume (capped by the wall's height); the wall is the ground between the reservoir's edge and the first cell 4 m or more below it; the breach is a straight
 * cut through that wall, as wide as Froehlich's mean breach width and opening over his failure time. The first-order scheme under-predicts run-up and smears fronts. */

const G = 9.81;
export const BREACH_START = 60;       // s after the run starts, so the reservoir settles first
export const MAX_SIDE = 256;          // cells per side of the solver window
export const LAKE_TOLERANCE = 0.3;    // m: cells within this of the lake level, joined to the gauge, are the reservoir

/* Froehlich's breach equations (1995): mean breach width, time to fail and peak outflow from the reservoir volume V (m3) and the depth of water above the
 * breach bottom h (m). K is 1.4 for overtopping and 1.0 for piping. The widths and times are what the model uses; the peak is only compared with the solver's. */
export const BREACH_MODES = {
  overtopping: { label: 'Overtopping: wider breach', k: 1.4 },
  piping: { label: 'Piping: narrower breach', k: 1.0 },
};
export function froehlich({ volume, depth, mode = 'overtopping' }) {
  const k = (BREACH_MODES[mode] || BREACH_MODES.overtopping).k;
  return {
    width: 0.1803 * k * volume ** 0.32 * depth ** 0.19,          // m
    seconds: 0.00254 * volume ** 0.53 * depth ** -0.9 * 3600,   // s
    peak: 0.607 * volume ** 0.295 * depth ** 1.24,              // m3/s
  };
}

// The reservoir: cells joined to the gauge whose ground is no higher than the lake level plus a tolerance, by flood fill on valid cells.
export function reservoirCells(a, gauge, level, tolerance = LAKE_TOLERANCE, limit = 400000) {
  const mask = new Uint8Array(a.W * a.H), stack = [gauge];
  let count = 0;
  mask[gauge] = 1;
  while (stack.length && count < limit) {
    const i = stack.pop(); count++;
    const x = i % a.W, y = (i - x) / a.W;
    for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const nx = x + dx, ny = y + dy;
      if (nx < 0 || ny < 0 || nx >= a.W || ny >= a.H) continue;
      const j = ny * a.W + nx;
      if (mask[j] || (a.valid && !a.valid[j]) || !(a.dem[j] <= level + tolerance)) continue;
      mask[j] = 1; stack.push(j);
    }
  }
  return { mask, count };
}

/* Everything the solver needs for a failure of the dam of `a`. `dam` is { crest, below, lake } and `route` the cells from the gauge to `below` along the
 * flow path (the wall is the part of it outside the reservoir). `volume` is the stored water in m3 (the model may hold less, if the wall cannot be that high);
 * `mode` is a key of BREACH_MODES; `timeScale` multiplies Froehlich's failure time (1 is his estimate); `downstream` the cells of the flow path on from `below`, used to fit the window around the flood's way out. */
export function planDamBreak(a, { gauge, dam, route, downstream = [], volume, mode = 'overtopping', seconds = 3600, timeScale = 1 }) {
  const cell = a.cell, lake = dam.lake;
  const { mask: lakeMask, count } = reservoirCells(a, gauge, lake);
  if (count < 4) throw new Error('the reservoir is too small to show in this terrain model');
  const wallHeight = Math.max(dam.lake - a.dem[dam.below], 1);
  const average = volume / (count * cell * cell);
  const depth = Math.min(Math.max(average, 1), wallHeight);
  const bedLake = lake - depth;

  // the window: the reservoir and the way out, as few coarse cells as fit
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  const include = (i) => { const x = i % a.W, y = (i - x) / a.W; x0 = Math.min(x0, x); x1 = Math.max(x1, x); y0 = Math.min(y0, y); y1 = Math.max(y1, y); };
  for (let i = 0; i < lakeMask.length; i++) if (lakeMask[i]) include(i);
  include(dam.below);
  const reach = Math.round(6000 / cell);
  for (let k = 0; k < Math.min(reach, downstream.length); k++) include(downstream[k]);
  const pad = Math.round(500 / cell);
  x0 = Math.max(0, x0 - pad); y0 = Math.max(0, y0 - pad); x1 = Math.min(a.W - 1, x1 + pad); y1 = Math.min(a.H - 1, y1 + pad);
  const factor = Math.max(1, Math.ceil(Math.max(x1 - x0 + 1, y1 - y0 + 1) / MAX_SIDE));
  // at least 64 coarse cells a side, centred, so there is room for the water to spread
  const side = (lo, hi, max) => {
    const want = Math.max(Math.ceil((hi - lo + 1) / factor), Math.min(64, Math.floor(max / factor))) * factor;
    const start = Math.max(0, Math.min(lo - Math.floor((want - (hi - lo + 1)) / 2), max - want));
    return [start, Math.min(want, max - start)];
  };
  const [sx, wx] = side(x0, x1, a.W), [sy, wy] = side(y0, y1, a.H);
  const W = Math.floor(wx / factor), H = Math.floor(wy / factor);
  if (W < 4 || H < 4) throw new Error('the terrain around the dam is too small for the dam-break model');

  const n = W * H, bed = new Float64Array(n), reference = new Float64Array(n), valid = new Uint8Array(n), lakeCoarse = new Uint8Array(n), highest = new Float64Array(n);
  const fine = (x, y) => (sy + y) * a.W + sx + x;
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    let z = 0, ok = 0, lakeN = 0, top = -Infinity;
    for (let yy = 0; yy < factor; yy++) for (let xx = 0; xx < factor; xx++) {
      const i = fine(x * factor + xx, y * factor + yy);
      if ((a.valid && !a.valid[i]) || !Number.isFinite(a.dem[i])) continue;
      ok++; top = Math.max(top, a.dem[i]);
      if (lakeMask[i]) { z += Math.min(a.dem[i], bedLake); lakeN++; } else z += a.dem[i];
    }
    const j = y * W + x;
    if (ok < factor * factor) continue;   // a block with missing ground is a wall
    // a block that holds any of the reservoir is filled to the lake's level, so its surface matches its neighbours' and the water is at rest
    valid[j] = 1; bed[j] = z / ok; reference[j] = lakeN ? Math.max(0, lake - bed[j]) : 0; lakeCoarse[j] = lakeN * 2 >= ok ? 1 : 0; highest[j] = top;
  }
  // Averaging a coarse block lowers a thin wall towards the ground beside it and lets the reservoir leak. Where the grid is coarser than the terrain, the blocks
  // touching the reservoir keep their highest ground, so the reservoir stays contained until the breach cuts it.
  if (factor > 1) {
    const ring = [];
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
      const j = y * W + x;
      if (!valid[j] || lakeCoarse[j]) continue;
      let next = false;
      for (let dy = -1; dy <= 1 && !next; dy++) for (let dx = -1; dx <= 1; dx++) { const xx = x + dx, yy = y + dy; if (xx >= 0 && yy >= 0 && xx < W && yy < H && lakeCoarse[yy * W + xx]) { next = true; break; } }
      if (next) ring.push(j);
    }
    for (const j of ring) { bed[j] = Math.max(bed[j], highest[j]); reference[j] = Math.max(0, lake - bed[j]); }
  }
  const coarse = (i) => { const x = Math.floor(((i % a.W) - sx) / factor), y = Math.floor((Math.floor(i / a.W) - sy) / factor); return x >= 0 && y >= 0 && x < W && y < H ? y * W + x : -1; };

  // the breach: the wall's cells on the route (outside the reservoir) and the cell below, widened across the flow to Froehlich's mean width
  const f = froehlich({ volume, depth, mode });
  const wall = route.filter((i) => !lakeMask[i]);
  // a wall is thinner than a coarse cell: keep the block that holds its crest as high as the crest (never averaged down towards the ground below it, which would
  // let the reservoir leak) and out of the reservoir, so the breach cuts through it
  for (const i of wall) {
    const c = coarse(i);
    if (c < 0 || !valid[c] || !(a.dem[i] > lake)) continue;
    bed[c] = Math.max(bed[c], a.dem[i]); reference[c] = 0; lakeCoarse[c] = 0;
  }
  if (!wall.includes(dam.below)) wall.push(dam.below);
  const [fx, fy] = [wall[0] % a.W, Math.floor(wall[0] / a.W)], [tx, ty] = [dam.below % a.W, Math.floor(dam.below / a.W)];
  let dx = tx - fx, dy = ty - fy;
  const len = Math.hypot(dx, dy) || 1; dx /= len; dy /= len;
  const half = Math.max(0, Math.round(f.width / cell / 2));
  const invert = Math.max(bedLake, a.dem[dam.below]);
  const chosen = new Map(), section = new Set();
  for (const i of wall) {
    const x = i % a.W, y = Math.floor(i / a.W), across = [];
    for (let k = -half; k <= half; k++) {
      const nx = x + Math.round(-dy * k), ny = y + Math.round(dx * k);
      if (nx < 0 || ny < 0 || nx >= a.W || ny >= a.H) continue;
      const fi = ny * a.W + nx, c = coarse(fi);
      if (c < 0 || !valid[c] || lakeCoarse[c]) continue;
      chosen.set(c, Math.min(chosen.has(c) ? chosen.get(c) : Infinity, Math.min(a.dem[fi], invert)));
      across.push(c);
    }
    // the first cut that lands on the solver's grid, across the flow, is where the discharge is measured
    if (!section.size) across.forEach((c) => section.add(c));
  }
  const breachCells = [...chosen.keys()];
  // the cut starts level with the reservoir's surface (the water is at rest against it) and is lowered to its final level over Froehlich's failure time
  for (const c of breachCells) { bed[c] = lake; reference[c] = 0; }
  const breachTo = breachCells.map((c) => Math.min(chosen.get(c), bed[c]));

  let stored = 0;
  for (let i = 0; i < n; i++) stored += reference[i];
  stored *= (cell * factor) ** 2;
  return {
    W, H, cell: cell * factor, factor, x0: sx, y0: sy, bed, reference, valid, lake: lakeCoarse, seconds,
    breachCells, section: [...section], breachTo, breachStart: BREACH_START, breachSeconds: f.seconds * timeScale,
    depth, wallHeight, volume: stored, requested: volume, froehlich: f, mode, reservoirCells: count,
  };
}

/* The solver's own start message for a plan. */
export function solverGrid(plan) {
  return {
    method: 2, order: 1, W: plan.W, H: plan.H, cell: plan.cell, absorbing: 0, roughness: 0.035,
    bed: plan.bed, depth: plan.reference, eta: new Float64Array(plan.W * plan.H), valid: plan.valid,
    breachCells: Float64Array.from(plan.breachCells), breachTo: Float64Array.from(plan.breachTo), breachStart: plan.breachStart, breachSeconds: plan.breachSeconds,
    arrivalDepth: 0.1,
  };
}

/* The run's extremes on the area model's cells, in the shape the impact tools take (as the 2D solver's expanded run): the deepest water on ground the reservoir
 * did not hold, its worst hazard class and speed, and the time (s after the breach began to open) it first stood 10 cm up. The reservoir itself is left dry.
 * `edge` is true when water reached the edge of the solver's window, so the flood may go further than shown. */
export function runOnArea(a, plan, extremes) {
  const n = a.W * a.H, { factor, W, H, x0, y0 } = plan;
  const depth = new Float32Array(n), wet = new Uint8Array(n), level = new Float32Array(n).fill(NaN), arrival = new Float32Array(n).fill(NaN);
  const cls = new Uint8Array(n), vel = new Float32Array(n);
  let covered = 0;
  for (let y = 0; y < H * factor; y++) for (let x = 0; x < W * factor; x++) {
    const i = (y0 + y) * a.W + x0 + x;
    const c = Math.floor(y / factor) * W + Math.floor(x / factor);
    if (!plan.valid[c] || plan.lake[c] || (a.ocean && a.ocean[i])) continue;
    covered++;
    const d = extremes.peakDepth[c];
    if (!(d >= 0.01)) continue;
    depth[i] = d; wet[i] = 1; level[i] = a.dem[i] + d;
    cls[i] = Math.max(1, extremes.peakClass[c]); vel[i] = extremes.peakSpeed[c];
    if (extremes.arrival[c] >= 0) arrival[i] = Math.max(0, extremes.arrival[c] - plan.breachStart);
  }
  const km2 = [0, 0, 0, 0, 0, 0], cellKm2 = (a.cell * a.cell) / 1e6;
  for (let i = 0; i < n; i++) if (cls[i]) km2[cls[i] - 1] += cellKm2;
  let edge = false;
  for (let k = 0; k < W && !edge; k++) edge = extremes.peakDepth[k] >= 0.1 && !plan.lake[k] || extremes.peakDepth[(H - 1) * W + k] >= 0.1 && !plan.lake[(H - 1) * W + k];
  for (let k = 0; k < H && !edge; k++) edge = (extremes.peakDepth[k * W] >= 0.1 && !plan.lake[k * W]) || (extremes.peakDepth[k * W + W - 1] >= 0.1 && !plan.lake[k * W + W - 1]);
  return {
    depth, wet, level, wse: Float64Array.from(level), onPath: new Uint8Array(n), vx: new Float64Array(n), vy: new Float64Array(n), arrival,
    peakHazard: { cls, vel, km2 }, covered, edge, dam: true,
  };
}

export const damText = (plan) => `${(plan.volume / 1e6).toFixed(plan.volume < 1e7 ? 2 : 1)} million m³ held at ${plan.depth.toFixed(1)} m deep behind a ${Math.round(plan.wallHeight)} m wall; breach ${Math.round(plan.froehlich.width)} m wide, opening over ${Math.round(plan.breachSeconds / 60)} min`;
export { G };
