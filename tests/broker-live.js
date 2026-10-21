// End to end with the real Queensland portal: the broker (already running,
// BROKER_URL) answers for gauges on the map, and a Queensland gauge report
// in this build (built with FLOOD_BROKER_URL) shows the live level.
//   BROKER_URL=http://127.0.0.1:8787 SITE_URL=http://127.0.0.1:8000/ OUT=shots node tests/broker-live.js
const pw = require("playwright");
const fs = require("node:fs");
const path = require("node:path");

const SITE = process.env.SITE_URL || "http://127.0.0.1:8000/";
const BROKER = process.env.BROKER_URL || "http://127.0.0.1:8787";
const OUT = process.env.OUT || "shots";

(async () => {
  const r = {};
  const browser = await pw.chromium.launch();
  try {
    const page = await browser.newPage({ viewport: { width: 1280, height: 860 } });
    const errors = [];
    page.on("console", (m) => { if (m.type() === "error") errors.push(m.text()); });
    await page.goto(SITE, { waitUntil: "load", timeout: 90000 });
    await page.waitForFunction("window.__floodStatus && window.__floodStatus.national && window.__floodStatus.national.loaded", null, { timeout: 90000 });
    await page.waitForFunction("window.__floodQldStations && window.__floodQldStations(5).length > 0", null, { timeout: 60000 }).catch(() => {});
    const stations = await page.evaluate(() => window.__floodQldStations(60));
    r.candidates = stations.length;

    const t0 = Date.now();
    const res = await fetch(`${BROKER}/v1/levels?sites=${stations.join(",")}`, { headers: { origin: new URL(SITE).origin } });
    const body = await res.json();
    r.broker = { status: res.status, ms: Date.now() - t0, cors: res.headers.get("access-control-allow-origin"), live: Object.keys(body.sites || {}).length, missing: (body.missing || []).length, stale: !!body.stale };
    const t1 = Date.now();
    await fetch(`${BROKER}/v1/levels?sites=${stations.join(",")}`);
    r.brokerCachedMs = Date.now() - t1;
    const pick = Object.keys(body.sites || {})[0];
    if (pick) {
      r.sample = { station: pick, latest: body.sites[pick].latest, points: body.sites[pick].series.length };
      await page.evaluate((s) => window.__floodOpenGauge(s), pick);
      await page.waitForSelector(".report-card .live-tag", { timeout: 30000 }).then(() => { r.reportLive = true; }, () => { r.reportLive = false; });
      r.reportText = await page.evaluate(() => {
        const c = [...document.querySelectorAll(".report-card")].pop();
        const rd = c && c.querySelector(".js-reading");
        return rd ? rd.innerText.replace(/\s+/g, " ").slice(0, 300) : null;
      });
      r.status = await page.evaluate(() => window.__floodStatus.live || null);
      fs.mkdirSync(OUT, { recursive: true });
      await page.screenshot({ path: path.join(OUT, "14-live-level.png") });
    }
    // readings for the whole map from the broker (it fetches them on start)
    let rd = null;
    for (let i = 0; i < 40; i++) {
      const res2 = await fetch(`${BROKER}/v1/readings`, { headers: { origin: new URL(SITE).origin } });
      if (res2.status === 200) { rd = { status: 200, cors: res2.headers.get("access-control-allow-origin"), body: await res2.json() }; break; }
      rd = { status: res2.status };
      await new Promise((ok) => setTimeout(ok, 10000));
    }
    r.readings = rd && rd.body ? {
      status: rd.status, cors: rd.cors, fetched: rd.body.fetched, levels: Object.keys(rd.body.level || {}).length,
      storages: Object.keys(rd.body.storage || {}).length, realtime: Object.values(rd.body.level || {}).filter((x) => x.latestKind === "realtime").length,
      errors: (rd.body.errors || []).length, errorList: (rd.body.errors || []).slice(0, 5),
      rain: Object.keys(rd.body.rain || {}).length, rainCells: rd.body.rainCells, sea: Object.keys(rd.body.sea || {}).length,
      withRise: Object.values(rd.body.level || {}).filter((x) => 'rise3h' in x || 'rise24h' in x).length,
      tidal: Object.values(rd.body.level || {}).filter((x) => x.tidal).length,
      floodClasses: Object.keys(rd.body.floodclass || {}).length, bureauLevels: rd.body.bureauLevels,
      kinds: Object.values(rd.body.level || {}).reduce((m, x) => (m[x.latestKind] = (m[x.latestKind] || 0) + 1, m), {}),
      inFlood: Object.values(rd.body.floodclass || {}).filter((g) => /minor|moderate|major/i.test(g.class || '')).map((g) => [g.name, g.class, g.tendency]).slice(0, 8),
      warnings: rd.body.warnings ? { ok: rd.body.warnings.ok, capFiles: rd.body.warnings.capFiles, list: (rd.body.warnings.warnings || []).map((w) => [w.id, w.severity, w.title]) } : null,
      watch: (rd.body.watch || []).slice(0, 10).map((w) => [w.kind, w.station, w.why]),
      seaSample: Object.values(rd.body.sea || {}).slice(0, 4).map((x) => [x.name, x.residual, x.residualNormal, x.surge]),
    } : rd;
    if (rd && rd.body) {
      const page2 = await browser.newPage({ viewport: { width: 1280, height: 860 } });
      await page2.goto(SITE, { waitUntil: "load", timeout: 90000 });
      await page2.waitForFunction("window.__floodStatus && window.__floodStatus.national && window.__floodStatus.national.loaded", null, { timeout: 90000 });
      r.mapReadings = await page2.evaluate(() => { const n = window.__floodStatus.national; return { dataSource: n.dataSource, readingsSource: n.readingsSource, fetched: n.readingsFetched, levels: n.levelReadings, warnings: window.__floodStatus.warnings || null, sea: window.__floodStatus.sea || null }; });
      const p3 = await browser.newPage();
      await p3.goto(SITE + "?data=build", { waitUntil: "load", timeout: 90000 });
      await p3.waitForFunction("window.__floodStatus && window.__floodStatus.national && window.__floodStatus.national.loaded", null, { timeout: 90000 });
      r.mapReadingsOverride = await p3.evaluate(() => window.__floodStatus.national.readingsSource);
      // the watch list on the map, and opening its first gauge
      await page2.click('.tool[data-open="panel-forecast"]').catch(() => {});
      await page2.waitForTimeout(800);
      r.watchPanel = await page2.evaluate(() => window.__floodWatch && window.__floodWatch());
      if (r.watchPanel) r.watchPanel.list = r.watchPanel.list.slice(0, 6).map((w) => [w.kind, w.station, w.why]);
      await page2.screenshot({ path: path.join(OUT, "15-watch-list.png") });
      const gaugeIdx = await page2.evaluate(() => ((window.__floodWatch() || {}).list || []).findIndex((w) => w.kind === 'river' || w.kind === 'flood'));
      if (gaugeIdx >= 0) {
        await page2.evaluate((i) => window.__floodOpenWatch(i), gaugeIdx);
        await page2.waitForTimeout(2500);
        r.watchOpened = await page2.evaluate(() => { const c = [...document.querySelectorAll('.report-card')].pop(); return c ? c.innerText.replace(/\s+/g, ' ').slice(0, 400) : null; });
        await page2.screenshot({ path: path.join(OUT, "16-watch-gauge.png") });
      }
    }
    r.health = await (await fetch(`${BROKER}/health`)).json();
    r.errors = errors.slice(0, 5);
  } catch (e) {
    r.fatal = String(e && e.stack || e);
  } finally {
    // results first: a crashed browser must not lose them
    fs.mkdirSync(OUT, { recursive: true });
    fs.writeFileSync(path.join(OUT, "broker-live.json"), JSON.stringify(r, null, 1));
    await browser.close().catch((e) => { r.closeError = String(e); });
  }
  fs.writeFileSync(path.join(OUT, "broker-live.json"), JSON.stringify(r, null, 1));
  console.log(JSON.stringify(r, null, 1));
  // the gist as run notices (readable without the screenshots branch)
  const note = (t, v) => console.log(`::notice title=${t}::${JSON.stringify(v).slice(0, 900)}`);
  if (r.readings) note("broker readings", { ...r.readings, watch: undefined, seaSample: undefined });
  if (r.readings && r.readings.watch) note("broker watch list", r.readings.watch);
  if (r.watchPanel) note("map watch panel", r.watchPanel);
  if (r.watchOpened) note("watch item opened", r.watchOpened);
  if (r.fatal) note("broker-live fatal", r.fatal);
  if (r.fatal || !r.broker || r.broker.status !== 200 || !r.reportLive || !r.mapReadings || r.mapReadings.readingsSource !== "runtime") process.exitCode = 1;
})();
