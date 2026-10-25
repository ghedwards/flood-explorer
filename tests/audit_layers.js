// Live integration audit. Run with: node tests/audit_layers.js [output directory]
// Uses the real built viewer, real source services, and an isolated browser profile.
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const { chromium } = require('playwright');
const { PNG } = require('pngjs');
const root = path.resolve(__dirname, '..');
const out = path.resolve(process.argv[2] || path.join(root, 'work/layer-audit'));
fs.mkdirSync(out, { recursive: true });
const results = [];
let active = null;
const only = process.env.AUDIT_ONLY ? new Set(process.env.AUDIT_ONLY.split('|')) : null;
const exportsSeen = [];
const errors = [];
const save = row => {
  results.push(row);
  fs.writeFileSync(path.join(out, 'results.json'), JSON.stringify({ checkedAt: new Date().toISOString(), engine: 'Chromium', results, errors }, null, 2));
  console.log(JSON.stringify(row));
};
const safe = text => text.replace(/[^a-z0-9]+/gi, '-').slice(0, 90);
function changed(a, b) {
  const x = PNG.sync.read(a), y = PNG.sync.read(b);
  let n = 0;
  for (let i = 0; i < x.data.length; i += 4) {
    if (Math.abs(x.data[i] - y.data[i]) + Math.abs(x.data[i + 1] - y.data[i + 1]) + Math.abs(x.data[i + 2] - y.data[i + 2]) > 35) n++;
  }
  return n;
}
async function main() {
  const site = path.join(root, 'site');
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://localhost');
    const file = path.resolve(site, '.' + decodeURIComponent(url.pathname).replace(/\/$/, '/index.html'));
    if (!file.startsWith(site + path.sep) || !fs.existsSync(file) || !fs.statSync(file).isFile()) { res.writeHead(404).end(); return; }
    res.setHeader('Content-Type', ({ '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.wasm': 'application/wasm', '.png': 'image/png', '.woff2': 'font/woff2' })[path.extname(file)] || 'application/octet-stream');
    res.end(fs.readFileSync(file));
  });
  await new Promise(resolve => server.listen(1430, '127.0.0.1', resolve));
  const browser = await chromium.launch();
  try {
    const context = await browser.newContext({ viewport: { width: 1100, height: 800 }, serviceWorkers: 'block' });
    const page = await context.newPage();
    page.on('response', async response => {
      if (!response.url().includes('/export?')) return;
      const layer = active;
      try {
        const data = await response.body();
        let alphaPixels = null;
        try { const png = PNG.sync.read(data); alphaPixels = 0; for (let i = 3; i < png.data.length; i += 4) if (png.data[i]) alphaPixels++; } catch { /* service may return an error document */ }
        exportsSeen.push({ layer, url: response.url(), status: response.status(), type: response.headers()['content-type'], alphaPixels, sample: alphaPixels === null ? data.toString().slice(0, 100) : undefined });
      } catch { /* cancelled export */ }
    });
    page.on('pageerror', e => errors.push({ layer: active, message: e.message }));
    page.on('response', r => { if (r.status() >= 400 && !r.url().startsWith('http://127.0.0.1:1430')) errors.push({ layer: active, status: r.status(), url: r.url() }); });
    page.on('requestfailed', req => { if (!req.failure()?.errorText.includes('ABORTED')) errors.push({ layer: active, url: req.url(), message: req.failure()?.errorText }); });
    await page.goto('http://127.0.0.1:1430', { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => window.__floodStatus?.national?.loaded && window.__floodTestZoom, null, { timeout: 30000 });
    await page.evaluate(() => window.__floodRefreshLive(true));
    await page.addStyleTag({ content: '.topbar,.rail,.left-col,.sheet,.legend-card,.leaflet-control-attribution,.readout,.map-fab { visibility:hidden!important }' });
    const inventory = await page.evaluate(() => ({ basemaps: Object.keys(window.__floodStatus.basemaps), overlays: [...document.querySelectorAll('#overlayList input')].map(el => el.dataset.layer), councils: window.__floodCouncilLayers(), status: window.__floodStatus }));
    fs.writeFileSync(path.join(out, 'inventory.json'), JSON.stringify(inventory, null, 2));
    const zoom = async (lat, lon, z) => { await page.evaluate(args => window.__floodTestZoom(...args), [lat, lon, z]); await page.waitForTimeout(900); };
    const disableAll = async () => page.evaluate(() => { for (const el of document.querySelectorAll('#overlayList input')) window.__floodSetOverlay(el.dataset.layer, false); });
    await disableAll(); await zoom(-27.47, 153.02, 12);
    for (const name of inventory.basemaps.filter(n => !only || only.has(n))) {
      active = name;
      const before = await page.evaluate(n => ({ ...window.__floodStatus.basemaps[n] }), name);
      await page.evaluate(n => window.__floodSetBasemap(n), name);
      try { await page.waitForFunction(n => window.__floodStatus.basemaps[n].loaded > 0, name, { timeout: 20000 }); } catch { /* captured below */ }
      await page.waitForTimeout(700);
      const status = await page.evaluate(n => window.__floodStatus.basemaps[n], name);
      const screenshot = safe(name) + '.png'; await page.screenshot({ path: path.join(out, screenshot) });
      save({ name, type: 'basemap', result: status.loaded > 0 ? (status.errors ? 'partial' : 'loaded') : 'failed', status, before, location: [-27.47, 153.02, 12], screenshot });
    }
    await page.evaluate(() => window.__floodSetBasemap('Streets'));
    const places = {
      'Queensland floodplain assessment (state)': [-20.86, 147.88, 10],
      'Emergency warnings (state)': [-34.4204, 146.2653, 10],
      'NSW flood planning areas (state)': [-34.185, 142.115, 14],
      'Queensland storm tide hazard areas (state)': [-27.19, 153.08, 12],
      'Queensland recorded floods, 1974–2019 (state)': [-27.47, 153.02, 13],
      'Victorian recorded floods (state)': [-36.13, 144.75, 13],
    };
    const liveNames = inventory.overlays.filter(n => !inventory.councils.some(c => c.name === n) && !/\(state\)|\(DEA\)|\(council\)|^Recorded flood:/.test(n) && !n.startsWith('Flooded (red)'));
    for (const name of inventory.overlays.filter(n => n !== 'Flooded (red) and cut-off (orange) roads' && (!only || only.has(n)))) {
      active = name; await disableAll();
      const council = inventory.councils.find(c => c.name === name);
      const point = council ? [...council.test, Math.max(14, council.minZoom + 1)] : places[name] || (liveNames.includes(name) ? [-27, 136, 5] : [-27.47, 153.02, /likelihood|^Recorded flood:/.test(name) ? 15 : 12]);
      await zoom(...point); await page.waitForTimeout(600);
      const before = await page.screenshot();
      await page.evaluate(n => window.__floodSetOverlay(n, true), name);
      if (name.includes('Rain radar')) {
        try { await page.waitForFunction(() => window.__floodStatus.radar?.ok !== null, null, { timeout: 20000 }); } catch { /* captured below */ }
        await page.waitForTimeout(2500);
      } else if (!liveNames.includes(name)) {
        try { await page.waitForFunction(n => ['done', 'empty', 'error'].includes(window.__floodStatus.layerState?.[n]?.kind) || window.__floodStatus.overlays?.[n]?.features > 0, name, { timeout: 20000 }); } catch { /* captured below */ }
        await page.waitForTimeout(3000);
      } else await page.waitForTimeout(900);
      const after = await page.screenshot();
      const pixels = changed(before, after);
      const status = await page.evaluate(n => ({ overlay: window.__floodStatus.overlays?.[n], state: window.__floodStatus.layerState?.[n], radar: n.includes('Rain radar') ? window.__floodStatus.radar : undefined, national: window.__floodStatus.national, sea: window.__floodStatus.sea, warningAreas: window.__floodStatus.warningAreas, warnedGauges: window.__floodStatus.warnedGauges, roads: window.__floodStatus.roadClosures, emergency: window.__floodStatus.emergencyWarnings, rain: window.__floodStatus.rainObs }), name);
      const bad = status.state?.kind === 'error' || (status.radar && !status.radar.ok);
      const result = bad ? 'failed' : pixels > 40 ? (status.overlay?.errors ? 'partial' : 'rendered') : status.state?.kind === 'empty' ? 'no-features-in-view' : 'no-visible-change';
      const screenshot = safe(name) + '.png'; fs.writeFileSync(path.join(out, screenshot), after);
      save({ name, type: liveNames.includes(name) ? 'live' : 'overlay', result, changedPixels: pixels, status, location: point, screenshot, exports: exportsSeen.filter(x => x.layer === name) });
    }
    await disableAll();
    const roadsName = 'Flooded (red) and cut-off (orange) roads';
    if (!only || only.has(roadsName)) {
      active = roadsName;
      await page.evaluate(() => { window.__TAURI__ = { core: {} }; }); // use the desktop's real local elevation proxy
      await page.evaluate(() => window.__floodModelHere(-27.4741, 153.0305, { kind: 'river', name: 'Audit Brisbane', halfKm: 1, cellM: 30 }));
      const model = await page.evaluate(() => window.__floodStatus.local);
      if (model?.ok) {
        await page.evaluate(n => window.__floodSetOverlay(n, true), roadsName);
        try { await page.waitForFunction(n => ['done', 'error', 'note'].includes(window.__floodStatus.layerState?.[n]?.kind), roadsName, { timeout: 90000 }); } catch { /* reported below */ }
        const status = await page.evaluate(n => ({ model: window.__floodStatus.local, state: window.__floodStatus.layerState?.[n], impact: window.__floodStatus.impact }), roadsName);
        const screenshot = 'model-roads.png'; await page.screenshot({ path: path.join(out, screenshot) });
        save({ name: roadsName, type: 'model result / live Overpass', result: status.state?.kind === 'done' ? 'rendered' : 'failed', status, screenshot });
      } else save({ name: roadsName, type: 'model result', result: 'failed', status: model });
    }
    if (!only) save({ name: 'Google Flood Hub forecast layers', type: 'conditional', result: inventory.status.floodhub?.configured ? 'configured' : 'unavailable', status: inventory.status.floodhub, note: 'No configured Flood Hub dataset is bundled; these conditional layers cannot be rendered.' });

  } finally { await browser.close(); await new Promise(resolve => server.close(resolve)); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
