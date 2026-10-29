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

// Read a series file ("seconds, metres": comma, semicolon, tab or space separated, '#' comments and one non-numeric header row allowed; seconds are measured from the start of
// the local run). Read and checked in Rust (rust/flood-core/src/series.rs, FloodCore.parseSeries); the wave model must have loaded.
export function parseSeriesCsv(text, { maxRows = 200000 } = {}, F) {
  const core = F || globalThis.FloodCore;
  if (!core || !core.parseSeries) throw new Error('The wave model has not loaded yet.');
  return core.parseSeries(text, maxRows);
}
