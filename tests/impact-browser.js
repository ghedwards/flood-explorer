// The flood-impact panel, the route to dry land and the flood-over-time analysis, end to end in a real browser on
// the built site, with no live services: the elevation service answers with a synthetic river valley (a GeoTIFF
// written here) and the OpenStreetMap service with a synthetic town (a street grid, buildings, a school and two
// evacuation centres). Everything else outside the page is refused. It exercises the Rust road network, impact
// sweep and access timeline as the page uses them.
//
//   npm run build && node tests/impact-browser.js
//
// Needs Playwright's Chromium (npx playwright install chromium). Serves the built site/ itself.
const { chromium } = require('playwright');
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const root = path.resolve(__dirname, '../site');

const rng = (seed) => () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296; };

// A single-band, uncompressed, stripped 32-bit float GeoTIFF: what the elevation service returns
function floatTiff(W, H, data) {
  const entries = [[256, 4, W], [257, 4, H], [258, 3, 32], [259, 3, 1], [262, 3, 1], [273, 4, 0], [277, 3, 1], [278, 4, H], [279, 4, W * H * 4], [339, 3, 3]];
  const ifdAt = 8, dataAt = ifdAt + 2 + entries.length * 12 + 4;
  const buf = Buffer.alloc(dataAt + W * H * 4);
  buf.write('II', 0); buf.writeUInt16LE(42, 2); buf.writeUInt32LE(ifdAt, 4);
  buf.writeUInt16LE(entries.length, ifdAt);
  entries.forEach(([tag, type, value], i) => {
    const at = ifdAt + 2 + i * 12;
    buf.writeUInt16LE(tag, at); buf.writeUInt16LE(type, at + 2); buf.writeUInt32LE(1, at + 4);
    if (type === 3) buf.writeUInt16LE(tag === 273 ? 0 : value, at + 8); else buf.writeUInt32LE(tag === 273 ? dataAt : value, at + 8);
  });
  for (let i = 0; i < W * H; i++) buf.writeFloatLE(data[i], dataAt + i * 4);
  return buf;
}

// An OpenStreetMap (Overpass) answer for the query's box: a street grid with shared nodes, 4,000 buildings, a school
// and two evacuation centres
function overpassFor(query) {
  const m = /\(([-\d.]+),([-\d.]+),([-\d.]+),([-\d.]+)\)/.exec(query);
  const [s, w, n, e] = m.slice(1).map(Number), r = rng(11), els = [], side = 36;
  const dlat = (n - s) / (side - 1), dlon = (e - w) / (side - 1), nid = (i, j) => 1000 + j * side + i;
  els.push({ type: 'marker', tags: { name: 'buildings' } });
  const homes = [], work = [];
  for (let k = 0; k < 4000; k++) {
    els.push({ type: 'way', id: 50000 + k, center: { lat: s + (n - s) * r(), lon: w + (e - w) * r() } });
    (r() < 0.8 ? homes : work).push(50000 + k);
  }
  els.push({ type: 'marker', tags: { name: 'homes' } }); homes.forEach((id) => els.push({ type: 'way', id }));
  els.push({ type: 'marker', tags: { name: 'work' } }); work.forEach((id) => els.push({ type: 'way', id }));
  els.push({ type: 'marker', tags: { name: 'roads' } });
  let wid = 1;
  for (let j = 0; j < side; j++) {
    const nodes = [], geometry = [];
    for (let i = 0; i < side; i++) { nodes.push(nid(i, j)); geometry.push({ lat: s + j * dlat, lon: w + i * dlon }); }
    els.push({ type: 'way', id: wid++, nodes, geometry, tags: { highway: 'residential', name: `Street ${j}` } });
  }
  for (let i = 0; i < side; i++) {
    const nodes = [], geometry = [];
    for (let j = 0; j < side; j++) { nodes.push(nid(i, j)); geometry.push({ lat: s + j * dlat, lon: w + i * dlon }); }
    els.push({ type: 'way', id: wid++, nodes, geometry, tags: { highway: 'secondary', name: `Avenue ${i}` } });
  }
  els.push({ type: 'marker', tags: { name: 'sites' } });
  els.push({ type: 'node', id: 9001, lat: s + (n - s) * 0.5, lon: w + (e - w) * 0.8, tags: { amenity: 'school', name: 'Test School' } });
  els.push({ type: 'node', id: 9002, lat: s + (n - s) * 0.7, lon: w + (e - w) * 0.75, tags: { emergency: 'evacuation_centre', name: 'Test Evacuation Centre' } });
  els.push({ type: 'node', id: 9003, lat: s + (n - s) * 0.3, lon: w + (e - w) * 0.25, tags: { emergency: 'evacuation_centre', name: 'West Hall' } });
  return { elements: els };
}

async function main() {
  const { F } = { F: require('./model.js') };
  const server = http.createServer((req, res) => {
    const file = path.resolve(root, '.' + new URL(req.url, 'http://localhost').pathname.replace(/\/$/, '/index.html'));
    if (!file.startsWith(root + path.sep) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) { res.writeHead(404).end(); return; }
    const types = { '.js': 'text/javascript', '.json': 'application/json', '.html': 'text/html', '.css': 'text/css', '.wasm': 'application/wasm', '.woff2': 'font/woff2' };
    res.setHeader('content-type', types[path.extname(file)] || 'application/octet-stream');
    res.end(fs.readFileSync(file));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}/`;
  let browser;
  try {
    browser = await chromium.launch();
    const context = await browser.newContext({ serviceWorkers: 'block', viewport: { width: 1300, height: 900 } });
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', (e) => errors.push((e.stack || e.message).split('\n').slice(0, 4).join(' | ')));
    const asked = { elevation: 0, osm: 0 };
    await context.route('**/*', (route) => {
      const url = new URL(route.request().url());
      if (url.hostname === '127.0.0.1') return route.continue();
      if (/services\.ga\.gov\.au/.test(url.hostname) && /WCSServer/.test(url.pathname) && /DEM_SRTM/.test(url.pathname)) {
        asked.elevation++;
        const W = Number(url.searchParams.get('width') || url.searchParams.get('WIDTH')) || 667, H = Number(url.searchParams.get('height') || url.searchParams.get('HEIGHT')) || W;
        const g = F.syntheticTerrain({ W, H, cell: 30 });
        return route.fulfill({ contentType: 'image/tiff', body: floatTiff(W, H, g.dem) });
      }
      if (/overpass|maps\.mail\.ru/.test(url.hostname)) {
        asked.osm++;
        const body = route.request().postData() || '';
        const q = decodeURIComponent((/data=([^&]*)/.exec(body) || [])[1] || '').replace(/\+/g, ' ');
        return route.fulfill({ contentType: 'application/json', body: JSON.stringify(overpassFor(q)) });
      }
      return route.abort();
    });
    await page.goto(base, { waitUntil: 'load' });
    await page.waitForFunction("window.__floodStatus && window.__floodStatus.mode === 'map' && window.FloodCore.engine === 'rust'", null, { timeout: 60000 });

    // a model on the synthetic valley, with the river high enough to flood part of the town
    const modelled = await page.evaluate(async () => window.__floodModelHere(-27.47, 153.02, { kind: 'river', name: 'Test town' }));
    assert.equal(modelled, true, 'the model was built');
    assert.ok(asked.elevation >= 1, 'the elevation service was asked');
    const gauge = await page.evaluate(() => window.__floodGaugeLatLng());
    assert.ok(Array.isArray(gauge), 'the model has a gauge');
    await page.evaluate(() => { const el = document.querySelector('#gaugeLevel'), lo = parseFloat(el.min), hi = parseFloat(el.max); return window.__floodSetLevel(lo + 0.6 * (hi - lo)); });

    // the impact panel
    const impact = await page.evaluate(async () => { await window.__floodCountImpact(); return { ...window.__floodStatus.impact, timing: window.__floodStatus.impactTiming }; });
    assert.ok(asked.osm >= 1, 'the OpenStreetMap service was asked');
    assert.equal(impact.error, undefined, `impact counted: ${JSON.stringify(impact)}`);
    assert.equal(impact.buildings, 4000, 'every building counted');
    assert.ok(impact.bWet > 0 && impact.bWet < 4000, `some but not all buildings flooded (${impact.bWet})`);
    assert.ok(impact.cutKm > 0, 'some road length is under water');
    assert.ok(impact.timing.sweepMs < 2000, `the sweep is quick (${impact.timing.sweepMs} ms)`);

    // the route to dry land, from a spot beside the river and from further away
    const routes = [];
    for (const [dla, dlo] of [[0, 0], [0.02, 0.02], [-0.03, 0.03], [0.05, -0.05]]) {
      routes.push(await page.evaluate(async ([la, lo]) => { await window.__floodCheckProperty(la, lo, 'test'); return window.__floodStatus.property; }, [gauge[0] + dla, gauge[1] + dlo]));
    }
    assert.ok(routes.every((r) => r.inModel), 'every spot is in the model');
    const withRoute = routes.filter((r) => r.route);
    assert.ok(withRoute.length >= 2, `routes were found for ${withRoute.length} of ${routes.length} spots`);
    assert.ok(withRoute.every((r) => r.route.exitKm === null || (r.route.exitKm > 0 && r.route.exitKm < 60)), 'route lengths are sensible: ' + JSON.stringify(routes.map((r) => r.route)));
    assert.ok(withRoute.some((r) => /Evacuation Centre|West Hall/.test(r.route.centre || '')), 'a route leads to an evacuation centre');

    // flood over time: roads close and places are cut off
    const timeline = await page.evaluate(async () => window.__floodRunTimeline());
    assert.ok(timeline && timeline.steps > 20, `a timeline was computed (${await page.evaluate(() => document.getElementById('timelineBox').textContent.slice(0, 200))})`);
    assert.ok(timeline.roadsClosed > 0 && timeline.maxIsolated >= 0, `the access analysis ran (${JSON.stringify(timeline)})`);

    // the tsunami hazard layer: PTHA18's offshore wave heights, loaded on first use and restyled by return period
    const name = 'Tsunami hazard: offshore wave height (PTHA18, experimental)';
    const hazardOn = await page.evaluate((layer) => window.__floodSetOverlay(layer, true), name);
    await page.waitForFunction("window.__floodStatus.tsunamiHazard && window.__floodStatus.tsunamiHazard.state === 'ready'", null, { timeout: 20000 });
    const hazard = await page.evaluate((layer) => {
      const first = { on: true, ...window.__floodStatus.tsunamiHazard, legend: document.getElementById('overlayLegend').textContent, control: !!document.querySelector('.tsunami-pick select') };
      window.__floodTestZoom(-28.5, 134, 4);
      const zoomedOut = window.__floodStatus.tsunamiHazard.shown;
      window.__floodTestZoom(-28, 153.9, 9);
      const zoomedIn = window.__floodStatus.tsunamiHazard.shown;
      const select = document.querySelector('.tsunami-pick select');
      select.value = '2500'; select.dispatchEvent(new Event('change'));
      const second = document.getElementById('overlayLegend').textContent;
      window.__floodSetOverlay(layer, false);
      return { first, second, pickerSynced: select.value === '2500', zoomedOut, zoomedIn };
    }, name);
    hazard.first.on = hazardOn;
    assert.ok(hazard.first.on && hazard.first.points > 1500, `the hazard layer loaded ${hazard.first.points} points`);
    assert.match(hazard.first.legend, /1 in 500 years/); assert.match(hazard.second, /1 in 2500 years/);
    assert.ok(hazard.first.control && hazard.pickerSynced, 'the return-period choice is in the Layers list');
    assert.ok(hazard.zoomedOut > 100 && hazard.zoomedOut < hazard.first.points && hazard.zoomedIn === hazard.first.points, `zoomed out only the coarse set is drawn (${hazard.zoomedOut}), zoomed in all of them (${hazard.zoomedIn} of ${hazard.first.points})`);

    // the modelled-areas tsunami flood hazard layer: one picture per modelled place, restyled by depth
    const extentsName = 'Tsunami flood hazard: modelled areas (experimental)';
    await page.evaluate((layer) => { window.__floodTestZoom(-27.953, 153.422, 12); return window.__floodSetOverlay(layer, true); }, extentsName);
    await page.waitForFunction("window.__floodStatus.tsunamiExtents && window.__floodStatus.tsunamiExtents.state === 'ready' && window.__floodStatus.tsunamiExtents.drawn > 0", null, { timeout: 20000 });
    const extents = await page.evaluate(async (layer) => {
      const count = async () => {
        const img = document.querySelector('img.tsunami-extent');
        if (!img) return -1;
        await img.decode();
        const c = document.createElement('canvas'); c.width = img.naturalWidth; c.height = img.naturalHeight;
        const g = c.getContext('2d'); g.drawImage(img, 0, 0);
        const d = g.getImageData(0, 0, c.width, c.height).data; let n = 0;
        for (let i = 3; i < d.length; i += 4) if (d[i] > 0) n++;
        return n;
      };
      const info = { ...window.__floodStatus.tsunamiExtents }, low = await count();
      const select = document.querySelectorAll('.tsunami-pick select')[1];
      select.value = '1'; select.dispatchEvent(new Event('change'));
      const high = await count();
      const legend = document.getElementById('overlayLegend').textContent;
      window.__floodSetOverlay(layer, false);
      return { info, low, high, legend, gone: !document.querySelector('img.tsunami-extent') };
    }, extentsName);
    assert.ok(extents.info.places >= 1 && extents.low > 0 && extents.high >= 0 && extents.high < extents.low, `the hazard picture is drawn and shrinks with depth (${extents.low} then ${extents.high} pixels)`);
    assert.match(extents.legend, /Tsunami flood hazard/); assert.ok(extents.gone, 'the picture is removed with the layer');

    // a live tsunami run in the browser worker: the Moderate Kermadec-Tonga scenario at mean sea level must give what the offline model gives (about 34 ha, 0.84 m)
    const live = await page.evaluate(async () => {
      window.__floodOpenPanel('panel-tsunami');
      const final = await window.__floodTsunamiRun({ place: 'gold-coast-seaway', label: '^Moderate', tide: 'MSL', minutes: 60 });
      const scrub = document.getElementById('tsScrub');
      scrub.value = scrub.max; scrub.dispatchEvent(new Event('input'));   // the last frame, where the flood has reached its extent
      const canvas = document.querySelector('canvas.tsunami-live');
      let painted = 0;
      if (canvas) { const d = canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height).data; for (let i = 3; i < d.length; i += 4) if (d[i] > 0) painted++; }
      const info = { ...window.__floodStatus.tsunami };
      const legendOn = document.getElementById('tsKey').textContent.includes('Water on land now') && !document.getElementById('overlayLegend').textContent.includes('Tsunami run');
      const bar = { shown: !document.getElementById('tsBar').hidden, banner: document.getElementById('tsBarTitle').textContent, panelStillOpen: !document.getElementById('panel-tsunami').hidden };
      // the maximum and arrival views, and a tap on the map inside the place
      const views = {};
      for (const v of ['max', 'arrival']) {
        document.querySelector(`#tsViews [data-view="${v}"]`).click();
        const c = document.querySelector('canvas.tsunami-live'); let n = 0;
        const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data; for (let i = 3; i < d.length; i += 4) if (d[i] > 0) n++;
        views[v] = { painted: n, key: document.getElementById('tsKey').textContent, pressed: document.querySelector(`#tsViews [data-view="${v}"]`).getAttribute('aria-pressed') };
      }
      const pin = !!document.querySelector('.ts-pin');
      document.getElementById('tsBarClose').click();
      return { final, painted, info, legendOn, bar, views, pin, cleared: !document.querySelector('canvas.tsunami-live') && document.getElementById('tsBar').hidden };
    });
    assert.ok(live.final && Math.abs(live.final.floodedHectares - 33.8) < 0.3 && Math.abs(live.final.maxLandDepth - 0.84) < 0.02, `the live run matches the offline model: ${JSON.stringify(live.final)}`);
    assert.ok(live.info.state === 'ready' && live.info.frames >= 120 && live.painted > 100 && live.legendOn, `the run is painted on the map: ${JSON.stringify(live.info)} ${live.painted} ${live.legendOn}`);
    assert.ok(live.bar.shown && /Scenario: Moderate.*tide · not a forecast/.test(live.bar.banner), `the bar says what is being shown: ${JSON.stringify(live.bar)}`);
    assert.ok(live.views.max.painted > 100 && /Deepest water/.test(live.views.max.key) && live.views.max.pressed === 'true', `the maximum view paints and has its own key: ${JSON.stringify(live.views.max)}`);
    assert.ok(live.views.arrival.painted > 50 && /within 5 min/.test(live.views.arrival.key), `the arrival view paints its bands: ${JSON.stringify(live.views.arrival)}`);
    assert.ok(live.pin, 'the modelled place has a wave pin on the map');
    assert.ok(live.cleared, 'the run is removed from the map');

    // the pin's card: scenario chips and the tide steps; a chip runs the scenario, flipping the tide back is instant from the cache, a tap on the flooded land says when the water arrived
    await page.evaluate(() => document.querySelector('.ts-pin').click());
    await page.waitForSelector('.ts-card .ts-chip', { timeout: 20000 });
    const card = await page.evaluate(() => ({ chips: [...document.querySelectorAll('.ts-card .ts-chip')].map((b) => b.textContent), tides: [...document.querySelectorAll('.ts-card .ts-seg button')].map((b) => b.textContent) }));
    assert.ok(card.chips.length >= 3 && card.tides.join() === 'Low,Mid,High,Highest', `the card offers the scenarios and four tide steps: ${JSON.stringify(card)}`);
    await page.click('.ts-card .ts-chip');
    await page.waitForFunction("window.__floodStatus.tsunami.state === 'ready'", null, { timeout: 120000 });
    const firstTide = await page.evaluate(() => window.__floodStatus.tsunami.tide);
    const tideStep = async (state) => {
      await page.evaluate(() => document.querySelector('.ts-pin').click());
      await page.waitForSelector(`.ts-card [data-tide="${state}"]`);
      await page.click(`.ts-card [data-tide="${state}"]`);
      await page.waitForFunction(`window.__floodStatus.tsunami.state === 'ready' && window.__floodStatus.tsunami.tide === '${state}'`, null, { timeout: 120000 });
    };
    await tideStep('MHWS'); await tideStep(firstTide);
    const again = await page.evaluate(() => ({ ...window.__floodStatus.tsunami }));
    assert.ok(again.cached === true, `flipping the tide back is served from the cache: ${JSON.stringify(again)}`);
    // a tap on the map inside the place says when the water arrives
    const tap = await page.evaluate(() => {
      const m = window.__floodMap, b = m.getBounds(), c = b.getCenter();
      m.fire('click', { latlng: c, originalEvent: {} });
      const popup = document.querySelector('.ts-tap');
      return popup && popup.textContent;
    });
    assert.ok(tap && /Water arrives|Stays dry|At sea|Under water/.test(tap), `a tap gives the arrival time: ${tap}`);
    const mainArea = await page.evaluate(() => (window.__floodAreaInfo().find((x) => x.active) || {}).key);
    // the run feeds the impact tools: the button opens the flood model here and the impact box counts from the run's depths
    await page.click('#tsImpact');
    await page.waitForFunction("window.__floodStatus.inertial && window.__floodStatus.inertial.tsunami", null, { timeout: 120000 });
    await page.waitForFunction("/Experimental tsunami run/.test(document.getElementById('impactBox').textContent)", null, { timeout: 120000 });
    const used = await page.evaluate(() => ({ note: document.getElementById('tsImpactNote').textContent, summary: document.getElementById('summaryLine').textContent, impact: { ...window.__floodStatus.impact } }));
    assert.match(used.note, /Impact tools now use this tsunami run/, `the bar says the run is in use: ${used.note}`);
    assert.match(used.summary, /Scenario: Moderate.*deepest water/, `the summary names the run: ${used.summary}`);
    // the run travels in a share link and is played again from it
    const link = await page.evaluate(() => { const u = window.__floodShareUrl(); const m = /#s=([A-Za-z0-9_-]+)/.exec(u); const b = atob(m[1].replace(/-/g, '+').replace(/_/g, '/')); return JSON.parse(new TextDecoder().decode(Uint8Array.from(b, (c) => c.charCodeAt(0)))).tsunami; });
    assert.ok(link && link.p === 'gold-coast-seaway' && link.t === firstTide && link.m === 60, `the share link carries the run: ${JSON.stringify(link)}`);
    await page.evaluate(() => document.getElementById('tsBarClose').click());
    await page.evaluate((t) => window.__floodRestore({ v: 1, tsunami: t }), link);
    await page.waitForFunction("window.__floodStatus.tsunami.state === 'ready' && !document.getElementById('tsBar').hidden", null, { timeout: 60000 });
    const again2 = await page.evaluate(async () => { return { ...window.__floodStatus.tsunami, barShown: !document.getElementById('tsBar').hidden }; });
    assert.ok(again2.state === 'ready' && again2.barShown && again2.place === 'gold-coast-seaway', `the link brings the run back: ${JSON.stringify(again2)}`);
    await page.evaluate(() => document.getElementById('tsBarClose').click());
    if (mainArea) await page.evaluate((k) => window.__floodActivateArea(k), mainArea);   // back to the area the later checks use

    // a Moreton Bay place with its own tide planes: Brisbane Bar's lowest state runs at the model's -1 m limit
    const bay = await page.evaluate(async () => {
      const final = await window.__floodTsunamiRun({ place: 'pine-estuary', label: '^Large', tide: 'LAT', minutes: 30 });
      const option = [...document.querySelectorAll('#tsTide option')].find((o) => o.value === 'LAT');
      const info = { ...window.__floodStatus.tsunami };
      document.getElementById('tsBarClose').click();
      return { final, info, label: option && option.textContent };
    });
    assert.ok(bay.final && Number.isFinite(bay.final.floodedHectares) && bay.info.state === 'ready' && bay.info.place === 'pine-estuary', `a Pine River run completed: ${JSON.stringify(bay.info)}`);
    assert.match(bay.label, /run at -1\.00 m/, 'the tide menu says the lowest state runs at -1 m');

    // flash flooding by the 2D solver: the storm's runoff moved over the model's terrain, shown as the deepest water each cell held
    await page.evaluate(() => window.__floodSetStorm('flash', 120, 1, 'typical'));
    const screening = await page.evaluate(() => ({ ...window.__floodStatus.flash, methodRow: !document.getElementById('flashMethodRow').hidden, controls: !document.getElementById('flash2dControls').hidden }));
    assert.ok(screening.methodRow && !screening.controls, 'the method choice shows for flash flooding, and the 2D controls only once chosen');
    const flashStart = Date.now();
    await page.evaluate(() => { document.getElementById('flash2dResolution').value = '96'; window.__floodFlash2d({ method: '2d' }); });
    await page.waitForFunction("window.__floodStatus.inertial && window.__floodStatus.inertial.storm && window.__floodStatus.inertial.running === false", null, { timeout: 180000 });
    const flashMs = Date.now() - flashStart;
    const flash2d = await page.evaluate(() => ({ inertial: { ...window.__floodStatus.inertial, vx: undefined, vy: undefined }, status: document.getElementById('flash2dStatus').textContent, summary: document.getElementById('summaryLine').textContent, controls: !document.getElementById('flash2dControls').hidden }));
    assert.ok(!flash2d.inertial.error && flash2d.inertial.peak === true && flash2d.inertial.storm.effectiveMm > 90 && flash2d.inertial.time >= 3 * 3600 - 1, `the 2D storm run finished: ${JSON.stringify(flash2d.inertial).slice(0, 300)}`);
    assert.match(flash2d.status, /deepest water each cell held/); assert.match(flash2d.summary, /deepest water over/); assert.ok(flash2d.controls);
    assert.ok(flash2d.inertial.sourceVolume > 0 && Math.abs(flash2d.inertial.balanceError) < 1e-6 * flash2d.inertial.sourceVolume + 1, `the run conserves water: ${flash2d.inertial.balanceError} of ${flash2d.inertial.sourceVolume} m3`);
    // the new outputs of a storm run: the worst hazard class, the time until flooded, and a quarter-hour series step
    const modes = await page.evaluate(() => {
      const sel = document.getElementById('colorMode'), set = (v) => { sel.value = v; sel.dispatchEvent(new Event('change')); };
      const enabled = !sel.querySelector('option[value="arrival"]').disabled;
      set('arrival'); const arrival = document.getElementById('modeLegend').textContent;
      set('hazard'); const hazard = document.getElementById('modeLegend').textContent;
      const stats = document.getElementById('stats').textContent, settings = window.__floodStatus.inertial.settings;
      set('depth');
      return { enabled, arrival, hazard, wetNever: /wet, never 10 cm/.test(arrival), stats, step: window.__floodStatus.inertial.settings.rainSeries.length, first: /First flooded/.test(stats), settings: { seriesStepS: settings.seriesStepS } };
    });
    assert.ok(modes.enabled && /within 15 min/.test(modes.arrival) && /after 4 h/.test(modes.arrival), `the time-until-flooded colours are offered and keyed: ${modes.arrival}`);
    assert.match(modes.hazard, /worst depth × speed any step reached/); assert.ok(modes.first, `the stats say when flooding starts: ${modes.stats}`);
    assert.ok(modes.wetNever, 'the key says what the blue cells are');
    const prop = await page.evaluate(async (g) => { await window.__floodCheckProperty(g[0], g[1], 'storm check'); return window.__floodStatus.property; }, gauge);
    assert.ok(prop.inModel && prop.model === 'local-inertial' && Number.isFinite(prop.depth) && (prop.arrivalMin === null || prop.arrivalMin >= 0), `the property check reads the 2D storm run: ${JSON.stringify(prop)}`);
    assert.equal(modes.settings.seriesStepS, 600); assert.equal(modes.step, 6 + 12, 'a one-hour storm and two hours after are 18 ten-minute entries, not 3 hourly ones');
    if (process.env.SHOT_DIR) {   // for looking at by hand
      await page.evaluate(() => { document.getElementById('panel-tsunami').hidden = true; document.getElementById('flashMethodRow').scrollIntoView({ block: 'start' }); });
      await page.screenshot({ path: path.join(process.env.SHOT_DIR, 'flash-2d.png') });
      await page.evaluate((g) => { document.getElementById('panel-scenario').classList.add('collapsed'); window.__floodTestZoom(g[0], g[1], 11); }, gauge);
      for (const mode of ['arrival', 'hazard', 'depth']) {
        await page.evaluate((m) => { const sel = document.getElementById('colorMode'); sel.value = m; sel.dispatchEvent(new Event('change')); }, mode);
        await page.waitForTimeout(700);
        await page.screenshot({ path: path.join(process.env.SHOT_DIR, `flash-${mode}.png`) });
      }
    }
    // changing the storm drops the 2D result and says so; choosing the screening model again restores it
    await page.evaluate(() => window.__floodSetStorm('flash', 60, 1, 'typical'));
    const after = await page.evaluate(() => ({ inertial: window.__floodStatus.inertial, status: document.getElementById('flash2dStatus').textContent }));
    assert.ok(!after.inertial && /Press Run/.test(after.status), `a changed storm drops the 2D run: ${JSON.stringify(after)}`);
    await page.evaluate(() => { document.getElementById('flashMethod').value = 'screen'; document.getElementById('flashMethod').dispatchEvent(new Event('change')); });
    assert.ok(await page.evaluate(() => document.getElementById('flash2dControls').hidden), 'the screening model hides the 2D controls');

    assert.deepEqual(errors, [], 'no page errors');
    console.log(`impact: ${impact.bWet} of ${impact.buildings} buildings flooded, ${impact.cutKm} km of road cut (sweep ${impact.timing.sweepMs} ms); `
      + `routes for ${withRoute.length} of ${routes.length} spots; timeline ${timeline.steps} steps, ${timeline.roadsClosed} roads closed, up to ${timeline.maxIsolated} buildings cut off; 2D storm run ${flashMs} ms (${flash2d.inertial.W} x ${flash2d.inertial.H} cells, ${flash2d.inertial.steps} steps)`);
  } finally {
    if (browser) await browser.close();
    await new Promise((resolve) => server.close(resolve));
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
