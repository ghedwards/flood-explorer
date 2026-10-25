// Display original terrain, independently of water depth and the propagation
// solver's shallow-water floor. Synthetic land masks have no known heights.
export function terrainFor(grid, bathymetry) {
  let elevation = grid.bed || bathymetry?.elevation || Float64Array.from(grid.depth, d => d > 0 ? -d : NaN);
  if (grid.valid) elevation = Float64Array.from(elevation, (z, i) => grid.valid[i] ? z : NaN);
  let low = 0, high = 0;
  for (const z of elevation) if (Number.isFinite(z)) { low = Math.min(low, z); high = Math.max(high, z); }
  const colours = new Uint8Array(elevation.length * 3);
  for (let i = 0; i < elevation.length; i++) {
    const z = elevation[i];
    let rgb = [110, 119, 107];
    if (Number.isFinite(z)) {
      const a = z < 0 ? [164, 214, 225] : [139, 178, 115];
      const b = z < 0 ? [17, 54, 94] : [185, 145, 96];
      const fraction = z < 0 ? z / (low || -1) : z / (high || 1);
      rgb = a.map((v, k) => Math.round(v + (b[k] - v) * fraction));
    }
    colours.set(rgb, i * 3);
  }
  return { elevation, low, high, colours };
}
