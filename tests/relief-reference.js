/* The shaded relief in plain JavaScript: the reference that tests/relief-wasm.test.js holds the Rust version
 * (rust/flood-core/src/render.rs terrain_rgba, FloodCore.terrainRGBA) to. The page does not use it. */
'use strict';

function lerpStops(stops, t) {
  for (let i = 1; i < stops.length; i++) {
    if (t <= stops[i][0]) {
      const [t0, c0] = stops[i - 1], [t1, c1] = stops[i];
      const f = (t - t0) / (t1 - t0);
      return [c0[0] + (c1[0] - c0[0]) * f, c0[1] + (c1[1] - c0[1]) * f, c0[2] + (c1[2] - c0[2]) * f];
    }
  }
  return stops[stops.length - 1][1];
}

function terrainRGBA(a, HYPSO) {
  const { W, H, dem, valid, cell } = a;
  const ocean = a.ocean || null;   // stream tiles have no ocean mask
  const land = [];
  for (let i = 0; i < a.N; i += 7) if (valid[i] && !(ocean && ocean[i])) land.push(dem[i]);
  land.sort((x, y) => x - y);
  const lo = land.length ? land[Math.floor(land.length * 0.02)] : 0;
  const hi = land.length ? land[Math.floor(land.length * 0.98)] : 1;
  const out = new Uint8ClampedArray(a.N * 4);
  const az = (315 * Math.PI) / 180, alt = (45 * Math.PI) / 180;
  const z = (x, y) => {
    x = Math.max(0, Math.min(W - 1, x)); y = Math.max(0, Math.min(H - 1, y));
    const i = y * W + x;
    return valid[i] ? dem[i] : NaN;
  };
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const i = y * W + x, o = i * 4;
    if (!valid[i]) { out[o + 3] = 0; continue; }
    const c = dem[i];
    if (c < -1) {   // sea: flat water colour, no hillshade (also what the
      out[o] = 0xc9; out[o + 1] = 0xe7; out[o + 2] = 0xf7;   // 2D relief
      out[o + 3] = 255;                                     // paints over)
      continue;
    }
    const zz = (xx, yy) => { const v = z(xx, yy); return Number.isNaN(v) ? c : v; };
    const gx = (zz(x + 1, y) - zz(x - 1, y)) / (2 * cell);
    const gy = (zz(x, y + 1) - zz(x, y - 1)) / (2 * cell);
    const slope = Math.atan(Math.hypot(gx, gy) * 1.6);
    const aspect = Math.atan2(gy, -gx);
    let hs = Math.cos(alt) * Math.cos(slope) + Math.sin(alt) * Math.sin(slope) * Math.cos(az - aspect - Math.PI / 2);
    hs = Math.max(0, Math.min(1, hs));
    const t = Math.max(0, Math.min(1, (c - lo) / (hi - lo || 1)));
    const col = lerpStops(HYPSO, t);
    const k = 0.55 + 0.5 * hs;
    out[o] = col[0] * k; out[o + 1] = col[1] * k; out[o + 2] = col[2] * k; out[o + 3] = 255;
  }
  return out;
}

module.exports = { terrainRGBA };
