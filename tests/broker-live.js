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
    r.health = await (await fetch(`${BROKER}/health`)).json();
    r.errors = errors.slice(0, 5);
  } catch (e) {
    r.fatal = String(e && e.stack || e);
  } finally {
    await browser.close();
  }
  fs.mkdirSync(OUT, { recursive: true });
  fs.writeFileSync(path.join(OUT, "broker-live.json"), JSON.stringify(r, null, 1));
  console.log(JSON.stringify(r, null, 1));
  if (r.fatal || !r.broker || r.broker.status !== 200 || !r.reportLive) process.exitCode = 1;
})();
