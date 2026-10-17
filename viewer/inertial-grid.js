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
  function expand(a, g, result) {
    const n = a.W * a.H, depth = new Float32Array(n), wet = new Uint8Array(n), level = new Float32Array(n);
    const vx = new Float64Array(n), vy = new Float64Array(n);
    level.fill(NaN);
    for (let i = 0; i < n; i++) {
      const j = cell(g, a, i);
      if (j < 0 || !g.valid[j] || (a.valid && !a.valid[i])) continue;
      depth[i] = result.depth[j]; wet[i] = depth[i] >= 0.01 ? 1 : 0;
      level[i] = g.dem[j] + result.depth[j];
      if (result.vx) vx[i] = result.vx[j];
      if (result.vy) vy[i] = result.vy[j];
    }
    return { depth, wet, level, wse: Float64Array.from(level), onPath: new Uint8Array(n), vx, vy };
  }
  const api = { prepare, cell, expand };
  if (typeof module === 'object') module.exports = api;
  if (root) root.FloodInertialGrid = api;
})(typeof self !== 'undefined' ? self : null);
