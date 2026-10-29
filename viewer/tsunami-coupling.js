// One-way nesting of a local nonlinear model inside a regional propagation model is worked out in Rust (rust/flood-core/src/coupling.rs and nest.rs, through
// FloodCore.tsunamiStart): where on the regional grid to read the wave for each open edge, Green's-law scaling, the regional run and its recording, the forcing, a
// supplied series and the rising tide. What stays here is reading a series file and placing a point on the regional grid.
//
// Not two-way here (there is a two-way option, also Rust: nest.rs): the local model does not feed back to the regional one, and the regional run is linear on a 1.5 km grid
// with coastal depths floored at 10 m. The forced signal is therefore only as good as the regional solution at the handover points (see docs/tsunami-prototype.md).

// Regional grids are an even lon/lat resampling of `bounds` (west, south, east, north).
export function toParentCell(parentData, lon, lat) {
  const [west, south, east, north] = parentData.bounds;
  return [(lon - west) / (east - west) * parentData.W, (north - lat) / (north - south) * parentData.H];
}
export function fromParentCell(parentData, x, y) {
  const [west, south, east, north] = parentData.bounds;
  return [west + x / parentData.W * (east - west), north - y / parentData.H * (north - south)];
}

// Parse a two-column "seconds, metres" series (comma, semicolon, tab or space
// separated; '#' comments and one non-numeric header row allowed). Seconds
// are measured from the start of the local run.
export function parseSeriesCsv(text, { maxRows = 200000 } = {}) {
  const times = [], values = [];
  let header = true;
  for (const raw of String(text).split(/\r?\n/)) {
    const line = raw.replace(/#.*/, '').trim();
    if (!line) continue;
    const cells = line.split(/[\s,;]+/);
    const numbers = cells.slice(0, 2).map(Number);
    if (cells.length < 2 || numbers.some(v => !Number.isFinite(v))) {
      if (header && !times.length) { header = false; continue; }
      throw new Error(`Line "${line.slice(0, 40)}" is not "seconds, metres".`);
    }
    header = false;
    if (times.length && numbers[0] <= times.at(-1)) throw new Error('Times must increase down the file.');
    if (Math.abs(numbers[1]) > 20) throw new Error('Wave heights above 20 m are not accepted.');
    if (times.length >= maxRows) throw new Error(`Too many rows (limit ${maxRows}).`);
    times.push(numbers[0]); values.push(numbers[1]);
  }
  if (times.length < 2) throw new Error('The series needs at least two rows of "seconds, metres".');
  return { times: Float64Array.from(times), values: Float64Array.from(values) };
}
