// Explicit prefetch for experimental local Queensland estuary grids.
// No runtime dependency on the Queensland service. No channel carving or gap fill.
const fs = require('node:fs');
const path = require('node:path');
async function main() {
  const { fromArrayBuffer } = await import('geotiff');
  const service = 'https://spatial-img.information.qld.gov.au/arcgis/rest/services/Elevation/QldDem/ImageServer';
  const { estuaryLocations: sites } = await import('../viewer/tsunami-locations.js');
  const requested = process.argv[2];
  if (requested && !sites.some(site => site.id === requested)) throw new Error(`Unknown estuary: ${requested}`);
  if (requested === 'gold-coast-seaway') throw new Error('Use node scripts/prepare-tsunami-csiro.js for the AVWS Gold Coast grid.');
  for (const { id, name, extent, seaEdges, sourceTarget, cell = 25 } of sites.filter(site => (!requested || site.id === requested) && site.id !== 'gold-coast-seaway')) {
    const W = 160, H = 96;
    const url = new URL(`${service}/exportImage`);
    url.search = new URLSearchParams({ f: 'json', bbox: extent.join(','), bboxSR: '7856', imageSR: '7856', size: `${W},${H}`,
      format: 'tiff', pixelType: 'F32', interpolation: 'RSP_BilinearInterpolation', noData: '-9999', renderingRule: JSON.stringify({ rasterFunction: 'None' }) });
    const cache = path.resolve(__dirname, `../work/tsunami-source/${id}.tif`);
    if (!fs.existsSync(cache)) {
      const response = await fetch(url, { signal: AbortSignal.timeout(45000) });
      if (!response.ok) throw new Error(`Elevation service: HTTP ${response.status}`);
      const data = await response.json();
      if (!data.href) throw new Error(JSON.stringify(data.error || data));
      const imageResponse = await fetch(data.href, { signal: AbortSignal.timeout(45000) });
      if (!imageResponse.ok) throw new Error(`Elevation image: HTTP ${imageResponse.status}`);
      fs.mkdirSync(path.dirname(cache), { recursive: true });
      fs.writeFileSync(cache, Buffer.from(await imageResponse.arrayBuffer()));
    }
    const bytes = fs.readFileSync(cache);
    const image = await (await fromArrayBuffer(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength))).getImage();
    const nodata = image.getGDALNoData();
    const raw = Array.from((await image.readRasters({ samples: [0] }))[0]);
    const valid = raw.map(v => Number.isFinite(v) && v !== nodata ? 1 : 0);
    const missing = valid.filter(v => v === 0).length;
    const elevation = raw.map((v, i) => valid[i] ? +v.toFixed(3) : null);
    if (image.getWidth() !== W || image.getHeight() !== H || image.getBoundingBox().some((v, i) => Math.abs(v - extent[i]) > .01)
      || missing > raw.length * .01 || elevation.some(v => v !== null && (!Number.isFinite(v) || v < -100 || v > 1000))
      || !elevation.some(v => v < -1) || !elevation.some(v => v > 1)) throw new Error('Incomplete or invalid estuary terrain; do not fill missing bathymetry.');
    const data = { id, name, kind: 'estuary', seaEdges, sourceTarget, W, H, cell, extent, elevation, valid, missing,
      projection: 'GDA2020 / MGA zone 56 (EPSG:7856)',
      verticalDatum: 'Not specified in service export; initial level is a hypothetical plane in source elevation units, not a verified tidal datum.',
      source: 'Queensland Government QldDem elevation mosaic (mixed LiDAR, SRTM and bathymetry)', sourceUrl: url.toString(), metadataUrl: service,
      attribution: "Includes material \u00a9 State of Queensland (Department of Natural Resources and Mines, Manufacturing, and Regional and Rural Development); \u00a9 Commonwealth of Australia (Geoscience Australia, The Australian Hydrographic Office); \u00a9 www.deepreef.org 2025",
      license: 'CC BY-SA', licenseMetadataUrl: `${service}/info/metadata`, changes: `Clipped and bilinearly resampled to ${cell} m; numeric elevations rounded to 1 mm.`,
      acknowledgement: "In consideration of the State of Queensland permitting use of this data you acknowledge and agree that the State gives no warranty in relation to the data (including accuracy, reliability, completeness, currency or suitability) and accepts no liability (including without limitation, liability in negligence) for any loss, damage or costs (including consequential damage) relating to any use of the data.", hydrographicNotice: "The bathymetric data not to be used for navigation. The Australian Hydrographic Office does not check the information in this product and the Commonwealth accepts no liability for the accuracy of copying or for any modifications that may have been made to the information which it has supplied. Furthermore, the Commonwealth does not warrant that this product contains the latest hydrographic information available.",
      prepared: new Date().toISOString(),
      note: `${cell} m bilinear resampling. Source resolution and age vary; submerged channel coverage and vertical datum have not been independently verified. ${missing} missing cells are explicitly masked and excluded from flow. No bathymetry has been invented. A hypothetical local wave test, not a coupled offshore tsunami or hazard prediction.` };
    fs.writeFileSync(path.resolve(__dirname, `../viewer/public/tsunami-data/${id}.json`), JSON.stringify(data) + '\n');
    console.log(`${name}: ${elevation.length} cells; ${Math.min(...elevation.filter(Number.isFinite))} to ${Math.max(...elevation.filter(Number.isFinite))} m; ${missing} missing cells excluded`);
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
