// Synthetic bathymetry only: no geographic coordinates or fetched datasets.
export function tsunamiGrid({ preset = 'shelf', deep = 3000, amplitude = 1, width = 10, source = [38, 48], absorbing = true, method = 'staggered', bathymetry = null } = {}) {
  if ((!bathymetry && !['flat', 'shelf', 'island'].includes(preset)) || !['staggered', 'finite-volume'].includes(method) || !Number.isFinite(deep) || deep < 500 || deep > 5000
    || !Number.isFinite(amplitude) || Math.abs(amplitude) > 3 || !Number.isFinite(width) || width < 5 || width > 20
    || !Array.isArray(source) || source.length !== 2 || source.some(x => !Number.isFinite(x))) throw new Error('Invalid wave scenario.');
  const W = 160, H = 96, cell = bathymetry ? 1500 : 1000;
  if (bathymetry && (bathymetry.id !== preset || bathymetry.W !== W || bathymetry.H !== H || bathymetry.cell !== cell
    || !Array.isArray(bathymetry.elevation) || bathymetry.elevation.length !== W * H
    || bathymetry.elevation.some(x => !Number.isFinite(x) || x < -12000 || x > 9000)
    || !Array.isArray(bathymetry.bounds) || bathymetry.bounds.length !== 4 || bathymetry.bounds.some(x => !Number.isFinite(x)))) throw new Error('Invalid prefetched coastal grid.');
  if (source[0] < 0 || source[0] >= W || source[1] < 0 || source[1] >= H) throw new Error('Choose a source inside the basin.');
  const depth = new Float64Array(W * H), eta = new Float64Array(W * H);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const i = y * W + x;
    const coast = 130 + 3 * Math.cos(y / H * Math.PI * 2);
    depth[i] = preset === 'flat' ? deep : x >= coast ? 0 : Math.max(20, deep * Math.min(1, (coast - x) / 50));
    if (preset === 'island') {
      const radius = Math.hypot(x - 87, y - 48);
      depth[i] = Math.min(depth[i], radius <= 7 ? 0 : Math.max(20, deep * Math.min(1, (radius - 7) / 16)));
    }
    // Keep the measured land/sea mask. The propagation-only model floors
    // shallow wet cells at 10 m; this is disclosed alongside the dataset.
    if (bathymetry) depth[i] = bathymetry.elevation[i] < 0 ? Math.max(10, -bathymetry.elevation[i]) : 0;
    if (depth[i] > 0) {
      const dx = (x - source[0]) * cell / 1000 / width, dy = (y - source[1]) * cell / 1000 / width;
      // Paired uplift/subsidence at rest; the positive lobe faces east.
      eta[i] = amplitude * dx * Math.exp(0.5 - 0.5 * (dx * dx + dy * dy));
    }
  }
  if (depth[Math.floor(source[1]) * W + Math.floor(source[0])] === 0) throw new Error('Choose a wave source in the ocean.');
  return { W, H, cell, depth, eta, absorbing, method: method === 'finite-volume' ? 1 : 0 };
}
