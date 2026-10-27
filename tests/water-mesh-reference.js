/* The 3D water mesh in plain JavaScript, as it was before it moved to Rust (rust/flood-core/src/mesh.rs,
 * FloodCore.waterMesh): the reference tests/terrain3d.test.js holds the Rust mesh to, byte for byte. Copied from
 * viewer/terrain3d.js as it stood then; the page does not use it. */
'use strict';
/* The 3D view's shades (the same colours as the 2D bands above): shallow
 * water is a translucent mid blue and depth builds opacity as well as
 * darkness (bands step at 0.5, 1, 2, 4 m). */
const BANDS3D = [
  [0.0, [0x3f, 0x9a, 0xe0]],
  [0.5, [0x2b, 0x7f, 0xd0]],
  [1.0, [0x1f, 0x67, 0xbb]],
  [2.0, [0x17, 0x50, 0x9c]],
  [4.0, [0x0c, 0x34, 0x70]],
];
function depthColor3d(d) {
  let col = BANDS3D[0][1];
  for (const [lo, c] of BANDS3D) if (d >= lo) col = c;
  return col;
}
const depthAlpha3d = (d) => Math.min(0.88, 0.3 + 0.32 * d);


/* Water surface vertices + depth colours for the wet cells of a run.
 * NaN surface (never wet) is excluded by the NaN check. Shallow water is
 * more transparent so the shoreline feathers out; deep water reads solid. */
function waterMesh(a, surface, depth, wet, skip, opts = {}) {
  return waterMeshAt(a, (i) => surface[i], (i) => depth[i], (i) => wet[i] === 1, skip, opts);
}

/* The same mesh from accessors: surface level, depth and wetness of a cell. The mesh only reads every
 * `skip`th cell, so a caller with an encoded frame need not decode the whole grid first. */
function waterMeshAt(a, surfaceAt, depthAt, wetAt, skip, opts = {}) {
  const lift = opts.lift || 0;
  const isWet = (i) => wetAt(i) && surfaceAt(i) === surfaceAt(i);
  if (!opts.soft) {
    return buildGrid(a, skip, isWet, (i) => surfaceAt(i) + lift, (i, out) => {
      const col = depthColor(depthAt(i));
      out[0] = col[0]; out[1] = col[1]; out[2] = col[2];
    }, { alphaFor: (i) => Math.min(1, 0.3 + depthAt(i) / 0.45), colX: opts.colX, rowZ: opts.rowZ });
  }
  // Soft shoreline (3D): the surface also gets a ring of vertices around the
  // wet cells, at the neighbours' water level and fully transparent. The
  // terrain hides the part of that plane that is below ground, so the
  // visible edge is where the water level meets the real ground (smooth),
  // and the per-vertex alpha feathers it, instead of a staircase of cells.
  const { W, H } = a;
  // Everything the mesh asks about is on the sampled grid (cells `skip` apart, and their neighbours
  // `skip` away), so what is worked out for a cell is kept by its slot in that grid, not in a Map.
  const cols = Math.floor((W - 1) / skip) + 1, rows = Math.floor((H - 1) / skip) + 1;
  const state = new Uint8Array(cols * rows);          // 0 not yet looked at, 1 no vertex, 2 vertex
  const levelOf = new Float64Array(cols * rows), alphaOf = new Float64Array(cols * rows), colourOf = new Array(cols * rows);
  const probe = (i) => {
    const x = i % W, y = (i / W) | 0, slot = (y / skip) * cols + x / skip;
    if (state[slot]) return state[slot] === 2 ? slot : -1;
    if (isWet(i)) {
      levelOf[slot] = surfaceAt(i); colourOf[slot] = depthColor3d(depthAt(i)); alphaOf[slot] = depthAlpha3d(depthAt(i));
      state[slot] = 2;
      return slot;
    }
    let n = 0, h = 0, col = null;
    for (let dy = -skip; dy <= skip; dy += skip) for (let dx = -skip; dx <= skip; dx += skip) {
      const nx = x + dx, ny = y + dy;
      if ((!dx && !dy) || nx < 0 || ny < 0 || nx >= W || ny >= H) continue;
      const j = ny * W + nx;
      if (isWet(j)) { n++; h += surfaceAt(j); if (!col) col = depthColor3d(depthAt(j)); }
    }
    if (!n) { state[slot] = 1; return -1; }
    levelOf[slot] = h / n; colourOf[slot] = col; alphaOf[slot] = 0;
    state[slot] = 2;
    return slot;
  };
  return buildGrid(a, skip, (i) => probe(i) >= 0, (i) => levelOf[probe(i)] + lift, (i, out) => {
    const col = colourOf[probe(i)];
    out[0] = col[0]; out[1] = col[1]; out[2] = col[2];
  }, { alphaFor: (i) => alphaOf[probe(i)], colX: opts.colX, rowZ: opts.rowZ });
}

/* Water grid builder: samples the analysis grid every `skip` cells, emits
 * quads where all four sampled corners pass `keep(i)`. Returns null when
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
      // local +z = south. With colX/rowZ (v4) the caller supplies scene
      // coordinates per column/row from the shared projection, so meshes
      // from different areas and the terrain tiles all agree on the ground
      const px = opts.colX ? opts.colX[x] : x * cell, pz = opts.rowZ ? opts.rowZ[y] : y * cell;
      positions.push(px, height(i), pz);
      // texture space: u across (west→east), v 0 at south edge, 1 at north
      uvs.push(px / wM, 1 - pz / hM);
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
  return {
    positions: new Float32Array(positions),
    colors: new Float32Array(colors),
    uvs: new Float32Array(uvs),
    indices: new Uint32Array(indices),
    cols, rows, skip, wM, hM,
  };
}

/* The 2D depth legend's band colours (viewer/index.html #depthLegend and
 * DEPTH_STOPS in app.js), keyed by the band's lower bound so colours match
 * the map exactly. Since the 2D polish these are the 3D view's colours too:
 * the old palest band read as white paint over imagery. */
const BANDS = [
  [0.0, [0x3f, 0x9a, 0xe0]],   // <0.5 m
  [0.5, [0x2b, 0x7f, 0xd0]],   // 0.5–1 m
  [1.0, [0x1f, 0x67, 0xbb]],   // 1–2 m
  [2.0, [0x17, 0x50, 0x9c]],   // 2–4 m
  [4.0, [0x0c, 0x34, 0x70]],   // >4 m
];
function depthColor(d) {
  let col = BANDS[0][1];
  for (const [lo, c] of BANDS) if (d >= lo) col = c;
  return col;
}

/* Per-step water surface from a u8 timeline frame: identical arithmetic to
 * showTimeStep's frame decode (depth = q/255*maxD, wse = dem + depth). */
function waterFromFrame(a, frame, maxD, skip, opts) {
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
  return { wse, depth, wet, mesh: waterMesh(a, wse, depth, wet, skip, opts) };
}

/* The mesh of waterFromFrame, without decoding the whole frame: the same cells and numbers (depth is the
 * Float32 value waterFromFrame stores), but only the ones the mesh samples. For a 1.8 M-cell area that
 * is 16-30 ms a frame less. */
function waterMeshFromFrame(a, frame, maxD, skip, opts) {
  const depthAt = (i) => Math.fround((frame[i] / 255) * maxD);
  return waterMeshAt(a, (i) => a.dem[i] + depthAt(i), depthAt, (i) => frame[i] > 0, skip, opts);
}


module.exports = { waterMesh, waterMeshAt, waterFromFrame, waterMeshFromFrame, depthColor };
