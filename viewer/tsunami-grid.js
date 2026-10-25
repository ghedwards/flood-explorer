// Regional propagation grids and a separate idealised nonlinear estuary test.
export function tsunamiGrid({ preset = 'shelf', deep = 3000, amplitude = 1, width = 10, source = [38, 48], absorbing = true, method = 'staggered', bathymetry = null, tide = 0, roughness = 0.025, lakeLevel = 1 } = {}) {
  if (preset === 'pine-estuary') return localEstuaryGrid({ bathymetry, amplitude, width, source, absorbing, tide, roughness });
  if (preset === 'estuary') return estuaryGrid({ amplitude, width, source, absorbing, tide, roughness, lakeLevel });
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

// 4 × 2.4 km idealised coast. Not a reconstruction of Moreton Bay.
// A low floodplain, a curving estuary, a raised inland lake and an offshore pulse.
export function estuaryGrid({ amplitude = 1, width = .3, source = [38, 48], absorbing = true, tide = 0, roughness = .025, lakeLevel = 1 } = {}) {
  if (![amplitude, width, tide, roughness, lakeLevel].every(Number.isFinite)
    || Math.abs(amplitude) > 3 || width < .1 || width > .8 || tide < -1 || tide > 2
    || roughness < 0 || roughness > .2 || lakeLevel < .5 || lakeLevel > 2
    || !Array.isArray(source) || source.length !== 2 || source.some(v => !Number.isInteger(v))
    || source[0] < 0 || source[0] >= 160 || source[1] < 0 || source[1] >= 96) throw new Error('Invalid estuary scenario.');
  const W = 160, H = 96, cell = 25;
  const bed = new Float64Array(W * H), depth = new Float64Array(W * H), eta = new Float64Array(W * H);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const i = y * W + x;
    const channel = Math.abs(y - (48 + 7 * Math.sin((x - 78) / 22)));
    let z = x < 80 ? -Math.min(40, (80 - x) * .5) : .05 * (x - 80);
    if (x >= 70 && channel < 4) z = Math.min(z, -2 + Math.max(0, x - 90) * .015);
    // Elliptical lake with a raised rim separates its water level from the sea.
    const lake = Math.hypot((x - 128) / 13, (y - 22) / 10);
    if (lake < 1.25) z = lake < 1 ? -.5 : 2.5;
    bed[i] = z;
    const level = lake < 1 ? lakeLevel : tide;
    depth[i] = Math.max(0, level - z);
  }
  const origin = source[1] * W + source[0];
  if (depth[origin] < .25) throw new Error('Choose a wave source in water at least 0.25 m deep.');
  // Perturb only the source waterbody. Clicking the lake can generate a seiche
  // without also imposing the same initial wave on the disconnected ocean.
  const queue = [origin], seen = new Uint8Array(W * H); seen[origin] = 1;
  const add = i => { if (!seen[i] && depth[i] > 0) { seen[i] = 1; queue.push(i); } };
  for (let head = 0; head < queue.length; head++) {
    const i = queue[head], x = i % W, y = Math.floor(i / W);
    const dx = (x - source[0]) * cell / 1000 / width, dy = (y - source[1]) * cell / 1000 / width;
    eta[i] = amplitude * dx * Math.exp(.5 - .5 * (dx * dx + dy * dy)) * Math.min(1, depth[i] / 5);
    if (x > 0) add(i - 1); if (x < W - 1) add(i + 1);
    if (y > 0) add(i - W); if (y < H - 1) add(i + W);
  }
  return { W, H, cell, bed, depth, eta, absorbing, roughness, method: 2 };
}

export function localEstuaryGrid({ bathymetry, amplitude = 1, width = .3, source = [140, 48], absorbing = true, tide = 0, roughness = .025 } = {}) {
  const data = bathymetry, W = 160, H = 96, cell = 25;
  if (!data || data.id !== 'pine-estuary' || data.W !== W || data.H !== H || data.cell !== cell
    || !Array.isArray(data.elevation) || data.elevation.length !== W * H
    || data.elevation.some(v => !Number.isFinite(v) || v < -100 || v > 1000)
    || !Array.isArray(data.extent) || data.extent.length !== 4 || data.extent.some(v => !Number.isFinite(v))
    || Math.abs(data.extent[2] - data.extent[0] - W * cell) > .01 || Math.abs(data.extent[3] - data.extent[1] - H * cell) > .01
    || ![amplitude, width, tide, roughness].every(Number.isFinite) || Math.abs(amplitude) > 3 || width < .1 || width > .8
    || tide < -1 || tide > 2 || roughness < 0 || roughness > .2
    || !Array.isArray(source) || source.length !== 2 || source.some(v => !Number.isInteger(v))
    || source[0] < 0 || source[0] >= W || source[1] < 0 || source[1] >= H) throw new Error('Invalid local estuary terrain or water settings.');
  const bed = Float64Array.from(data.elevation), depth = new Float64Array(W * H), eta = new Float64Array(W * H);
  // Flood-fill from the bay edge only. Unconnected depressions are not lakes
  // with known levels; leave them dry rather than filling them to sea level.
  const queue = [], seen = new Uint8Array(W * H);
  const add = i => { if (!seen[i] && bed[i] < tide) { seen[i] = 1; queue.push(i); } };
  for (let y = 0; y < H; y++) add(y * W + W - 1);
  for (let head = 0; head < queue.length; head++) {
    const i = queue[head], x = i % W, y = Math.floor(i / W);
    depth[i] = tide - bed[i];
    if (x > 0) add(i - 1); if (x < W - 1) add(i + 1);
    if (y > 0) add(i - W); if (y < H - 1) add(i + W);
  }
  if (depth[source[1] * W + source[0]] < 2) throw new Error('Choose a source in connected bay water at least 2 m deep.');
  for (let i = 0; i < eta.length; i++) if (depth[i] > 0) {
    const dx = (i % W - source[0]) * cell / 1000 / width, dy = (Math.floor(i / W) - source[1]) * cell / 1000 / width;
    // Crest faces west towards the river. Depth taper keeps drawdown positive.
    eta[i] = -amplitude * dx * Math.exp(.5 - .5 * (dx * dx + dy * dy)) * Math.min(1, depth[i] / 5);
  }
  return { W, H, cell, bed, depth, eta, absorbing, roughness, method: 2 };
}
