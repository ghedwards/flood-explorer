const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const { chromium } = require('playwright');
const site = path.resolve(__dirname, '../../site');

test('tsunami lab runs its Rust worker below a nested path, pauses, resets and exports', { timeout: 60000 }, async () => {
  const prefix = '/nested/flood/';
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://localhost');
    const file = path.resolve(site, url.pathname.slice(prefix.length));
    if (!url.pathname.startsWith(prefix) || !file.startsWith(site + path.sep) || !fs.existsSync(file)) {
      res.writeHead(404).end(); return;
    }
    res.setHeader('Content-Type', ({ '.js': 'text/javascript', '.css': 'text/css', '.html': 'text/html', '.wasm': 'application/wasm' })[path.extname(file)] || 'application/octet-stream');
    res.end(fs.readFileSync(file));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  let browser;
  try {
    browser = await chromium.launch();
    const context = await browser.newContext({ serviceWorkers: 'block' });
    const errors = [], external = [];
    await context.route('**/*', route => {
      if (new URL(route.request().url()).hostname !== '127.0.0.1') { external.push(route.request().url()); return route.abort(); }
      return route.continue();
    });
    const page = await context.newPage();
    page.on('pageerror', error => errors.push(error.message));
    await page.goto(`http://127.0.0.1:${server.address().port}${prefix}tsunami.html`);
    await page.waitForFunction(() => window.__tsunamiStatus?.().ready);
    assert.equal((await page.evaluate(() => window.__tsunamiStatus())).engine, 'rust-wasm');
    await page.locator('#step').click();
    await page.waitForFunction(() => window.__tsunamiStatus().time > 0);
    await page.locator('#play').click();
    await page.waitForFunction(() => window.__tsunamiStatus().time > 120);
    await page.locator('#play').click();
    assert.equal((await page.evaluate(() => window.__tsunamiStatus())).running, false);
    await page.locator('#view').selectOption('peak');
    assert.match(await page.locator('#legend').innerText(), /maximum/);
    const download = page.waitForEvent('download');
    await page.locator('#export').click();
    assert.match(fs.readFileSync(await (await download).path(), 'utf8'), /seconds,gauge_1_m,gauge_2_m,gauge_3_m/);
    await page.locator('#preset').selectOption('island');
    await page.waitForFunction(() => window.__tsunamiStatus().ready && window.__tsunamiStatus().time === 0);
    await page.locator('#waveMap').focus();
    await page.keyboard.press('ArrowRight');
    await page.waitForFunction(() => window.__tsunamiStatus().ready && window.__tsunamiStatus().source[0] === 39);
    await page.locator('#method').selectOption('finite-volume');
    await page.waitForFunction(() => window.__tsunamiStatus().ready && window.__tsunamiStatus().time === 0);
    await page.locator('#step').click();
    await page.waitForFunction(() => window.__tsunamiStatus().time > 0);
    for (const coast of (await import('../../viewer/tsunami-locations.js')).regionalIds) {
      await page.locator('#preset').selectOption(coast);
      await page.waitForFunction(id => window.__tsunamiStatus().ready && window.__tsunamiStatus().coast === id, coast);
      assert.match(await page.locator('#dataCredit').innerText(), /2009/);
      assert.equal(await page.locator('#deep').isDisabled(), true);
      await page.locator('#step').click();
      await page.waitForFunction(() => window.__tsunamiStatus().time > 0);
    }
    await page.locator('#preset').selectOption('estuary');
    await page.waitForFunction(() => window.__tsunamiStatus().ready && window.__tsunamiStatus().method === 'nonlinear');
    assert.equal(await page.locator('#inundationControls').isVisible(), true);
    assert.equal(await page.locator('#lakeControl').isVisible(), true);
    await page.locator('#speed').selectOption('15');
    await page.locator('#play').click();
    await page.waitForFunction(() => window.__tsunamiStatus().time > 180);
    await page.locator('#play').click();
    const flooded = await page.evaluate(() => window.__tsunamiStatus());
    assert.ok(flooded.flooded > 0);
    assert.ok(flooded.maxSpeed > 0);
    assert.ok(Math.abs(flooded.volumeError) < 1e-4);
    await page.locator('#view').selectOption('depth');
    assert.match(await page.locator('#legend').innerText(), /water depth/);
    await page.locator('#view').selectOption('speed');
    assert.match(await page.locator('#legend').innerText(), /current speed/);
    for (const coast of (await import('../../viewer/tsunami-locations.js')).estuaryIds) {
      await page.locator('#preset').selectOption(coast);
      await page.waitForFunction(id => window.__tsunamiStatus().ready && window.__tsunamiStatus().coast === id, coast);
      assert.equal(await page.locator('#lakeControl').isVisible(), false);
      assert.match(await page.locator('#dataCredit').innerText(), /Not specified/);
      assert.equal(await page.locator('#terrainTerms').isVisible(), true);
      assert.match(await page.locator('#placeContext').innerText(), /Gazetteer/);
      await page.locator('#step').click();
      await page.waitForFunction(() => window.__tsunamiStatus().time > 0);
    }
    await page.locator('#preset').selectOption('shelf');
    await page.waitForFunction(() => window.__tsunamiStatus().ready && window.__tsunamiStatus().method === 'staggered');
    assert.equal(await page.locator('#inundationControls').isVisible(), false);
    assert.equal(await page.locator('#view').inputValue(), 'surface');
    assert.equal(await page.locator('#width').inputValue(), '10');
    await page.setViewportSize({ width: 390, height: 844 });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    assert.deepEqual(external, []);
    assert.deepEqual(errors, []);
  } finally {
    if (browser) await browser.close();
    await new Promise(resolve => server.close(resolve));
  }
});
