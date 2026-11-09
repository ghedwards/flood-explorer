// Address search and the Watch list, end to end in a real browser on the built site, with no live services: the
// Queensland address service, Nominatim and the national data files are answered here. It checks
//   - the pick list while typing (one debounced suggestion call, picking asks for the place)
//   - links that open a place: ?address=..., ?lat=...&lon=..., a position outside Australia, an address with no match
//   - the search results sitting above the side panels (the top bar's stacking order)
//   - what clicking each kind of Watch list item does: a flood gauge the gauge layer lacks, one with no position
//     at all, a heavy-rain gauge and a closed road
//
//   npm run build && node tests/ui-browser.js
//
// Needs Playwright's Chromium. Serves the built site/ itself, or uses BASE_URL (for example a running `npm run serve`).
const { chromium } = require('playwright');
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const root = path.resolve(__dirname, '../site');

const json = (body) => ({ contentType: 'application/json', headers: { 'access-control-allow-origin': '*' }, body: JSON.stringify(body) });
const at = new Date(Date.now() - 3600e3).toISOString();

// the national data the page reads: one river gauge, and a Watch list with one of each kind of item
const NATIONAL = {
  'gauges-core.min.json': { keys: ['id', 'name', 'state', 'kind', 'bom', 'station'], rows: [[153.0, -27.5, 'g1', 'Brisbane River', 'QLD', 'river', '540100', '143001C']] },
  'storages.geojson': { type: 'FeatureCollection', features: [] },
  'meta.json': {},
  'readings.json': {
    level: {}, storage: {},
    watch: [
      { kind: 'flood', station: '422314', name: 'Condamine River at Ranges Bridge', level: 6.1, at, why: ['Minor flooding now, rising (Bureau of Meteorology)'] },
      { kind: 'flood', station: '999999', name: 'Nowhere Creek', level: 2, at, why: ['Minor flooding now'] },
      { kind: 'rainObs', station: 'R1', name: 'Mt Tamborine rain gauge', lat: -27.9, lon: 153.2, mm24h: 180, at, why: ['180 mm of rain recorded in the last 24 hours (60 mm in the last 6 hours)'] },
      { kind: 'road', station: 'r9', name: 'Bruce Highway (Gympie)', lat: -26.2, lon: 152.7, at, link: 'https://qldtraffic.qld.gov.au/x', why: ['Closed (QLD)'] },
    ],
  },
  'floodclass.json': { 422314: { name: 'Condamine River at Ranges Bridge', class: 'Minor', tendency: 'rising', level: 6.1, at, lat: -27.4, lon: 151.9 } },
};

async function main() {
  let server = null, base = process.env.BASE_URL;
  if (!base) {
    server = http.createServer((req, res) => {
      const file = path.resolve(root, '.' + new URL(req.url, 'http://localhost').pathname.replace(/\/$/, '/index.html'));
      if (!file.startsWith(root + path.sep) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) { res.writeHead(404).end(); return; }
      const types = { '.js': 'text/javascript', '.json': 'application/json', '.html': 'text/html', '.css': 'text/css', '.wasm': 'application/wasm', '.woff2': 'font/woff2' };
      res.setHeader('content-type', types[path.extname(file)] || 'application/octet-stream');
      res.end(fs.readFileSync(file));
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    base = `http://127.0.0.1:${server.address().port}/`;
  }
  const browser = await chromium.launch();
  try {
    // a page whose address services answer as given; `calls` records what it asked
    const open = async (query, { qld, nominatim }) => {
      const context = await browser.newContext({ serviceWorkers: 'block', viewport: { width: 1280, height: 800 } });
      const page = await context.newPage();
      const calls = [], errors = [];
      page.on('pageerror', (e) => errors.push(e.message));
      await context.route('**/*', (route) => {
        const url = new URL(route.request().url());
        if (url.hostname === '127.0.0.1' || url.hostname === 'localhost') {
          const national = /\/data\/national\/([^/]+)$/.exec(url.pathname);
          if (national) return NATIONAL[national[1]] ? route.fulfill(json(NATIONAL[national[1]])) : route.fulfill({ status: 404, body: '' });
          return route.continue();
        }
        if (/QldCompositeLocator/.test(url.pathname)) {
          const op = url.pathname.split('/').pop();
          const key = url.searchParams.get('magicKey');
          calls.push(`qld:${op}:${key ? `key ${key}` : url.searchParams.get('text') || url.searchParams.get('SingleLine')}`);
          return route.fulfill(json(op === 'suggest' ? qld.suggest : qld.find));
        }
        if (url.hostname === 'nominatim.openstreetmap.org') { calls.push('nominatim'); return route.fulfill(json(nominatim || [])); }
        return route.abort();
      });
      await page.goto(base + query, { waitUntil: 'load' });
      await page.waitForFunction("window.__floodStatus && window.__floodStatus.mode === 'map' && document.getElementById('busy').hidden", null, { timeout: 90000 });
      return { page, calls, errors, close: () => context.close() };
    };
    const found = { candidates: [{ address: '10 Concorde Drive, Loganholme, Logan City, QLD', location: { x: 153.18213, y: -27.68401 }, score: 100 }] };
    const none = { candidates: [] };
    const deep = async (page) => { await page.waitForFunction('window.__floodStatus.deepLink', null, { timeout: 30000 }); return page.evaluate(() => window.__floodStatus.deepLink); };

    // ---- links that open a place
    let t = await open('?address=10+Concorde+Drive+Loganholme', { qld: { find: found } });
    let dl = await deep(t.page);
    assert.ok(dl.ok && Math.abs(dl.lat + 27.68401) < 1e-6 && Math.abs(dl.lon - 153.18213) < 1e-6, `a Queensland address is placed: ${JSON.stringify(dl)}`);
    assert.deepEqual(t.calls, ['qld:findAddressCandidates:10 Concorde Drive Loganholme'], 'the Queensland service answered, so Nominatim was not asked');
    assert.equal(await t.page.inputValue('#searchInput'), '10 Concorde Drive Loganholme', 'the search box shows what was opened');
    await t.close();

    t = await open('?address=Lismore+NSW', { qld: { find: none }, nominatim: [{ lat: '-28.81', lon: '153.28', display_name: 'Lismore, Lismore City, NSW' }] });
    dl = await deep(t.page);
    assert.ok(dl.ok && Math.abs(dl.lat + 28.81) < 1e-6, `an address the Queensland service lacks falls through to Nominatim: ${JSON.stringify(dl)}`);
    assert.deepEqual(t.calls, ['qld:findAddressCandidates:Lismore NSW', 'nominatim'], 'one Queensland call, then one Nominatim call');
    await t.close();

    t = await open('?lat=-27.684&lon=153.182&name=Loganholme', { qld: { find: found } });
    dl = await deep(t.page);
    assert.ok(dl.ok && dl.lat === -27.684 && dl.lon === 153.182 && t.calls.length === 0, `a position needs no lookup: ${JSON.stringify(dl)} ${t.calls}`);
    assert.equal(await t.page.inputValue('#searchInput'), 'Loganholme');
    await t.close();

    t = await open('?lat=51.5&lon=-0.1', { qld: { find: found } });
    dl = await deep(t.page);
    assert.ok(dl.ok === false && /outside Australia/.test(dl.why) && t.calls.length === 0, `a position outside Australia is refused: ${JSON.stringify(dl)}`);
    await t.close();

    t = await open('?address=zzzz+nowhere', { qld: { find: none }, nominatim: [] });
    dl = await deep(t.page);
    assert.ok(dl.ok === false && dl.why === 'no match', `an address with no match is reported: ${JSON.stringify(dl)}`);
    await t.close();

    // ---- the pick list while typing, and its place above the side panels
    t = await open('', { qld: { suggest: { suggestions: [1, 2, 3].map((i) => ({ text: `${i} Concorde Drive, Loganholme, Logan City, QLD`, magicKey: `k${i}` })) }, find: found } });
    await t.page.evaluate(() => { const b = document.querySelector('[data-open="panel-scenario"]'); if (b && b.getAttribute('aria-pressed') !== 'true') b.click(); });
    await t.page.type('#searchInput', '1 concorde', { delay: 30 });
    await t.page.waitForSelector('#searchResults [data-s]', { timeout: 15000 });
    assert.equal(await t.page.locator('#searchResults [data-s]').count(), 3, 'every suggestion is listed');
    assert.equal(t.calls.filter((c) => c.startsWith('qld:suggest')).length, 1, `typing is debounced to one suggestion call: ${t.calls}`);
    const z = await t.page.evaluate(() => {
      const zi = (el) => Number(getComputedStyle(el).zIndex);
      const panels = [...document.querySelectorAll('.left-col, .sheet')].map((p) => ({ cls: p.className, z: zi(p), shown: p.getBoundingClientRect().width > 0 }));
      return { bar: zi(document.querySelector('.topbar')), panels: panels.filter((p) => p.shown) };
    });
    assert.ok(z.panels.length > 0 && z.panels.every((p) => z.bar > p.z), `the top bar, which holds the results, is above every open side panel while results show: ${JSON.stringify(z)}`);
    const box = await t.page.evaluate(() => { const r = document.getElementById('searchResults').getBoundingClientRect(), f = document.getElementById('searchForm').getBoundingClientRect(); return { w: r.width, left: r.left, formLeft: f.left }; });
    assert.ok(box.w <= 441 && Math.abs(box.left - box.formLeft) < 2, `the results are no wider than 440 px and start at the search box: ${JSON.stringify(box)}`);
    await t.page.locator('#searchResults [data-s]').nth(1).click();
    await t.page.waitForFunction('window.__floodStatus.searchHit || window.__floodStatus.search || document.getElementById("searchInput").value.startsWith("2 Concorde")', null, { timeout: 15000 });
    assert.equal(await t.page.inputValue('#searchInput'), '2 Concorde Drive, Loganholme, Logan City, QLD', 'picking a suggestion fills the box');
    assert.ok(t.calls.includes('qld:findAddressCandidates:key k2'), `picking asks for that suggestion's place: ${t.calls}`);
    await t.close();

    // ---- what clicking each kind of Watch list item does
    t = await open('', { qld: { find: found } });
    const click = async (i) => { await t.page.evaluate((k) => window.__floodOpenWatch(k), i); await t.page.waitForTimeout(700); return t.page.evaluate(() => ({ status: window.__floodStatus.watchOpen, popup: (document.querySelector('.leaflet-popup-content') || {}).innerText || null, link: (document.querySelector('.leaflet-popup-content a') || {}).href || null })); };
    let w = await click(0);
    assert.equal(w.status.fallback, 'flood class position', `a flood gauge the gauge layer lacks opens at the Bureau feed's position: ${JSON.stringify(w)}`);
    assert.match(w.popup, /Condamine River at Ranges Bridge/); assert.match(w.popup, /6\.10 m on the gauge board, Minor flooding, rising/); assert.match(w.popup, /not in the map's gauge layer/);
    w = await click(1);
    assert.equal(w.status.notFound, true, `a gauge with no position anywhere says so: ${JSON.stringify(w)}`);
    w = await click(2);
    assert.equal(w.status.kind, 'rainObs', 'a heavy-rain gauge opens at its own position');
    assert.match(w.popup, /Mt Tamborine rain gauge/); assert.match(w.popup, /180 mm of rain recorded/);
    w = await click(3);
    assert.equal(w.status.kind, 'road', 'a closed road opens at its own position');
    assert.match(w.popup, /Bruce Highway \(Gympie\)/); assert.equal(w.link, 'https://qldtraffic.qld.gov.au/x', 'with the report link');
    assert.deepEqual(t.errors, [], 'no page errors');
    await t.close();
    console.log('Address search, links and the Watch list: all checks passed');
  } finally {
    await browser.close();
    if (server) await new Promise((resolve) => server.close(resolve));
  }
}
main().catch((e) => { console.error(e); process.exit(1); });
