/* The 5 m flood picture from LiDAR (see updateFine in app.js): for each
 * 5 m pixel, the model's water level from the wet model cells around it
 * (distance-weighted) against the LiDAR ground height. This is the plain JavaScript reference that the Rust
 * version (rust/flood-core/src/fine.rs, FloodCore.fineRaster, which the page uses) is held to; the page does not use it.
 *
 * p: {
 *   W, H            output size (pixels), rows north to south
 *   box             [w, s, e, n] of the output
 *   g               { west, east, north, south } of the model grid
 *   aW, aH          model grid size (cells)
 *   x0, y0, ww, wh  the window of model cells passed in (arrays are ww×wh)
 *   dem, valid, ocean, wet, depth, level, baseWet, baseDepth, hzCls, hzVel
 *                   model arrays for the window (level/baseDepth/hz* may be
 *                   null). level is the water level itself: on low ground the
 *                   model counts depth from the normal water surface, so
 *                   ground + depth there understates the level
 *   coarse          the model's own RGBA picture for the window
 *   lidar, nd       W×H heights (metres) and the no-data value
 *   depthStops      [[upper limit, [r, g, b]], ...], depthAlpha0 (shallowest band's alpha)
 *   water, channelAlpha, hazardColors, hazardLimits
 * }
 * Optional rowFrom, rowTo: work out only those rows (of H). The bands of a picture can then be
 * worked out apart and joined (fine-pool.js); with them, `lidar` holds only those rows and the
 * result holds only those rows.
 * Returns { rgba: Uint8ClampedArray(W*(rowTo-rowFrom)*4), have } — have = pixels with LiDAR.
 *
 * tests/fine-raster-wasm.test.js checks the two agree byte for byte.
 */
'use strict';
function fineRaster(p) {
  const { W, H, box, g, aW, aH, x0, y0, ww, lidar, nd } = p;
  const rowFrom = p.rowFrom || 0, rowTo = p.rowTo == null ? H : p.rowTo;
  if (!(rowFrom >= 0 && rowTo <= H && rowFrom <= rowTo) || lidar.length !== W * (rowTo - rowFrom)) throw new Error('fine raster: inconsistent rows');
  const out = new Uint8ClampedArray(W * (rowTo - rowFrom) * 4);
  const gw = g.east - g.west, gh = g.north - g.south;
  const hz = !!(p.hzCls && p.hzVel);
  const band = (dep) => { for (let k = 0; k < p.depthStops.length; k++) if (dep < p.depthStops[k][0]) return k; return p.depthStops.length - 1; };
  const hazardClass = (dep, v) => {
    for (let k = 0; k < p.hazardLimits.length; k++) { const [dl, vl, dvl] = p.hazardLimits[k]; if (dep <= dl && v <= vl && dep * v <= dvl) return k + 1; }
    return 6;
  };
  const isFlood = (k) => !p.ocean[k] && !(p.baseWet && p.baseWet[k]);
  const copy = (o, k) => { const c = k * 4; out[o] = p.coarse[c]; out[o + 1] = p.coarse[c + 1]; out[o + 2] = p.coarse[c + 2]; out[o + 3] = p.coarse[c + 3]; };
  let have = 0;
  for (let py = rowFrom; py < rowTo; py++) {
    const lat = box[3] - ((py + 0.5) / H) * (box[3] - box[1]);
    const fy = ((g.north - lat) / gh) * aH - 0.5;
    const cy = Math.min(aH - 1, Math.max(0, Math.round(fy)));
    for (let px = 0; px < W; px++) {
      const lon = box[0] + ((px + 0.5) / W) * (box[2] - box[0]);
      const fx = ((lon - g.west) / gw) * aW - 0.5;
      const cx = Math.min(aW - 1, Math.max(0, Math.round(fx)));
      const ci = (cy - y0) * ww + (cx - x0), o = ((py - rowFrom) * W + px) * 4, h = lidar[(py - rowFrom) * W + px];
      if (!(Number.isFinite(h) && h !== nd && h > -100 && h < 9000)) { copy(o, ci); continue; }   // no LiDAR: the model's own cell
      have++;
      if (p.ocean[ci]) { copy(o, ci); continue; }
      // water levels from the wet model cells around this spot: this
      // scenario's, and the baseline's (normal river), so the river's own
      // edge is drawn at 5 m too
      let ws = 0, wsum = 0, bs = 0, bsum = 0, nIn = 0, nBase = 0, vs = 0, vsum = 0;
      for (let dy = -1; dy <= 1; dy++) {
        const yy = cy + dy;
        if (yy < 0 || yy >= aH) continue;
        for (let dx = -1; dx <= 1; dx++) {
          const xx = cx + dx;
          if (xx < 0 || xx >= aW) continue;
          const k = (yy - y0) * ww + (xx - x0);
          nIn++;
          if (p.baseWet && p.baseWet[k]) nBase++;
          if (!p.valid[k] || p.ocean[k]) continue;
          const w = 1 / (0.25 + (xx - fx) ** 2 + (yy - fy) ** 2);
          if (p.wet[k]) {
            const lv = p.level && Number.isFinite(p.level[k]) ? p.level[k] : p.dem[k] + p.depth[k];
            ws += w * lv; wsum += w;
          }
          if (hz && p.hzCls[k]) { vs += w * p.hzVel[k]; vsum += w; }
          if (p.baseDepth && p.baseWet[k]) { bs += w * (p.dem[k] + p.baseDepth[k]); bsum += w; }
        }
      }
      const dep = wsum ? ws / wsum - h : 0, depBase = bsum ? bs / bsum - h : 0;
      // under the normal river level, or well inside the channel (every
      // model cell around is normal river: LiDAR there records the water
      // surface, which can sit above the model's baseline level)
      if (depBase > 0.02 || (nBase === nIn && nIn > 0)) {
        out[o] = p.water[0]; out[o + 1] = p.water[1]; out[o + 2] = p.water[2]; out[o + 3] = p.channelAlpha;
      } else if (dep > 0.02 && hz) {   // hazard: 5 m depth with the speed of the flooded cells around
        const col = p.hazardColors[hazardClass(dep, vsum ? vs / vsum : 0) - 1];
        out[o] = col[0]; out[o + 1] = col[1]; out[o + 2] = col[2]; out[o + 3] = 255;
      } else if (dep > 0.02) {
        const b = band(dep), col = p.depthStops[b][1];
        out[o] = col[0]; out[o + 1] = col[1]; out[o + 2] = col[2]; out[o + 3] = b === 0 ? p.depthAlpha0 : 255;
      } else if (!(p.wet[ci] && isFlood(ci))) {   // stream tint etc. as the model draws it
        copy(o, ci);
      }
    }
  }
  return { rgba: out, have };
}

module.exports = { fineRaster };
