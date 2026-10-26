// One-way nesting of a local nonlinear model inside a regional propagation
// model. The regional run records surface displacement along the local
// model's open sea edges; the local solver receives it as incoming-wave
// boundary forcing. Pure functions only, so the worker and the tests share them.
//
// Not two-way: the local model does not feed back to the regional one, and the
// regional run is linear on a 1.5 km grid with coastal depths floored at 10 m.
// The forced signal is therefore only as good as the regional solution at the
// handover points (see docs/tsunami-prototype.md).

const EDGES = ['north', 'east', 'south', 'west'];
const FORCE_KEYS = { north: 'forceNorth', east: 'forceEast', south: 'forceSouth', west: 'forceWest' };

// Inverse transverse Mercator on GRS80 (Krüger series, sub-millimetre inside a
// zone). Used for the GDA2020 / MGA grids, e.g. zone 56 = EPSG:7856.
export function mgaToGeographic(easting, northing, zone = 56) {
  const a = 6378137, f = 1 / 298.257222101, k0 = 0.9996;
  const n = f / (2 - f), n2 = n * n, n3 = n2 * n, n4 = n2 * n2;
  const A = a / (1 + n) * (1 + n2 / 4 + n4 / 64);
  const beta = [n / 2 - 2 * n2 / 3 + 37 * n3 / 96 - n4 / 360, n2 / 48 + n3 / 15 - 437 * n4 / 1440, 17 * n3 / 480 - 37 * n4 / 840, 4397 * n4 / 161280];
  const delta = [2 * n - 2 * n2 / 3 - 2 * n3 + 116 * n4 / 45, 7 * n2 / 3 - 8 * n3 / 5 - 227 * n4 / 45, 56 * n3 / 15 - 136 * n4 / 35, 4279 * n4 / 630];
  const xi = (northing - 10000000) / (k0 * A), eta = (easting - 500000) / (k0 * A);
  let xiP = xi, etaP = eta;
  beta.forEach((b, i) => {
    const j = 2 * (i + 1);
    xiP -= b * Math.sin(j * xi) * Math.cosh(j * eta);
    etaP -= b * Math.cos(j * xi) * Math.sinh(j * eta);
  });
  const chi = Math.asin(Math.sin(xiP) / Math.cosh(etaP));
  let lat = chi;
  delta.forEach((d, i) => { lat += d * Math.sin(2 * (i + 1) * chi); });
  const lon = (6 * zone - 183) * Math.PI / 180 + Math.atan2(Math.sinh(etaP), Math.cos(xiP));
  return [lon * 180 / Math.PI, lat * 180 / Math.PI];
}

// Regional grids are an even lon/lat resampling of `bounds` (west, south, east, north).
export function toParentCell(parentData, lon, lat) {
  const [west, south, east, north] = parentData.bounds;
  return [(lon - west) / (east - west) * parentData.W, (north - lat) / (north - south) * parentData.H];
}
export function fromParentCell(parentData, x, y) {
  const [west, south, east, north] = parentData.bounds;
  return [west + x / parentData.W * (east - west), north - y / parentData.H * (north - south)];
}

// Centre of fine-grid cell (x, y) as longitude/latitude.
function fineCellGeographic(fine, x, y) {
  const [xmin, , , ymax] = fine.extent;
  return mgaToGeographic(xmin + (x + .5) * fine.cell, ymax - (y + .5) * fine.cell);
}

// Nearest regional wet cell centre to a fractional point, or null.
function wetNear(parentGrid, x, y, radius = 8) {
  const { W, H, depth } = parentGrid;
  const cx = Math.floor(x), cy = Math.floor(y);
  let best = null, distance = Infinity;
  for (let j = cy - radius; j <= cy + radius; j++) for (let i = cx - radius; i <= cx + radius; i++) {
    if (i < 0 || j < 0 || i >= W || j >= H || !(depth[j * W + i] > 0)) continue;
    const d = Math.hypot(i + .5 - x, j + .5 - y);
    if (d < distance) { distance = d; best = [i + .5, j + .5]; }
  }
  return best && distance <= radius ? { point: best, moved: distance } : null;
}
function regionalDepth(parentGrid, [x, y]) {
  return parentGrid.depth[Math.min(parentGrid.H - 1, Math.floor(y)) * parentGrid.W + Math.min(parentGrid.W - 1, Math.floor(x))];
}

// Choose where on the regional grid to read the wave for every open edge.
// `fine` is the local terrain JSON; `fineGrid` the initialised local grid.
export function planCoupling({ fine, fineGrid, parentData, parentGrid, perEdge = 16 }) {
  if (!fine?.extent || !Array.isArray(fine.seaEdges) || !fine.seaEdges.length) throw new Error('This local scene declares no open sea edges to drive.');
  if (!parentData?.bounds || parentGrid.W !== parentData.W || parentGrid.H !== parentData.H) throw new Error('The regional grid does not match its metadata.');
  const points = [], edges = [];
  for (const name of EDGES.filter(e => fine.seaEdges.includes(e))) {
    const horizontal = name === 'north' || name === 'south';
    const length = horizontal ? fineGrid.W : fineGrid.H;
    const count = Math.min(perEdge, length);
    const cellAt = k => {
      const along = Math.min(length - 1, Math.floor((k + .5) / count * length));
      return horizontal ? [along, name === 'north' ? 0 : fineGrid.H - 1] : [name === 'west' ? 0 : fineGrid.W - 1, along];
    };
    const edge = { name, first: points.length / 2, count, gains: new Float64Array(count), snapped: 0, wet: 0 };
    for (let k = 0; k < count; k++) {
      const [fx, fy] = cellAt(k);
      const fineIndex = fy * fineGrid.W + fx;
      const fineDepth = fineGrid.depth[fineIndex];
      const [lon, lat] = fineCellGeographic(fine, fx, fy);
      const [px, py] = toParentCell(parentData, lon, lat);
      if (px < .5 || py < .5 || px > parentData.W - .5 || py > parentData.H - .5) {
        throw new Error(`The ${name} edge of this local scene lies outside the regional model (${lon.toFixed(2)}°E ${lat.toFixed(2)}°N).`);
      }
      const wet = wetNear(parentGrid, px, py);
      if (!wet) throw new Error(`No regional ocean cell within 12 km of the ${name} edge; it cannot be driven.`);
      if (wet.moved > 1) edge.snapped++;
      // Green's law carries the regional wave from its depth to the local edge
      // depth: eta ~ H^(-1/4). Bounded so shallow flats cannot amplify wildly.
      const gain = fineDepth > 0 ? Math.min(2, Math.max(.5, (regionalDepth(parentGrid, wet.point) / fineDepth) ** .25)) : 1;
      if (fineDepth > 0) edge.wet++;
      edge.gains[k] = gain;
      points.push(...wet.point);
    }
    if (!edge.wet) continue;
    edges.push(edge);
  }
  if (!edges.length) throw new Error('No sea edge of this local scene has open water to drive.');
  return { points: Float64Array.from(points), edges };
}

// Turn the regional recording into solver forcing. Local time 0 is placed
// `lead` seconds before the wave first exceeds `threshold` of its peak at any
// handover point, so the local model does not spend its run waiting.
export function forcingFromRecording(plan, recording, { lead = 120, threshold = .02, maxLocalSeconds = 7200 } = {}) {
  const { times, values, points } = recording;
  if (points !== plan.points.length / 2 || values.length !== times.length * points) throw new Error('The regional recording does not match the coupling plan.');
  let peak = 0;
  const scaled = new Float64Array(values.length);
  for (const edge of plan.edges) for (let k = 0; k < edge.count; k++) {
    for (let s = 0; s < times.length; s++) {
      const v = values[s * points + edge.first + k] * edge.gains[k];
      scaled[s * points + edge.first + k] = v;
      peak = Math.max(peak, Math.abs(v));
    }
  }
  if (!(peak > 1e-4)) throw new Error('The offshore wave never reaches the local model within the regional run. Extend the length, move the source or raise its strength.');
  let arrival = times.length - 1;
  search: for (let s = 0; s < times.length; s++) for (let p = 0; p < points; p++) {
    if (Math.abs(scaled[s * points + p]) > threshold * peak) { arrival = s; break search; }
  }
  const start = Math.max(0, times[arrival] - lead);
  let first = Math.max(0, times.findIndex(t => t > start) - 1);
  const keep = [];
  for (let s = first; s < times.length && times[s] - start <= maxLocalSeconds + 2 * (times[1] - times[0]); s++) keep.push(s);
  if (keep.length < 2) throw new Error('The regional run ends before the wave arrives. Lengthen the offshore run.');
  const out = { forceTimes: Float64Array.from(keep, s => times[s] - start), offset: start, arrival: times[arrival], peak, edges: {} };
  for (const edge of plan.edges) {
    const series = new Float64Array(keep.length * edge.count);
    keep.forEach((s, row) => { for (let k = 0; k < edge.count; k++) series[row * edge.count + k] = scaled[s * points + edge.first + k]; });
    out[FORCE_KEYS[edge.name]] = series;
    let edgePeak = 0;
    for (const v of series) edgePeak = Math.max(edgePeak, Math.abs(v));
    out.edges[edge.name] = { points: edge.count, peak: edgePeak, snapped: edge.snapped };
  }
  return out;
}

// Seconds the regional model should run. The 1.5 km grid sends waves into
// sheltered bays only slowly (hours), so allow generously: at least three
// hours, otherwise twice the straight-line travel time at a mean 120 m/s, plus
// the local run. The regional run is cheap (160 x 96 cells).
export function parentSeconds({ plan, parentGrid, source, localSeconds, lead = 120, meanSpeed = 120 }) {
  let farthest = 0;
  for (let i = 0; i < plan.points.length; i += 2) farthest = Math.max(farthest, Math.hypot(plan.points[i] - source[0] - .5, plan.points[i + 1] - source[1] - .5) * parentGrid.cell);
  return Math.min(21600, Math.max(10800, Math.ceil((2 * farthest / meanSpeed + lead + localSeconds) / 60) * 60));
}

export { FORCE_KEYS };
