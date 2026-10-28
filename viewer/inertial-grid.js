/* Grid adaptation only; the hydraulic calculations run in Rust/WASM. */
(function (root) {
  function prepare(a, maxSide = 192) {
    const factor = Math.max(1, Math.ceil(Math.max(a.W, a.H) / maxSide));
    const W = Math.floor(a.W / factor), H = Math.floor(a.H / factor);
    if (!W || !H) throw new Error('Terrain is too narrow for this resolution.');
    const dem = new Float32Array(W * H), valid = new Uint8Array(W * H), ocean = new Uint8Array(W * H);
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
      let z = 0, count = 0, sea = 0;
      for (let yy = 0; yy < factor; yy++) for (let xx = 0; xx < factor; xx++) {
        const i = (y * factor + yy) * a.W + x * factor + xx;
        if ((!a.valid || a.valid[i]) && Number.isFinite(a.dem[i])) { z += a.dem[i]; count++; }
        if (a.ocean?.[i]) sea++;
      }
      const j = y * W + x;
      // Mixed valid/nodata blocks are walls, never new flow shortcuts.
      valid[j] = count === factor * factor ? 1 : 0;
      dem[j] = count ? z / count : 0;
      ocean[j] = valid[j] && sea === factor * factor ? 1 : 0;
    }
    return { W, H, cell: a.cell * factor, dem, valid, ocean, factor };
  }
  function cell(g, a, i) {
    if (i < 0 || i >= a.W * a.H) return -1;
    const x = Math.floor((i % a.W) / g.factor), y = Math.floor(Math.floor(i / a.W) / g.factor);
    return x < g.W && y < g.H ? y * g.W + x : -1;
  }
  // `peak` shows the deepest water each cell held over the run (result.peak) instead of the final depth.
  function expand(a, g, result, { peak = false } = {}) {
    const depths = peak && result.peak ? result.peak : result.depth;
    const n = a.W * a.H, depth = new Float32Array(n), wet = new Uint8Array(n), level = new Float32Array(n);
    const vx = new Float64Array(n), vy = new Float64Array(n);
    const track = peak && result.peakClass && result.arrival;   // a storm run: the worst hazard class and the first time each cell flooded
    const cls = track ? new Uint8Array(n) : null, vel = track ? new Float32Array(n) : null, arrival = track ? new Float32Array(n).fill(NaN) : null;
    level.fill(NaN);
    for (let i = 0; i < n; i++) {
      const j = cell(g, a, i);
      if (j < 0 || !g.valid[j] || (a.valid && !a.valid[i])) continue;
      depth[i] = depths[j]; wet[i] = depth[i] >= 0.01 ? 1 : 0;
      level[i] = g.dem[j] + depths[j];
      if (result.vx) vx[i] = result.vx[j];
      if (result.vy) vy[i] = result.vy[j];
      if (track) { cls[i] = result.peakClass[j]; vel[i] = result.peakSpeed[j]; if (result.arrival[j] >= 0) arrival[i] = result.arrival[j]; }
    }
    let peakHazard = null;
    if (track) {
      const km2 = [0, 0, 0, 0, 0, 0], cellKm2 = (a.cell * a.cell) / 1e6;
      for (let i = 0; i < n; i++) if (cls[i] && !(a.ocean && a.ocean[i])) km2[cls[i] - 1] += cellKm2;
      peakHazard = { cls, vel, km2 };
    }
    return { depth, wet, level, wse: Float64Array.from(level), onPath: new Uint8Array(n), vx, vy, ...(track && { arrival, peakHazard }) };
  }
  const api = { prepare, cell, expand };
  if (typeof module === 'object') module.exports = api;
  if (root) root.FloodInertialGrid = api;
})(typeof self !== 'undefined' ? self : null);
