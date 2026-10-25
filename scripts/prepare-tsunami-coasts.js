// Rebuild the small, attributed coastal subsets bundled with the prototype.
// Run explicitly; builds and visitors never depend on this upstream service.
const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '..');
const sites = [
  ['moreton', 'Moreton Bay / Brisbane', -27.45, 153.75],
  ['gold-coast', 'Gold Coast / Tweed', -28.1, 154.05],
  ['coffs', 'Coffs Harbour', -30.3, 153.8],
  ['newcastle', 'Newcastle / Hunter coast', -32.9, 152.4],
  ['sydney', 'Sydney / Central Coast', -33.85, 151.95],
];

async function main() {
  const { fromArrayBuffer } = await import('geotiff');
  const output = path.join(root, 'viewer/public/tsunami-data');
  const cache = path.join(root, 'work/tsunami-source');
  fs.mkdirSync(output, { recursive: true }); fs.mkdirSync(cache, { recursive: true });
  for (const [id, name, lat, lon] of sites) {
    const W = 160, H = 96, cell = 1500;
    const dy = H * cell / 111320 / 2, dx = W * cell / (111320 * Math.cos(lat * Math.PI / 180)) / 2;
    const bounds = [lon - dx, lat - dy, lon + dx, lat + dy].map(n => +n.toFixed(7));
    const url = new URL('https://services.ga.gov.au/gis/services/Bathymetry_Topography/MapServer/WCSServer');
    url.search = new URLSearchParams({ service: 'WCS', version: '1.0.0', request: 'GetCoverage', coverage: '1',
      crs: 'EPSG:4326', bbox: bounds.join(','), width: String(W), height: String(H), format: 'GeoTIFF' });
    const file = path.join(cache, `${id}.tif`);
    if (!fs.existsSync(file)) {
      const response = await fetch(url, { signal: AbortSignal.timeout(45000) });
      if (!response.ok) throw new Error(`${id}: HTTP ${response.status}`);
      fs.writeFileSync(file, Buffer.from(await response.arrayBuffer()));
    }
    const bytes = fs.readFileSync(file);
    const image = await (await fromArrayBuffer(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength))).getImage();
    const elevation = Array.from((await image.readRasters({ samples: [0] }))[0]);
    if (image.getWidth() !== W || image.getHeight() !== H || elevation.some(n => !Number.isFinite(n) || n < -12000 || n > 9000)
      || !elevation.some(n => n < -100) || !elevation.some(n => n > 0)) throw new Error(`${id}: invalid coastal raster`);
    const actual = image.getBoundingBox();
    if (actual.some((n, i) => Math.abs(n - bounds[i]) > 1e-5)) throw new Error(`${id}: unexpected bounds`);
    const data = { id, name, W, H, cell, bounds, elevation,
      source: 'Geoscience Australia Australian Bathymetry and Topography, version 4 (2009)',
      sourceUrl: url.toString(), metadataUrl: 'https://services.ga.gov.au/gis/rest/services/Bathymetry_Topography/MapServer',
      attribution: '© Commonwealth of Australia (Geoscience Australia) 2016; CC BY 4.0',
      prepared: new Date().toISOString(), projection: 'Local equirectangular approximation at domain centre',
      note: '1.5 km WCS resampling; regional propagation only. Grid vintage 2009, not AusBathyTopo 2026. Vertical datum must be reconciled before coupling to land elevations.' };
    fs.writeFileSync(path.join(output, `${id}.json`), JSON.stringify(data) + '\n');
    console.log(`${name}: ${elevation.length} real elevation samples, ${Math.min(...elevation)} to ${Math.max(...elevation)} m`);
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
