/* Mesh and projection helpers for the experimental 3D view
 * (docs/3d-view-design.md, docs/3d-view-v4-plan.md).
 *
 * Pure data helpers, no three.js dependency, so node tests can exercise
 * them directly. Scene coordinates: x = east, z = SOUTH (metres, local web
 * mercator, see makeProjection), y = height in metres AHD. Heights and
 * water surfaces are NOT exaggerated here — the scene scales its world
 * group on y, which avoids rebuilding on every slider move.
 */

const MAX_SIDE = 560;   // ≤ 560×560 samples ≈ ≤ ~314k vertices per mesh

// Skip factor so the decimated grid stays within maxSide on both axes.
// Even, so the checkerboard alignment of the u8 frames is preserved.
function decimateStep(W, H, maxSide = MAX_SIDE) {
  const s = Math.max(1, Math.ceil(Math.max(W, H) / maxSide));
  return s % 2 ? s + 1 : s;
}

/* Water surface vertices + depth colours for the wet cells of a run.
 * NaN surface (never wet) is excluded by the NaN check. Shallow water is
 * more transparent so the shoreline feathers out; deep water reads solid. */
function waterMesh(a, surface, depth, wet, skip, opts = {}) {
  const lift = opts.lift || 0;
  const isWet = (i) => wet[i] === 1 && surface[i] === surface[i];
  if (!opts.soft) {
    return buildGrid(a, skip, isWet, (i) => surface[i] + lift, (i, out) => {
      const col = depthColor(depth[i]);
      out[0] = col[0]; out[1] = col[1]; out[2] = col[2];
    }, { alphaFor: (i) => Math.min(1, 0.3 + depth[i] / 0.45), colX: opts.colX, rowZ: opts.rowZ });
  }
  // Soft shoreline (3D): the surface also gets a ring of vertices around the
  // wet cells, at the neighbours' water level and fully transparent. The
  // terrain hides the part of that plane that is below ground, so the
  // visible edge is where the water level meets the real ground (smooth),
  // and the per-vertex alpha feathers it, instead of a staircase of cells.
  const { W, H } = a, info = new Map();
  const probe = (i) => {
    let v = info.get(i);
    if (v !== undefined) return v;
    v = null;
    if (isWet(i)) {
      v = { h: surface[i], col: depthColor3d(depth[i]), alpha: depthAlpha3d(depth[i]) };
    } else {
      const x = i % W, y = (i / W) | 0;
      let n = 0, h = 0, col = null;
      for (let dy = -skip; dy <= skip; dy += skip) for (let dx = -skip; dx <= skip; dx += skip) {
        const nx = x + dx, ny = y + dy;
        if ((!dx && !dy) || nx < 0 || ny < 0 || nx >= W || ny >= H) continue;
        const j = ny * W + nx;
        if (isWet(j)) { n++; h += surface[j]; if (!col) col = depthColor3d(depth[j]); }
      }
      if (n) v = { h: h / n, col, alpha: 0 };
    }
    info.set(i, v);
    return v;
  };
  return buildGrid(a, skip, (i) => probe(i) !== null, (i) => probe(i).h + lift, (i, out) => {
    const col = probe(i).col;
    out[0] = col[0]; out[1] = col[1]; out[2] = col[2];
  }, { alphaFor: (i) => probe(i).alpha, colX: opts.colX, rowZ: opts.rowZ });
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

export { BANDS3D, depthColor3d, depthAlpha3d, decimateStep, waterMesh, waterFromFrame, depthColor, MAX_SIDE };

/* ---------- v4: one projection, terrain tiles, quadtree LOD ---------- */

const R_EARTH = 6378137;
const MERC_MAX = Math.PI * R_EARTH;   // half the width of the web-mercator world

export function lonLatToMerc(lon, lat) {
  const la = Math.max(-85.0511, Math.min(85.0511, lat));
  return [(R_EARTH * lon * Math.PI) / 180, R_EARTH * Math.log(Math.tan(Math.PI / 4 + (la * Math.PI) / 360))];
}
export function mercToLonLat(mx, my) {
  return [(mx / R_EARTH) * (180 / Math.PI), (2 * Math.atan(Math.exp(my / R_EARTH)) - Math.PI / 2) * (180 / Math.PI)];
}

/* Scene coordinates are local web mercator: metres from the origin scaled
 * by k = cos(origin lat), so distances are true at the origin (and under 2 %
 * out within ~200 km). +x east, +z SOUTH, +y up. Every mesh (terrain tile,
 * water surface) goes through this one mapping, so shared edges coincide. */
export function makeProjection(lon0, lat0) {
  const [mx0, my0] = lonLatToMerc(lon0, lat0);
  const k = Math.cos((lat0 * Math.PI) / 180);
  return {
    lon0, lat0, k, mx0, my0,
    toScene(lon, lat) { const [mx, my] = lonLatToMerc(lon, lat); return [(mx - mx0) * k, -(my - my0) * k]; },
    xOfLon(lon) { return (((R_EARTH * lon * Math.PI) / 180) - mx0) * k; },
    zOfLat(lat) { return -(lonLatToMerc(0, lat)[1] - my0) * k; },
    fromScene(x, z) { return mercToLonLat(x / k + mx0, -z / k + my0); },
  };
}

export const tileKey = (z, x, y) => `${z}/${x}/${y}`;
export const parseKey = (key) => key.split('/').map(Number);
export function parentKey(key) {
  const [z, x, y] = parseKey(key);
  return z > 0 ? tileKey(z - 1, x >> 1, y >> 1) : null;
}

/* A tile's corners in scene metres: { x0 (west), z0 (north), x1, z1, size }.
 * Computed from the integer tile grid alone, so neighbours produce
 * bit-identical shared edges. */
export function tileToScene(proj, z, x, y) {
  const n = 2 ** z, span = (2 * MERC_MAX) / n;
  // each edge is a function of its integer index alone, so the east edge
  // of tile x and the west edge of tile x+1 are the same float
  const ex = (i) => (-MERC_MAX + i * span - proj.mx0) * proj.k, ez = (j) => -(MERC_MAX - j * span - proj.my0) * proj.k;
  return { x0: ex(x), z0: ez(y), x1: ex(x + 1), z1: ez(y + 1), size: span * proj.k };
}

/* The [x, y] of the zoom-z tile containing a scene point. */
export function tileAt(proj, z, sx, sz) {
  const n = 2 ** z, span = (2 * MERC_MAX) / n;
  const mx = sx / proj.k + proj.mx0, my = -sz / proj.k + proj.my0;
  const cl = (v) => Math.max(0, Math.min(n - 1, v));
  return [cl(Math.floor((mx + MERC_MAX) / span)), cl(Math.floor((MERC_MAX - my) / span))];
}

/* Tile edge length in scene metres at zoom z. */
export const tileSize = (proj, z) => (2 * MERC_MAX * proj.k) / 2 ** z;

/* AWS Terrain Tiles "terrarium" encoding: metres = R*256 + G + B/256 - 32768.
 * Negative values (sea-floor bathymetry) are clamped to the same -1.5 m "sea"
 * level the DEM-H path uses, so the sea is flat and the terrain colours and
 * the 2D relief agree. */
export const SEA_LEVEL = -1.5;
export const terrariumHeight = (r, g, b) => r * 256 + g + b / 256 - 32768;
export function decodeTerrarium(rgba, n = 256) {
  const out = new Float32Array(n * n);
  for (let i = 0; i < n * n; i++) {
    const h = terrariumHeight(rgba[i * 4], rgba[i * 4 + 1], rgba[i * 4 + 2]);
    out[i] = h < SEA_LEVEL ? SEA_LEVEL : h;
  }
  return out;
}

/* Bilinear height from an n×n raster covering a tile edge to edge (pixel
 * centres at (i+0.5)/n), at tile coordinates u, v in [0, 1] (v from the
 * north edge). */
export function sampleRaster(data, n, u, v) {
  const fx = Math.max(0, Math.min(n - 1, u * n - 0.5)), fy = Math.max(0, Math.min(n - 1, v * n - 0.5));
  const x0 = Math.floor(fx), y0 = Math.floor(fy), x1 = Math.min(n - 1, x0 + 1), y1 = Math.min(n - 1, y0 + 1);
  const tx = fx - x0, ty = fy - y0;
  const a = data[y0 * n + x0], b = data[y0 * n + x1], c = data[y1 * n + x0], d = data[y1 * n + x1];
  return (a * (1 - tx) + b * tx) * (1 - ty) + (c * (1 - tx) + d * tx) * ty;
}

/* Elevation → sRGB for the no-imagery "relief" look (and while imagery
 * loads). Sea, green lowlands, tan, brown, then snow-ish. */
const RELIEF = [[-1.5, [0x6f, 0xa8, 0xc8]], [0, [0x9c, 0xc4, 0xa0]], [40, [0x86, 0xb0, 0x76]], [200, [0xb4, 0xb4, 0x7c]], [600, [0xa8, 0x8a, 0x62]], [1400, [0x94, 0x7a, 0x66]], [2200, [0xe6, 0xe6, 0xe6]]];
export function reliefColor(h, out, o = 0) {
  let k = 0;
  while (k < RELIEF.length - 2 && h > RELIEF[k + 1][0]) k++;
  const [h0, c0] = RELIEF[k], [h1, c1] = RELIEF[k + 1];
  const t = Math.max(0, Math.min(1, (h - h0) / (h1 - h0)));
  for (let c = 0; c < 3; c++) out[o + c] = (c0[c] + (c1[c] - c0[c]) * t) / 255;
  return out;
}

export const TILE_SEGS = 32;

/* Vertex heights for a tile: (segs+1)² samples, row-major from the NW
 * corner, via heightAt(u, v) with u, v in [0, 1] across the tile. */
export function tileHeights(heightAt, segs = TILE_SEGS) {
  const m = segs + 1, out = new Float32Array(m * m);
  for (let j = 0; j < m; j++) for (let i = 0; i < m; i++) out[j * m + i] = heightAt(i / segs, j / segs);
  return out;
}

/* Mesh for one terrain tile, positions relative to the tile's NW corner
 * (the scene places the mesh at [x0, 0, z0], keeping float32 precise), with
 * heights unexaggerated (the world group scales y). Normals come from the
 * height grid (one-sided at the border); skirts hang below each edge and
 * copy that edge vertex's normal, UV and colour so they shade like the
 * surface instead of showing as dark seams. */
export function tileMesh(proj, z, x, y, heights, segs = TILE_SEGS, opts = {}) {
  const m = segs + 1, t = tileToScene(proj, z, x, y);
  const dx = (t.x1 - t.x0) / segs, dz = (t.z1 - t.z0) / segs;
  const nVert = m * m, nSkirt = 4 * m, total = nVert + nSkirt;
  const positions = new Float32Array(total * 3), normals = new Float32Array(total * 3);
  const uvs = new Float32Array(total * 2), colors = new Float32Array(total * 3);
  let hmin = Infinity, hmax = -Infinity;
  for (let j = 0; j < m; j++) for (let i = 0; i < m; i++) {
    const v = j * m + i, h = heights[v];
    if (h < hmin) hmin = h;
    if (h > hmax) hmax = h;
    positions[v * 3] = i * dx; positions[v * 3 + 1] = h; positions[v * 3 + 2] = j * dz;
    uvs[v * 2] = i / segs; uvs[v * 2 + 1] = 1 - j / segs;
    const hl = heights[j * m + Math.max(0, i - 1)], hr = heights[j * m + Math.min(m - 1, i + 1)];
    const hu = heights[Math.max(0, j - 1) * m + i], hd = heights[Math.min(m - 1, j + 1) * m + i];
    const gx = (hr - hl) / ((Math.min(m - 1, i + 1) - Math.max(0, i - 1)) * dx);
    const gz = (hd - hu) / ((Math.min(m - 1, j + 1) - Math.max(0, j - 1)) * dz);
    const len = Math.hypot(gx, 1, gz);
    normals[v * 3] = -gx / len; normals[v * 3 + 1] = 1 / len; normals[v * 3 + 2] = -gz / len;
    reliefColor(h, colors, v * 3);
  }
  const indices = new Uint32Array(segs * segs * 6 + 4 * segs * 6);
  let n = 0;
  for (let j = 0; j < segs; j++) for (let i = 0; i < segs; i++) {
    const a0 = j * m + i, a1 = a0 + 1, b0 = a0 + m, b1 = b0 + 1;
    indices[n++] = a0; indices[n++] = b0; indices[n++] = a1; indices[n++] = a1; indices[n++] = b0; indices[n++] = b1;
  }
  // skirts: one strip per edge, dropping max(5 m, tile size / 50) below the lowest height there
  const drop = opts.skirtM != null ? opts.skirtM : Math.max(5, t.size / 50);
  const edges = [
    (k) => k,                     // north row
    (k) => (m - 1) * m + k,       // south row
    (k) => k * m,                 // west column
    (k) => k * m + (m - 1),       // east column
  ];
  edges.forEach((at, e) => {
    for (let k = 0; k < m; k++) {
      const src = at(k), dst = nVert + e * m + k;
      positions[dst * 3] = positions[src * 3]; positions[dst * 3 + 1] = hmin - drop; positions[dst * 3 + 2] = positions[src * 3 + 2];
      normals[dst * 3] = normals[src * 3]; normals[dst * 3 + 1] = normals[src * 3 + 1]; normals[dst * 3 + 2] = normals[src * 3 + 2];
      uvs[dst * 2] = uvs[src * 2]; uvs[dst * 2 + 1] = uvs[src * 2 + 1];
      colors[dst * 3] = colors[src * 3]; colors[dst * 3 + 1] = colors[src * 3 + 1]; colors[dst * 3 + 2] = colors[src * 3 + 2];
      if (k < segs) {
        const s0 = src, s1 = at(k + 1), d0 = dst, d1 = dst + 1;
        indices[n++] = s0; indices[n++] = d0; indices[n++] = s1; indices[n++] = s1; indices[n++] = d0; indices[n++] = d1;
      }
    }
  });
  return { positions, normals, uvs, colors, indices, origin: [t.x0, t.z0], size: t.size, hmin, hmax, segs };
}

/* Height of a tile's mesh surface at scene point (sx, sz), bilinear on its
 * vertex grid; null when the point is outside the tile. */
export function tileGroundAt(proj, z, x, y, heights, sx, sz, segs = TILE_SEGS) {
  const t = tileToScene(proj, z, x, y);
  const u = (sx - t.x0) / (t.x1 - t.x0), v = (sz - t.z0) / (t.z1 - t.z0);
  if (u < 0 || u > 1 || v < 0 || v > 1) return null;
  const m = segs + 1, fx = u * segs, fy = v * segs;
  const i0 = Math.min(segs - 1, Math.floor(fx)), j0 = Math.min(segs - 1, Math.floor(fy));
  const tx = fx - i0, ty = fy - j0;
  const h = (i, j) => heights[j * m + i];
  return (h(i0, j0) * (1 - tx) + h(i0 + 1, j0) * tx) * (1 - ty) + (h(i0, j0 + 1) * (1 - tx) + h(i0 + 1, j0 + 1) * tx) * ty;
}

/* ---- quadtree selection ---- */

/* Tiles to draw for a camera: start from the zoom-minZ tiles within
 * maxDist of the camera and split any whose on-screen size exceeds
 * thresholdPx, nearest-point distance measured to the tile's box (so tall
 * terrain under the camera counts). view = { cam:[x,y,z], focalPx,
 * frustum: [[nx,ny,nz,d],...]|null (inside is n·p+d >= 0), proj, exag,
 * minZ, maxZ, maxDist, thresholdPx, cap, heightRange(key)->[lo, hi] }.
 * Returns keys; if the result would exceed `cap`, the threshold is raised
 * until it fits. */
export function selectTiles(view) {
  const { cam, proj, minZ = 6, maxZ = 14, maxDist = 300000, cap = 400 } = view;
  const exag = view.exag || 1, range = view.heightRange || (() => [-5, 1500]);
  let threshold = view.thresholdPx || 384;
  const boxOf = (z, x, y) => {
    const t = tileToScene(proj, z, x, y), r = range(tileKey(z, x, y));
    return [t.x0, r[0] * exag, t.z0, t.x1, r[1] * exag, t.z1, t.size];
  };
  const dist = (b) => {
    const dx = Math.max(b[0] - cam[0], 0, cam[0] - b[3]), dy = Math.max(b[1] - cam[1], 0, cam[1] - b[4]), dz = Math.max(b[2] - cam[2], 0, cam[2] - b[5]);
    return Math.hypot(dx, dy, dz);
  };
  const visible = (b) => {
    if (!view.frustum) return true;
    for (const [nx, ny, nz, d] of view.frustum) {
      const px = nx >= 0 ? b[3] : b[0], py = ny >= 0 ? b[4] : b[1], pz = nz >= 0 ? b[5] : b[2];
      if (nx * px + ny * py + nz * pz + d < 0) return false;
    }
    return true;
  };
  // root tiles: the zoom-minZ square covering the horizon circle
  const [rx0, ry0] = tileAt(proj, minZ, cam[0] - maxDist, cam[2] - maxDist);
  const [rx1, ry1] = tileAt(proj, minZ, cam[0] + maxDist, cam[2] + maxDist);
  const run = () => {
    const out = [], stack = [];
    for (let y = ry0; y <= ry1; y++) for (let x = rx0; x <= rx1; x++) stack.push([minZ, x, y]);
    while (stack.length) {
      const [z, x, y] = stack.pop();
      const b = boxOf(z, x, y), d = dist(b);
      if (d > maxDist || !visible(b)) continue;
      const px = (b[6] / Math.max(d, 1)) * view.focalPx;
      if (z < maxZ && px > threshold) {
        for (let c = 0; c < 4; c++) stack.push([z + 1, x * 2 + (c & 1), y * 2 + (c >> 1)]);
      } else out.push(tileKey(z, x, y));
    }
    return out;
  };
  let out = run();
  for (let tries = 0; out.length > cap && tries < 24; tries++) { threshold *= 1.4; out = run(); }
  return out;
}

/* What to actually draw for a wanted set: each wanted tile if built, else its
 * nearest built ancestor (so nothing blanks while detail loads), else any
 * built descendants (zooming out). A tile under another drawn tile is
 * dropped so surfaces never overlap. */
export function resolveDraw(wanted, isReady, maxDepth = 3) {
  const out = new Set();
  const below = (key, depth) => {
    if (isReady(key)) return [key];
    if (depth === 0) return [];
    const [z, x, y] = parseKey(key);
    let r = [];
    for (let c = 0; c < 4; c++) r = r.concat(below(tileKey(z + 1, x * 2 + (c & 1), y * 2 + (c >> 1)), depth - 1));
    return r;
  };
  for (const key of wanted) {
    let k = key, found = null;
    while (k) { if (isReady(k)) { found = k; break; } k = parentKey(k); }
    if (found) out.add(found);
    else for (const d of below(key, maxDepth)) out.add(d);
  }
  for (const key of [...out]) {
    for (let p = parentKey(key); p; p = parentKey(p)) if (out.has(p)) { out.delete(key); break; }
  }
  return out;
}

/* ---- terrain height override inside modelled areas ---- */

/* The model's own DEM replaces the tile source inside a modelled area, so
 * water computed on that DEM sits exactly on the ground. Near the area's
 * border the two blend over `featherCells` model cells (no cliff where the
 * datasets disagree). area = { bounds: [w, s, e, n], a: { W, H, dem, valid } }.
 * Returns { h, w } (model height, blend weight 0..1) or null outside. */
export function areaHeight(area, lon, lat, featherCells = 6) {
  const [w, s, e, n] = area.bounds, { W, H, dem, valid } = area.a;
  if (lon < w || lon > e || lat < s || lat > n) return null;
  const fx = ((lon - w) / (e - w)) * W - 0.5, fy = ((n - lat) / (n - s)) * H - 0.5;
  const x0 = Math.max(0, Math.min(W - 1, Math.floor(fx))), y0 = Math.max(0, Math.min(H - 1, Math.floor(fy)));
  const x1 = Math.min(W - 1, x0 + 1), y1 = Math.min(H - 1, y0 + 1);
  const tx = Math.max(0, Math.min(1, fx - x0)), ty = Math.max(0, Math.min(1, fy - y0));
  const i00 = y0 * W + x0, i10 = y0 * W + x1, i01 = y1 * W + x0, i11 = y1 * W + x1;
  if (!valid[i00] || !valid[i10] || !valid[i01] || !valid[i11]) return null;
  const h = (dem[i00] * (1 - tx) + dem[i10] * tx) * (1 - ty) + (dem[i01] * (1 - tx) + dem[i11] * tx) * ty;
  const edge = Math.min(fx + 0.5, W - 0.5 - fx, fy + 0.5, H - 0.5 - fy);   // cells from the border
  const t = Math.max(0, Math.min(1, edge / featherCells));
  return { h, w: t * t * (3 - 2 * t) };
}

/* Blend the base (tile-source) height with whichever areas cover the point. */
export function overrideHeight(base, areas, lon, lat) {
  let h = base;
  for (const area of areas) {
    const r = areaHeight(area, lon, lat);
    if (r) h = h * (1 - r.w) + r.h * r.w;
  }
  return h;
}

/* Does a tile's lon/lat box [w, s, e, n] touch an area's bounds? */
export function boxesOverlap(a, b) { return a[0] < b[2] && a[2] > b[0] && a[1] < b[3] && a[3] > b[1]; }
