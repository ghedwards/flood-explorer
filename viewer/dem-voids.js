/* Gaps in a downloaded elevation window: sea, or holes in the data?
 *
 * Geoscience Australia's DEM-H marks the sea as "no data", but it also has
 * occasional gaps inland. Treated as sea, an inland gap becomes a pit just
 * below sea level hundreds of metres under the land around it, and the
 * flood model fills it as "normal water" (170 m deep beside the river at
 * Wagga Wagga). Here each connected gap is sea only if it reaches the edge
 * of the window and the land along its edge is low; any other gap is filled
 * from the land around it, ring by ring from its edge inwards.
 *
 * dem: Float32Array W*H with NaN for no data (changed in place).
 * Returns { sea: Uint8Array (1 = sea), seaCells, filledCells, gaps }.
 *
 * rust/flood-core/src/voids.rs does the same in Rust (FloodCore.classifyDemGaps), which the
 * page uses once the module has loaded; this stays as the reference and the fallback, and
 * tests/dem-voids-wasm.test.js checks the two agree exactly.
 */
export const SEA_SHORE_MAX_M = 20;

export function classifyDemGaps(dem, W, H, shoreMax = SEA_SHORE_MAX_M) {
  const N = W * H;
  const sea = new Uint8Array(N);
  const comp = new Int32Array(N).fill(-1);
  const queue = new Int32Array(N);
  let seaCells = 0, filledCells = 0, gaps = 0;
  const nbrs = (i, f) => {
    const x = i % W, y = (i - x) / W;
    if (x > 0) f(i - 1);
    if (x < W - 1) f(i + 1);
    if (y > 0) f(i - W);
    if (y < H - 1) f(i + W);
  };
  const fill = [];
  for (let s = 0; s < N; s++) {
    if (!Number.isNaN(dem[s]) || comp[s] >= 0) continue;
    // one gap: its cells, whether it reaches the window's edge, and the
    // land along its edge
    const id = gaps++;
    let head = 0, tail = 0, edge = false, shoreSum = 0, shoreN = 0;
    queue[tail++] = s;
    comp[s] = id;
    const cells = [];
    while (head < tail) {
      const i = queue[head++];
      cells.push(i);
      const x = i % W, y = (i - x) / W;
      if (x === 0 || y === 0 || x === W - 1 || y === H - 1) edge = true;
      nbrs(i, (j) => {
        if (Number.isNaN(dem[j])) {
          if (comp[j] < 0) { comp[j] = id; queue[tail++] = j; }
        } else { shoreSum += dem[j]; shoreN++; }
      });
    }
    const shore = shoreN ? shoreSum / shoreN : -Infinity;
    if (edge && shore < shoreMax) {
      for (const i of cells) sea[i] = 1;
      seaCells += cells.length;
    } else {
      fill.push(cells);
      filledCells += cells.length;
    }
  }
  // fill each inland gap ring by ring from its edge: a breadth-first walk
  // from the land gives each cell its ring, and in that order each cell
  // takes the mean of its neighbours in earlier rings (or land). One pass,
  // however big the gap.
  if (fill.length) {
    const ring = new Int32Array(N).fill(-1);
    let head = 0, tail = 0;
    for (const cells of fill) for (const i of cells) {
      let shore = false;
      nbrs(i, (j) => { if (!Number.isNaN(dem[j])) shore = true; });
      if (shore) { ring[i] = 0; queue[tail++] = i; }
    }
    while (head < tail) {
      const i = queue[head++];
      nbrs(i, (j) => { if (ring[j] < 0 && Number.isNaN(dem[j]) && !sea[j]) { ring[j] = ring[i] + 1; queue[tail++] = j; } });
    }
    for (let q = 0; q < tail; q++) {
      const i = queue[q], ri = ring[i];
      let sum = 0, n = 0;
      nbrs(i, (j) => { if (!sea[j] && (ring[j] < 0 ? !Number.isNaN(dem[j]) : ring[j] < ri)) { sum += dem[j]; n++; } });
      dem[i] = n ? sum / n : 0;
    }
  }
  return { sea, seaCells, filledCells, gaps };
}
