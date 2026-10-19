/* Decimated mesh builders for the experimental 3D view (docs/3d-view-design.md).
 *
 * Pure data helpers, no three.js dependency, so node tests can exercise
 * them directly. Coordinates: x = east (metres), y = height (metres AHD,
 * scaled later by mesh.scale.y), z = north-negative so the up axis is +y.
 * Heights and water surfaces are NOT exaggerated here — the scene scales
 * the whole mesh on the y axis, which avoids rebuilding on every slider move.
 */

const MAX_SIDE = 560;   // ≤ 560×560 samples ≈ ≤ ~314k vertices per mesh

// Skip factor so the decimated grid stays within maxSide on both axes.
// Even, so the checkerboard alignment of the u8 frames is preserved.
function decimateStep(W, H, maxSide = MAX_SIDE) {
  const s = Math.max(1, Math.ceil(Math.max(W, H) / maxSide));
  return s % 2 ? s + 1 : s;
}

/* Terrain vertices + indices from the analysis grid.
 * Colors come straight from the relief render (`rgba` = state.terrain) so
 * the 3D view matches the 2D relief exactly. Cells that are invalid drop
 * out; a quad is emitted only when all four sampled corners survive, so
 * the coast and NoData edges stay clean. */
function terrainMesh(a, rgba, skip) {
  return buildGrid(a, skip, (i) => !!a.valid[i], (i) => a.dem[i], (i, out) => {
    const o = i * 4;
    out[0] = rgba ? rgba[o] : 255;
    out[1] = rgba ? rgba[o + 1] : 255;
    out[2] = rgba ? rgba[o + 2] : 255;
  }, { skirt: true });
}

/* Water surface vertices + depth colours for the wet cells of a run.
 * NaN surface (never wet) is excluded by the NaN check. Shallow water is
 * more transparent so the shoreline feathers out; deep water reads solid. */
function waterMesh(a, surface, depth, wet, skip) {
  return buildGrid(a, skip, (i) => wet[i] === 1 && surface[i] === surface[i], (i) => surface[i], (i, out) => {
    const col = depthColor(depth[i]);
    out[0] = col[0]; out[1] = col[1]; out[2] = col[2];
  }, { alphaFor: (i) => Math.min(1, 0.3 + depth[i] / 0.45) });
}

/* Shared grid builder: samples the analysis grid every `skip` cells, emits
 * quads where all four sampled corners pass `keep(i)`. Also emits UVs (0-1
 * across the model box, for imagery draping) and, for the terrain, a skirt
 * so boundary/NoData edges don't read as torn cliffs. Returns null when
 * nothing survives. */
function buildGrid(a, skip, keep, height, colorInto, opts = {}) {
  const { W, H, cell } = a;
  const cols = Math.floor((W - 1) / skip) + 1, rows = Math.floor((H - 1) / skip) + 1;
  // grid slot -> vertex index (-1 = no vertex here)
  const slot = new Int32Array(cols * rows).fill(-1);
  const positions = [], colors = [], uvs = [];
  const wM = (W - 1) * cell, hM = (H - 1) * cell;
  for (let gy = 0; gy < rows; gy++) {
    for (let gx = 0; gx < cols; gx++) {
      const x = gx * skip, y = gy * skip, i = y * W + x;
      if (!keep(i)) continue;
      slot[gy * cols + gx] = positions.length / 3;
      const px = x * cell, pz = -y * cell;
      positions.push(px, height(i), pz);
      // texture space: u across (west→east), v 0 at south edge, 1 at north
      uvs.push(px / wM, 1 + pz / hM);
      const c = [0, 0, 0];
      colorInto(i, c);
      const alpha = opts.alphaFor ? opts.alphaFor(i) : 1;
      colors.push(c[0] / 255, c[1] / 255, c[2] / 255, alpha);
    }
  }
  if (!positions.length) return null;
  const indices = [];
  for (let gy = 0; gy + 1 < rows; gy++) {
    for (let gx = 0; gx + 1 < cols; gx++) {
      const a0 = slot[gy * cols + gx], a1 = slot[gy * cols + gx + 1];
      const b0 = slot[(gy + 1) * cols + gx], b1 = slot[(gy + 1) * cols + gx + 1];
      if (a0 < 0 || a1 < 0 || b0 < 0 || b1 < 0) continue;
      indices.push(a0, b0, a1, a1, b0, b1);
    }
  }
  if (!indices.length) return null;
  // skirt: walls down from the outermost vertices so the model edge (and
  // NoData gaps along it) doesn't show as torn geometry. The drop is in
  // metres, scaled by the same vertical exaggeration as everything else.
  if (opts.skirt) {
    let minH = Infinity;
    for (let k = 1; k < positions.length; k += 3) if (positions[k] < minH) minH = positions[k];
    const base = minH - Math.max(20, wM * 0.02);
    const drop = (from, to) => {
      const f = from * 3, t = to * 3;
      const fi = positions.length / 3, ti = fi + 1;
      positions.push(positions[f], base, positions[f + 2], positions[t], base, positions[t + 2]);
      uvs.push(uvs[from * 2], uvs[from * 2 + 1], uvs[to * 2], uvs[to * 2 + 1]);
      const fc = from * 4, tc = to * 4;
      colors.push(colors[fc], colors[fc + 1], colors[fc + 2], 1, colors[tc], colors[tc + 1], colors[tc + 2], 1);
      indices.push(fi, ti, from, from, ti, to);
    };
    const exists = (gy, gx) => slot[gy * cols + gx];
    for (let gx = 0; gx + 1 < cols; gx++) {
      let v = exists(0, gx), w = exists(0, gx + 1);
      if (v >= 0 && w >= 0) drop(v, w);
      v = exists(rows - 1, gx); w = exists(rows - 1, gx + 1);
      if (v >= 0 && w >= 0) drop(w, v);   // flipped winding: outward face
    }
    for (let gy = 0; gy + 1 < rows; gy++) {
      let v = exists(gy, 0), w = exists(gy + 1, 0);
      if (v >= 0 && w >= 0) drop(w, v);
      v = exists(gy, cols - 1); w = exists(gy + 1, cols - 1);
      if (v >= 0 && w >= 0) drop(v, w);
    }
  }
  return {
    positions: new Float32Array(positions),
    colors: new Float32Array(colors),
    uvs: new Float32Array(uvs),
    indices: new Uint32Array(indices),
    cols, rows, skip, wM, hM,
  };
}

/* The 2D depth legend's band colours (viewer/index.html #depthLegend),
 * keyed by the band's lower bound so colours match the map exactly. */
const BANDS = [
  [0.0, [0xc9, 0xe7, 0xf7]],   // <0.5 m
  [0.5, [0x79, 0xbf, 0xe8]],   // 0.5–1 m
  [1.0, [0x37, 0x86, 0xc9]],   // 1–2 m
  [2.0, [0x1d, 0x5e, 0xa3]],   // 2–4 m
  [4.0, [0x0c, 0x34, 0x70]],   // >4 m
];
function depthColor(d) {
  let col = BANDS[0][1];
  for (const [lo, c] of BANDS) if (d >= lo) col = c;
  return col;
}

/* Per-step water surface from a u8 timeline frame: identical arithmetic to
 * showTimeStep's frame decode (depth = q/255*maxD, wse = dem + depth). */
function waterFromFrame(a, frame, maxD, skip) {
  const { N } = a;
  const wse = new Float64Array(N);
  const depth = new Float32Array(N);
  const wet = new Uint8Array(N);
  for (let i = 0; i < N; i++) {
    const q = frame[i];
    if (q > 0) {
      wet[i] = 1;
      depth[i] = (q / 255) * maxD;
      wse[i] = a.dem[i] + depth[i];
    }
  }
  return { wse, depth, wet, mesh: waterMesh(a, wse, depth, wet, skip) };
}

export { decimateStep, terrainMesh, waterMesh, waterFromFrame, depthColor, MAX_SIDE };
