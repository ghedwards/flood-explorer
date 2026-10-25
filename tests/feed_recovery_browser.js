// Run after node scripts/build-desktop.js (runtime broker mode).
const { chromium } = require('playwright');
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const root = path.resolve(__dirname, '../site');
const output = path.resolve(__dirname, '../work/feed-recovery');
fs.mkdirSync(output, { recursive: true });

async function main() {
  const server = http.createServer((req, res) => {
    const file = path.resolve(root, '.' + new URL(req.url, 'http://localhost').pathname.replace(/\/$/, '/index.html'));
    if (!file.startsWith(root + path.sep) || !fs.existsSync(file)) {
      res.writeHead(404).end();
      return;
    }
    const types = { '.js': 'text/javascript', '.json': 'application/json', '.html': 'text/html', '.css': 'text/css', '.wasm': 'application/wasm' };
    res.setHeader('content-type', types[path.extname(file)] || 'application/octet-stream');
    res.end(fs.readFileSync(file));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  let browser;
  try {
    browser = await chromium.launch();
    const context = await browser.newContext({ serviceWorkers: 'block', viewport: { width: 1440, height: 1000 } });
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    let mode = 'healthy', calls = 0;
    const fixture = {
      fetched: '2026-10-25T10:00:00Z', level: {}, storage: {}, watch: [],
      warnings: { ok: true, warnings: [] }, roads: { items: [] }, sources: {},
    };
    await context.route('**/*', route => {
      const url = new URL(route.request().url());
      if (url.pathname === '/v1/now') {
        calls++;
        if (mode === 'down') return route.fulfill({ status: 503, body: 'temporarily unavailable' });
        return route.fulfill({ json: mode === 'partial' ? {
          ...fixture, fetched: '2026-10-25T10:15:00Z', roads: { items: 'malformed' },
          sources: { qld: { lastError: 'upstream HTTP 429', lastGood: '2026-10-25T09:00:00Z' } },
        } : fixture });
      }
      return url.port === String(server.address().port) ? route.continue() : route.abort();
    });
    // Install before startup, since the client retains its timer functions.
    await page.clock.install();
    await page.goto(`http://127.0.0.1:${server.address().port}/`);
    await page.waitForFunction(() => window.__floodStatus?.national?.loaded);
    assert.equal(await page.evaluate(() => window.__floodStatus.national.readingsSource), 'runtime');

    mode = 'down';
    assert.equal(await page.evaluate(() => window.__floodRefreshLive(true)), 'error');
    await page.locator('#feedPill').waitFor({ state: 'visible' });
    await page.locator('#feedPill').click();
    assert.match(await page.locator('#feedStatus').innerText(), /503/);
    assert.match(await page.locator('#feedStatus').innerText(), /Retrying automatically/);
    assert.equal(await page.evaluate(() => window.__floodStatus.national.readingsSource), 'runtime');
    await page.screenshot({ path: path.join(output, 'outage.png') });

    const before = calls;
    mode = 'healthy';
    await page.clock.fastForward(45001);
    await page.waitForFunction(() => window.__floodStatus.feeds.error === null);
    assert.ok(calls > before);
    assert.equal(await page.locator('#feedPill').isVisible(), false);

    mode = 'partial';
    assert.equal(await page.evaluate(() => window.__floodRefreshLive(true)), 'new');
    assert.match(await page.locator('#feedStatus').innerText(), /Queensland river levels/);
    assert.match(await page.locator('#feedStatus').innerText(), /Invalid feed data/);
    await page.screenshot({ path: path.join(output, 'partial.png') });
    await page.setViewportSize({ width: 390, height: 844 });
    await page.screenshot({ path: path.join(output, 'mobile.png') });
    assert.deepEqual(errors, []);
    console.log(JSON.stringify({ outage: 'shown', automaticRecovery: 'passed', partialFailure: 'isolated', pageErrors: errors, calls }));
  } finally {
    if (browser) await browser.close();
    await new Promise(resolve => server.close(resolve));
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
