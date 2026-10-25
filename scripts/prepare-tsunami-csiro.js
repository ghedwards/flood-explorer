// Explicit, range-only prefetch: never downloads the 15 GB statewide COG.
// One consistent AVWS dataset, not a patch into terrain of an unknown datum.
const fs = require('node:fs');
const path = require('node:path');
const collection = 'https://data.csiro.au/dap/ws/v2/collections/72113';
const projectionService = 'https://utility.arcgisonline.com/ArcGIS/rest/services/Geometry/GeometryServer/project';
async function json(url, options = {}) {
  const response = await fetch(url, { ...options, signal: AbortSignal.timeout(60000) });
  if (!response.ok) throw new Error(`HTTP ${response.status} from ${new URL(url).hostname}`);
  const value = await response.json();
  if (value.error) throw new Error(JSON.stringify(value.error));
  return value;
}
async function main() {
  const { fromUrl } = await import('geotiff');
  const { estuaryLocations } = await import('../viewer/tsunami-locations.js');
  const site = estuaryLocations.find(site => site.id === (process.argv[2] || 'gold-coast-seaway'));
  if (!site) throw new Error('Unknown local terrain scene');
  const { id, name, extent, seaEdges, sourceTarget, cell = 25 } = site;
  const W = 160, H = 96;
  const cache = path.resolve(__dirname, '../work/tsunami-source');
  fs.mkdirSync(cache, { recursive: true });
  const coordinateFile = path.join(cache, `${id}-albers-centres.json`);
  let projected;
  if (fs.existsSync(coordinateFile)) {
    const saved = JSON.parse(fs.readFileSync(coordinateFile));
    if (JSON.stringify(saved.extent) !== JSON.stringify(extent) || saved.cell !== cell) throw new Error('Stale coordinate cache');
    projected = saved.points;
  } else {
    const points = Array.from({ length: W * H }, (_, i) => ({ x: extent[0] + (i % W + .5) * cell, y: extent[3] - (Math.floor(i / W) + .5) * cell }));
    projected = [];
    for (let i = 0; i < points.length; i += 512) {
      const result = await json(projectionService, { method: 'POST', body: new URLSearchParams({ f: 'json', inSR: '7856', outSR: '9473', geometries: JSON.stringify({ geometryType: 'esriGeometryPoint', geometries: points.slice(i, i + 512) }) }) });
      if (result.geometries?.length !== Math.min(512, points.length - i)) throw new Error('Incomplete coordinate transformation');
      projected.push(...result.geometries);
    }
    fs.writeFileSync(coordinateFile, JSON.stringify({ extent, cell, points: projected }));
  }
  if (projected.length !== W * H || projected.some(p => !Number.isFinite(p.x) || !Number.isFinite(p.y))) throw new Error('Invalid projected centres');
  const metadata = await json(collection);
  const files = await json(metadata.data);
  const sampled = [];
  const sourceFiles = [];
  for (const suffix of ['_DEM.tif', '_FLAGS.tif']) {
    const file = files.file.find(file => file.filename.endsWith(suffix));
    if (!file?.presignedLink?.href) throw new Error('Public COG unavailable');
    const tif = await fromUrl(file.presignedLink.href, { allowFullFile: false, blockSize: 65536, cacheSize: 128 });
    const image = await tif.getImage();
    if (image.getGeoKeys().ProjectedCSTypeGeoKey !== 9473) throw new Error('Unexpected source projection');
    const origin = image.getOrigin(), resolution = image.getResolution();
    const pixels = projected.map(p => [Math.floor((p.x - origin[0]) / resolution[0]), Math.floor((p.y - origin[1]) / resolution[1])]);
    const xs = pixels.map(p => p[0]), ys = pixels.map(p => p[1]);
    const window = [Math.min(...xs), Math.min(...ys), Math.max(...xs) + 1, Math.max(...ys) + 1];
    if (window[0] < 0 || window[1] < 0 || window[2] > image.getWidth() || window[3] > image.getHeight() || (window[2] - window[0]) * (window[3] - window[1]) > 4000000) throw new Error('Invalid or excessive source crop');
    const rasters = await image.readRasters({ window, samples: [0], signal: AbortSignal.timeout(120000) });
    const stride = window[2] - window[0];
    sampled.push(pixels.map(([x, y]) => rasters[0][(y - window[1]) * stride + x - window[0]]));
    sourceFiles.push({ filename: file.filename, url: file.link.href, pixelWindow: window, sourceResolution: resolution.slice(0, 2) });
    console.log(`Read ${file.filename}: ${stride} × ${window[3] - window[1]} pixel crop`);
  }
  const [raw, flags] = sampled;
  const valid = raw.map((v, i) => Number.isFinite(v) && v > -100 && v < 1000 && Number.isInteger(flags[i]) && flags[i] >= 0 && flags[i] <= 7 ? 1 : 0);
  const missing = valid.filter(v => !v).length;
  if (missing > W * H * .01) throw new Error(`${missing} missing source cells; inspect coverage before publishing`);
  const elevation = raw.map((v, i) => valid[i] ? +v.toFixed(3) : null);
  const terrainSource = flags.map((v, i) => valid[i] ? v : 255);
  const sourceLabels = ['Interpolated', 'LiDAR', 'Multibeam survey', 'Single-beam survey', 'Satellite intertidal', 'Modelled tidal creek', 'Coarse base water', 'Coarse base land'];
  const sourceCounts = sourceLabels.map((label, flag) => ({ flag, label, cells: terrainSource.filter(v => v === flag).length }));
  const data = { id, name, kind: 'estuary', W, H, cell, extent, seaEdges, sourceTarget, elevation, valid, missing, terrainSource, sourceLabels, sourceCounts,
    projection: 'GDA2020 / MGA zone 56 (EPSG:7856)', sourceProjection: 'GDA2020 / Australian Albers (EPSG:9473)',
    verticalDatum: 'Australian Vertical Working Surface (AVWS, EPSG:9458). Initial sea level is a hypothetical AVWS plane, not calibrated local mean sea level.',
    source: 'CSIRO Queensland estuaries composite topography-bathymetry v1 (5 m source grid)',
    sourceUrl: metadata.selfLink, metadataUrl: metadata.selfLink, sourceFiles, projectionService,
    attribution: metadata.attributionStatement, license: 'CC BY 4.0', licenseMetadataUrl: 'https://creativecommons.org/licenses/by/4.0/',
    changes: `Reprojected cell centres from EPSG:7856 to EPSG:9473; nearest 5 m source pixel sampled at each ${cell} m model cell centre; source flags retained; elevations rounded to 1 mm. No vertical datum mixing or local gap filling.`,
    sampling: `${cell} m centre sampling from a 5 m composite; narrow channels can be unresolved`,
    prepared: new Date().toISOString(),
    note: 'Composite includes interpolated terrain, modelled creek depths and coarse base data, not only surveys. All elevations retain AVWS; tide is a hypothetical plane. Missing cells are excluded from flow. No verified offshore tsunami forcing, tide calibration or hazard validation.' };
  fs.writeFileSync(path.resolve(__dirname, `../viewer/public/tsunami-data/${id}.json`), JSON.stringify(data) + '\n');
  console.log(JSON.stringify({ id, missing, sourceCounts }));
}
main().catch(error => { console.error(error); process.exitCode = 1; });
