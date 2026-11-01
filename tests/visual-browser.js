// Deterministic visual checks of the built viewer; no external request is sent.
const { chromium } = require('playwright');
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const { PNG } = require('pngjs');
const { floatTiff, overpassFor } = require('./impact-browser.js');
const { compareVisual } = require('./visual-compare.js');
const F = require('./model.js');
const root = path.resolve(__dirname, '../site');
const baselineDir = path.join(__dirname, 'visual');
const update = process.argv.includes('--update');
const hideFlood = process.argv.includes('--hide-flood');
const outputDir = path.resolve(hideFlood ? 'test-results/visual-regression-proof' : 'test-results/visual');
const playwrightVersion = require('playwright/package.json').version;
const fixedTime = '2026-01-15T02:00:00Z';

// A deliberately synthetic, repeated street tile: no live imagery, fonts or labels.
function tile() {
  const png = new PNG({ width: 256, height: 256 });
  for (let y = 0; y < 256; y++) for (let x = 0; x < 256; x++) {
    const road = x % 64 < 4 || y % 64 < 4;
    const park = x > 135 && x < 188 && y > 135 && y < 188;
    const color = road ? [247, 245, 234] : park ? [186, 207, 171] : [216, 219, 204];
    const i = (y * 256 + x) * 4;
    png.data.set([...color, 255], i);
  }
  return PNG.sync.write(png);
}
function dataFixtures() {
  const points = [
    [153.02, -27.47, 'brisbane', 'Brisbane (Brisbane River)', 'forecast'],
    [151.21, -33.86, 'sydney', 'Sydney Harbour', 'tide'],
    [144.96, -37.81, 'melbourne', 'Melbourne (Yarra River)', 'forecast'],
    [115.86, -31.95, 'perth', 'Perth (Swan River)', 'forecast'],
    [130.84, -12.46, 'darwin', 'Darwin Harbour', 'tide'],
    [138.60, -34.93, 'adelaide', 'Adelaide (Torrens River)', 'forecast'],
  ];
  const empty = { type: 'FeatureCollection', features: [] };
  return {
    'areas.json': [], 'floodhub.json': { configured: false },
    'national/gauges-core.min.json': { keys: ['station', 'name', 'kind'], rows: points },
    'national/gauges-river.min.json': { keys: [], rows: [] },
    'national/storages.geojson': empty,
    'national/meta.json': { gauges: points.length, storages: 0 },
    'national/readings.json': { fetched: fixedTime, level: {}, storage: {}, warnings: [], floodclass: {}, watch: [] },
    'events.json': { events: [] }, 'ratings.json': { ratings: {} },
    'workers.json': {}, 'osm/index.json': [], 'dea/dea.json': {},
    'council/council.json': { layers: {} }, 'levees.geojson': empty,
  };
}

async function main() {
  if (update && process.env.CI) throw new Error('Baseline updates are disabled in CI');
  if (update && hideFlood) throw new Error('Do not update baselines with an intentional regression');
  if (!update) {
    const metadata = JSON.parse(fs.readFileSync(path.join(baselineDir, 'metadata.json'), 'utf8'));
    assert.equal(metadata.playwright, playwrightVersion, 'Playwright version changed; regenerate/review the baselines');
  }
  fs.rmSync(outputDir, { recursive: true, force: true });
  const server = http.createServer((req, res) => {
    const file = path.resolve(root, '.' + new URL(req.url, 'http://localhost').pathname.replace(/\/$/, '/index.html'));
    if (!file.startsWith(root + path.sep) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) { res.writeHead(404).end(); return; }
    const types = { '.js': 'text/javascript', '.json': 'application/json', '.html': 'text/html', '.css': 'text/css', '.wasm': 'application/wasm', '.woff2': 'font/woff2' };
    res.setHeader('content-type', types[path.extname(file)] || 'application/octet-stream');
    res.end(fs.readFileSync(file));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  let browser;
  try {
    browser = await chromium.launch();
    const context = await browser.newContext({ viewport: { width: 960, height: 640 }, deviceScaleFactor: 1,
      serviceWorkers: 'block', locale: 'en-AU', timezoneId: 'Australia/Brisbane', colorScheme: 'light', reducedMotion: 'reduce' });
    const page = await context.newPage();
    const fixtures = dataFixtures(), tilePng = tile(), errors = [], failures = [];
    let tiles = 0, elevation = 0, osm = 0;
    page.on('pageerror', error => errors.push(error.stack || error.message));
    // Advance normally from a fixed epoch: freezing Date.now would prevent
    // Leaflet's JavaScript tile fades from ever completing.
    await page.clock.install({ time: fixedTime });
    await context.route('**/*', route => {
      const request = route.request(), url = new URL(request.url());
      if (url.origin === origin) {
        if (url.pathname.startsWith('/data/')) {
          const data = fixtures[url.pathname.slice('/data/'.length)];
          return route.fulfill({ status: data === undefined ? 404 : 200, contentType: 'application/json', body: JSON.stringify(data ?? {}) });
        }
        return route.continue();
      }
      if (url.hostname === 'services.ga.gov.au' && /WCSServer/.test(url.pathname) && /DEM_SRTM/.test(url.pathname)) {
        elevation++;
        const W = Number(url.searchParams.get('width') || url.searchParams.get('WIDTH')) || 667;
        const H = Number(url.searchParams.get('height') || url.searchParams.get('HEIGHT')) || W;
        return route.fulfill({ contentType: 'image/tiff', body: floatTiff(W, H, F.syntheticTerrain({ W, H, cell: 30 }).dem) });
      }
      if (/overpass|maps\.mail\.ru/.test(url.hostname)) {
        osm++;
        const query = new URLSearchParams(request.postData() || '').get('data') || '';
        return route.fulfill({ contentType: 'application/json', body: JSON.stringify(overpassFor(query)) });
      }
      if (/arcgisonline\.com$|cartocdn\.com$|tile\.openstreetmap\.org$/.test(url.hostname) && /\/tile\/|\.png|\.jpg/.test(url.pathname)) {
        tiles++;
        return route.fulfill({ contentType: 'image/png', headers: { 'access-control-allow-origin': '*' }, body: tilePng });
      }
      return route.abort();
    });
    // Capture the actual map layers only. Floating panels and map controls are
    // outside this visual contract; their text and fonts vary between platforms.
    const screenshotStyle = `body > :not(#mapWrap) { visibility: hidden !important; }
      #mapWrap > :not(#lmap), .leaflet-control-container, .leaflet-tooltip-pane,
      .leaflet-popup-pane, .edge-cue, .report-pin, .map-fab { visibility: hidden !important; }`;
    const settle = async () => {
      await page.evaluate(async () => {
        await document.fonts.ready;
        const map = window.__floodMap;
        await Promise.all(Object.values(map._layers).filter(layer => layer._image && layer._image.decode).map(layer => layer._image.decode().catch(() => {})));
        await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      });
      await page.waitForFunction(() => Object.values(window.__floodMap._layers).every(layer => !layer.isLoading || !layer.isLoading()));
      await page.waitForFunction(() => [...document.querySelectorAll('#lmap .leaflet-tile')].every(image =>
        image.complete && image.naturalWidth > 0 && Number(getComputedStyle(image).opacity) === 1));
    };
    const snap = async name => {
      await settle();
      let actual, previous, stable = false;
      for (let attempt = 0; attempt < 20; attempt++) {
        actual = await page.locator('#lmap').screenshot({ animations: 'disabled', caret: 'hide', scale: 'css', style: screenshotStyle });
        if (previous && actual.equals(previous)) { stable = true; break; }
        previous = actual;
      }
      assert.ok(stable, `${name}: map pixels did not settle`);
      try {
        const result = compareVisual(name, actual, { baselineDir, outputDir, update, maxFraction: name === 'national' ? 0.00005 : 0.005 });
        console.log(`${name}: ${result.updated ? 'baseline updated' : `${(result.fraction * 100).toFixed(3)}% changed`}`);
      } catch (error) { failures.push(error.message); }
    };
    await page.goto(`${origin}/?data=build`, { waitUntil: 'load' });
    await page.waitForFunction(() => window.__floodStatus?.national?.loaded && window.__floodStatus.mode === 'map' && window.FloodCore.engine === 'rust');
    await page.evaluate(() => window.__floodTestZoom(-28, 134, 4));
    await page.waitForFunction(() => window.__floodStatus.basemaps['Satellite (Esri)'].loaded > 0);
    await snap('national');
    assert.ok(tiles > 0, 'fixture basemap tiles were requested');
    assert.equal(await page.evaluate(() => window.__floodStatus.national.gauges), 6);

    assert.equal(await page.evaluate(() => window.__floodModelHere(-27.47, 153.02, { kind: 'river', name: 'Visual test town' })), true);
    await page.evaluate(() => {
      const input = document.getElementById('gaugeLevel');
      window.__floodSetLevel(+input.min + 0.6 * (+input.max - +input.min));
      const [lat, lon] = window.__floodGaugeLatLng();
      window.__floodTestZoom(lat, lon, 12);
    });
    await page.waitForFunction(() => window.__floodAreaInfo().some(area => area.active && area.drawn) && window.__floodStatus.floodPixels > 0);
    if (hideFlood) await page.addStyleTag({ content: '.flood-layer { visibility: hidden !important; }' });
    await snap('river-depth');
    await page.evaluate(() => window.__floodColorMode('hazard'));
    await snap('river-hazard');
    await page.evaluate(async () => {
      window.__floodColorMode('depth');
      await window.__floodCountImpact();
      window.__floodSetOverlay('Flooded (red) and cut-off (orange) roads', true);
    });
    await page.waitForFunction(() => window.__floodStatus.impact?.bWet > 0 && window.__floodStatus.impactTiming?.cutSegs > 0);
    await snap('impact');
    const timeline = await page.evaluate(() => window.__floodRunTimeline());
    assert.ok(timeline?.steps > 20);
    await page.evaluate(steps => window.__floodTimeStep(Math.floor(steps * 0.35)), timeline.steps);
    await page.waitForTimeout(200); // allow the app's 150 ms impact debounce, not live-network settling
    await snap('timeline');
    assert.ok(elevation > 0 && osm > 0, 'synthetic terrain and impact fixtures were consumed');
    assert.deepEqual(errors, [], 'no page errors');
    if (failures.length) throw new Error(failures.join('\n'));
    if (update) fs.writeFileSync(path.join(baselineDir, 'metadata.json'), JSON.stringify({
      playwright: playwrightVersion, chromium: browser.version(), platform: `${process.platform}/${process.arch}`,
      viewport: { width: 960, height: 640 }, deviceScaleFactor: 1, fixedTime,
      scenes: ['national', 'river-depth', 'river-hazard', 'impact', 'timeline'],
    }, null, 2) + '\n');
    console.log(`Visual checks passed (${browser.version()}, ${process.platform}/${process.arch}); no live services used.`);
  } finally {
    if (browser) await browser.close();
    await new Promise(resolve => server.close(resolve));
  }
}
if (require.main === module) main().catch(error => { console.error(error); process.exitCode = 1; });
module.exports = { dataFixtures, tile };
