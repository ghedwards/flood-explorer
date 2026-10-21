// End to end with the real Queensland portal: the broker (already running,
// BROKER_URL) answers for gauges on the map, and a Queensland gauge report
// in this build (built with FLOOD_BROKER_URL) shows the live level.
//   BROKER_URL=http://127.0.0.1:8787 SITE_URL=http://127.0.0.1:8000/ OUT=shots node tests/broker-live.js
const pw = require("playwright");
const fs = require("node:fs");
const path = require("node:path");

const http = require("node:http");
// plain node:http for the local broker: Node's fetch (undici) can crash with
// assert(!this.paused) on a large body from a server that closes the connection
function get(url, opts) {
  const headers = (opts && opts.headers) || {};
  return new Promise((ok, no) => {
    const req = http.get(url, { headers, agent: false }, (res) => {
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("error", no);
      res.on("end", () => {
        const body = Buffer.concat(chunks);
        ok({ status: res.statusCode, ok: res.statusCode >= 200 && res.statusCode < 300, headers: { get: (k) => res.headers[k.toLowerCase()] ?? null },
          json: async () => JSON.parse(body.toString("utf8")), arrayBuffer: async () => body });
      });
    });
    req.on("error", no);
    req.setTimeout(180000, () => req.destroy(new Error("timeout")));
  });
}

const SITE = process.env.SITE_URL || "http://127.0.0.1:8000/";
const BROKER = process.env.BROKER_URL || "http://127.0.0.1:8787";
const OUT = process.env.OUT || "shots";

const r = {};
// whatever ends the run, keep what it found
const keep = (why) => (e) => {
  r.fatal = r.fatal || `${why}: ${String(e && e.stack || e)}`;
  try { fs.mkdirSync(OUT, { recursive: true }); fs.writeFileSync(path.join(OUT, "broker-live.json"), JSON.stringify(r, null, 1)); } catch (e2) { /* nothing more to do */ }
  console.log(`::error title=broker-live ${why}::${String(e && e.message || e).slice(0, 500)}`);
  process.exit(1);
};
process.on("uncaughtException", keep("uncaught"));
process.on("unhandledRejection", keep("unhandled rejection"));

(async () => {
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
    const res = await get(`${BROKER}/v1/levels?sites=${stations.join(",")}`, { headers: { origin: new URL(SITE).origin } });
    const body = await res.json();
    r.broker = { status: res.status, ms: Date.now() - t0, cors: res.headers.get("access-control-allow-origin"), live: Object.keys(body.sites || {}).length, missing: (body.missing || []).length, stale: !!body.stale };
    const t1 = Date.now();
    // read every body: an unread one can crash Node's fetch when the server closes the connection
    await (await get(`${BROKER}/v1/levels?sites=${stations.join(",")}`)).arrayBuffer();
    r.brokerCachedMs = Date.now() - t1;
    const pick = Object.keys(body.sites || {})[0];
    if (pick) {
      r.sample = { station: pick, latest: body.sites[pick].latest, points: body.sites[pick].series.length };
      await page.evaluate((s) => window.__floodOpenGauge(s), pick);
      await page.waitForSelector(".report-card .live-tag", { timeout: 30000 }).then(() => { r.reportLive = true; }, () => { r.reportLive = false; });
      // the broker's hourly record for that gauge, drawn in the report
      await page.waitForSelector(".report-card .hist-svg", { timeout: 20000 }).catch(() => {});
      r.historyApi = await (await get(`${BROKER}/v1/history?site=${encodeURIComponent(pick)}`)).json().then((h) => ({ points: (h.points || []).length, last: (h.points || []).slice(-1)[0] || null }), (e) => String(e));
      r.history = await page.evaluate((s) => ({ status: window.__floodStatus.history || null, points: (window.__floodHistory(s) || { points: [] }).points.length, chart: !!document.querySelector(".report-card .hist-svg"), caption: (document.querySelector(".report-card .hist .hint") || {}).textContent || null }), pick).catch((e) => String(e));
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
      const res2 = await get(`${BROKER}/v1/readings`, { headers: { origin: new URL(SITE).origin } });
      if (res2.status === 200) { rd = { status: 200, cors: res2.headers.get("access-control-allow-origin"), body: await res2.json() }; break; }
      rd = { status: res2.status };
      await res2.arrayBuffer().catch(() => {});
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
      r.versions = await page2.evaluate(async () => { await window.__floodVersions(); return { status: window.__floodStatus.versions, text: document.getElementById("versionInfo").textContent }; }).catch((e) => String(e));
      r.warningMap = await page2.evaluate(async () => {
        const n = ((window.__floodStatus.warnings) || {}).count || 0;
        if (!n) return { warnings: 0 };
        window.__floodShowWarning(0);
        await new Promise((ok) => setTimeout(ok, 1500));
        const pop = document.querySelector(".leaflet-popup-content");
        return { areas: window.__floodStatus.warningAreas, shown: window.__floodStatus.shownWarning, popup: pop ? pop.innerText.replace(/\s+/g, " ").slice(0, 300) : null };
      }).catch((e) => String(e));
      await page2.screenshot({ path: path.join(OUT, "17-warning-map.png") });
      // the warnings' texts (to check the peak reader against) and the peaks found
      try {
        const rd = await (await get(`${BROKER}/v1/readings`)).json();
        fs.mkdirSync(OUT, { recursive: true });
        fs.writeFileSync(path.join(OUT, "warnings-live.json"), JSON.stringify(rd.warnings || null, null, 1));
      } catch (e) { r.warningsSaveError = String(e); }
      r.warningPeaks = await page2.evaluate(() => window.__floodWarningPeaks && window.__floodWarningPeaks()).catch((e) => String(e));
      const pi = Array.isArray(r.warningPeaks) ? r.warningPeaks.findIndex((w) => w.peaks.length) : -1;
      if (pi >= 0) {
        r.warningModel = await page2.evaluate((i) => Promise.race([window.__floodModelWarning(i, 0), new Promise((ok) => setTimeout(() => ok("timed out"), 180000))]), pi).catch((e) => String(e));
        await page2.waitForTimeout(3000);
        r.warningModelSummary = await page2.evaluate(() => (document.getElementById("summaryLine") || {}).textContent || null).catch(() => null);
        await page2.screenshot({ path: path.join(OUT, "18-warning-peak-model.png") });
      }
      await page2.evaluate(() => window.L && document.querySelector(".leaflet-popup-close-button") && document.querySelector(".leaflet-popup-close-button").click()).catch(() => {});
      r.refreshNow = await page2.evaluate(async () => {
        const b = document.getElementById("watchRefresh");
        if (!b) return { button: false };
        b.click();
        await new Promise((ok) => setTimeout(ok, 4000));
        const after = document.getElementById("watchRefresh");
        // once every 5 minutes: the button now waits
        return { button: true, refreshed: window.__floodStatus.liveRefresh || null, after: after ? { disabled: after.disabled, text: after.textContent } : null };
      }).catch((e) => String(e));
      r.dataTimes = await page2.evaluate(async () => {
        await window.__floodDataStatus();
        const info = (document.getElementById("dataInfo") || {}).textContent || "";
        return { info: info.replace(/\s+/g, " ").slice(0, 300), live: ((document.getElementById("dataStatus") || {}).innerText || "").replace(/\s+/g, " ").slice(0, 700) };
      }).catch((e) => String(e));
      r.watchPanel = await page2.evaluate(() => window.__floodWatch && window.__floodWatch());
      if (r.watchPanel) r.watchPanel.list = r.watchPanel.list.slice(0, 6).map((w) => [w.kind, w.station, w.why]);
      await page2.screenshot({ path: path.join(OUT, "15-watch-list.png") });
      const gaugeIdx = await page2.evaluate(() => ((window.__floodWatch() || {}).list || []).findIndex((w) => w.kind === 'river' || w.kind === 'flood'));
      if (gaugeIdx >= 0) {
        await page2.evaluate((i) => window.__floodOpenWatch(i), gaugeIdx);
        await page2.waitForTimeout(2500);
        r.watchOpened = await page2.evaluate(() => { const c = [...document.querySelectorAll('.report-card')].pop(); return c ? c.innerText.replace(/\s+/g, ' ').slice(0, 400) : null; });
        await page2.screenshot({ path: path.join(OUT, "16-watch-gauge.png") });
        // that gauge report is now one of your places: its item is near it
        await page2.click('.tool[data-open="panel-forecast"]').catch(() => {});
        await page2.waitForTimeout(800);
        r.watchNear = await page2.evaluate(() => window.__floodWatch().near.slice(0, 5));
        await page2.screenshot({ path: path.join(OUT, "17-watch-near.png") });
      }
    }
    // a second visit starts from the readings saved by the first
    if (rd && rd.body) {
      try {
        const page3 = await browser.newPage({ viewport: { width: 1280, height: 860 } });
        await page3.goto(SITE, { waitUntil: "load", timeout: 90000 });
        await page3.waitForFunction("window.__floodStatus && window.__floodStatus.national && window.__floodStatus.national.loaded", null, { timeout: 90000 });
        await page3.waitForTimeout(800);
        await page3.reload({ waitUntil: "load" });
        const t0 = Date.now();
        await page3.waitForFunction("window.__floodStatus && window.__floodStatus.national && window.__floodStatus.national.loaded", null, { timeout: 90000 });
        r.secondVisit = { loadedMs: Date.now() - t0, ...(await page3.evaluate(() => ({ saved: window.__floodStatus.savedReadings || null, source: window.__floodStatus.national.readingsSource }))) };
        await page3.waitForTimeout(4000);
        r.secondVisit.then = await page3.evaluate(() => window.__floodStatus.savedThenFresh || null);
        await page3.close();
      } catch (e) { r.secondVisit = String(e); }
    }
    r.health = await (await get(`${BROKER}/health`)).json();
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
  if (r.watchNear) note("watch near your places", r.watchNear);
  if (r.versions) note("versions", r.versions);
  if (r.refreshNow) note("refresh now", r.refreshNow);
  if (r.secondVisit) note("second visit", r.secondVisit);
  if (r.dataTimes) note("data times", r.dataTimes);
  if (r.history) note("hourly record", { report: r.history, api: r.historyApi });
  if (r.warningMap) note("warning on the map", r.warningMap);
  if (r.warningPeaks) note("warning peaks", r.warningPeaks);
  if (r.warningModel) note("warning peak model", { model: r.warningModel, summary: r.warningModelSummary });
  if (r.fatal) note("broker-live fatal", r.fatal);
  if (r.fatal || !r.broker || r.broker.status !== 200 || !r.reportLive || !r.mapReadings || r.mapReadings.readingsSource !== "runtime") process.exitCode = 1;
})();
