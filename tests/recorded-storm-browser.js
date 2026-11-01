// Recorded-storm selection through the real built app and 2D worker, offline.
const { chromium } = require('playwright');
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const { dataFixtures, tile } = require('./visual-browser.js');
const { floatTiff, overpassFor } = require('./impact-browser.js');
const snapshot = require('./fixtures/rainfall/storms.json');
const F = require('./model.js');
const root = path.resolve(__dirname, '../site');
(async () => {
  const server = http.createServer((req, res) => {
    const file = path.resolve(root, '.' + new URL(req.url, 'http://localhost').pathname.replace(/\/$/, '/index.html'));
    if (!file.startsWith(root + path.sep) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) { res.writeHead(404).end(); return; }
    const types = { '.js': 'text/javascript', '.html': 'text/html', '.css': 'text/css', '.wasm': 'application/wasm', '.woff2': 'font/woff2' };
    res.setHeader('content-type', types[path.extname(file)] || 'application/octet-stream'); res.end(fs.readFileSync(file));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  let browser;
  try {
    browser = await chromium.launch();
    const errors = [];
    for (const available of [true, false]) {
      const context = await browser.newContext({ serviceWorkers: 'block', viewport: { width: 1280, height: 900 } });
      const page = await context.newPage(), fixtures = dataFixtures(), tilePng = tile();
      if (available) fixtures['national/rain-storms.json'] = snapshot;
      page.on('pageerror', e => errors.push(e.stack || String(e)));
      await context.route('**/*', route => {
        const request = route.request(), url = new URL(request.url());
        if (url.origin === origin) {
          if (url.pathname.startsWith('/data/')) {
            const data = fixtures[url.pathname.slice(6)];
            return route.fulfill({ status: data === undefined ? 404 : 200, contentType: 'application/json', body: JSON.stringify(data ?? {}) });
          }
          return route.continue();
        }
        if (url.hostname === 'services.ga.gov.au' && /WCSServer/.test(url.pathname) && /DEM_SRTM/.test(url.pathname)) {
          const W = Number(url.searchParams.get('width')) || 667, H = Number(url.searchParams.get('height')) || W;
          return route.fulfill({ contentType: 'image/tiff', body: floatTiff(W, H, F.syntheticTerrain({ W, H, cell: 30 }).dem) });
        }
        if (/overpass|maps\.mail\.ru/.test(url.hostname)) return route.fulfill({ contentType: 'application/json', body: JSON.stringify(overpassFor(new URLSearchParams(request.postData() || '').get('data') || '')) });
        if (/arcgisonline\.com$/.test(url.hostname) && /\/tile\//.test(url.pathname)) return route.fulfill({ contentType: 'image/png', headers: { 'access-control-allow-origin': '*' }, body: tilePng });
        return route.abort();
      });
      await page.goto(`${origin}/?data=build`, { waitUntil: 'load' });
      await page.waitForFunction(() => window.__floodStatus?.mode === 'map' && window.FloodCore.engine === 'rust');
      assert.equal(await page.evaluate(() => window.__floodModelHere(-27.47,153.02,{kind:'river',name:'Recorded-rain test'})), true);
      await page.selectOption('#solver', 'inertial');
      if (!available) {
        await page.waitForSelector('#recordedRainUnavailable:not([hidden])');
        assert.equal(await page.isDisabled('#inertialRain'), false);
        assert.equal(await page.isDisabled('#recordedRainRunoff'), true);
        await context.close();
        continue;
      }
      await page.waitForSelector('#recordedRainControls:not([hidden])');
      await page.selectOption('#recordedRainEvent', 'test-storm');
      await page.fill('#recordedRainRunoff', '50');
      await page.fill('#inertialMinutes', '60');
      await page.selectOption('#inertialResolution', '96');
      assert.equal(await page.isDisabled('#inertialRain'), true);
      assert.match(await page.textContent('#recordedRainNote'), /10.0 mm observed, 5.0 mm effective/);
      fs.mkdirSync(path.resolve('test-results'), { recursive: true });
      await page.screenshot({ path: 'test-results/recorded-storm-picker.png' });
      await page.click('#inertialRun');
      await page.waitForFunction(() => window.__floodStatus.inertial && !window.__floodStatus.inertial.running, null, { timeout: 120000 });
      const result = await page.evaluate(() => window.__floodStatus.inertial);
      assert.equal(result.error, undefined);
      assert.equal(result.recordedStorm.start, '2022-02-23T14:00:00.000Z');
      assert.equal(result.recordedStorm.end, '2022-02-23T15:00:00.000Z');
      assert.equal(result.recordedStorm.effectiveMm, 5);
      assert.ok(result.sourceVolume > 0);
      assert.ok(Math.abs(result.balanceError) < result.sourceVolume * 1e-7);
      const cells = result.sourceVolume / (0.005 * result.cell * result.cell);
      assert.ok(Math.abs(cells - Math.round(cells)) < 1e-4 && cells <= result.W * result.H + 1e-4, JSON.stringify({cells, W:result.W, H:result.H, sourceVolume:result.sourceVolume, cell:result.cell}));
      assert.match(await page.textContent('#inertialStatus'), /24 Feb 2022.*AEST/);
      await page.selectOption('#recordedRainStart', '2');
      await page.fill('#inertialMinutes', '120');
      await page.click('#inertialRun');
      assert.match(await page.textContent('#inertialStatus'), /missing rainfall/);
      await page.selectOption('#recordedRainEvent', '');
      assert.equal(await page.isDisabled('#inertialRain'), false);
      assert.equal(await page.isDisabled('#recordedRainRunoff'), true);
      await context.close();
    }
    assert.deepEqual(errors, []);
    console.log('Recorded storm replay, runoff volume/time alignment, gap rejection and missing-data manual fallback passed.');
  } finally {
    if (browser) await browser.close();
    await new Promise(resolve => server.close(resolve));
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
