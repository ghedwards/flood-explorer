// Display original terrain, independently of water depth and the propagation solver's shallow-water floor. Synthetic land masks have no known heights.
// The heights' range and the colours are worked out in Rust (rust/flood-core/src/lab.rs).
export function terrainFor(grid, bathymetry, F = globalThis.FloodCore) {
  const elevation = grid.bed || bathymetry?.elevation || Float64Array.from(grid.depth, d => d > 0 ? -d : NaN);
  return F.terrainColours(elevation, grid.valid);
}
