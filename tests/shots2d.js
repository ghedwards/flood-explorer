// Screenshots of the 2D map for review: the Australia-wide view, a
// modelled place at several zooms and display modes, the timeline, and a
// phone-sized window, plus console errors.
//   SITE_URL=https://... PLACE=rockhampton OUT=shots node tests/shots2d.js
const { chromium } = require("playwright");
const fs = require("node:fs");
const path = require("node:path");

const URL = process.env.SITE_URL || "https://ghedwards.github.io/flood-explorer/";
const PLACE = process.env.PLACE || "rockhampton";
const OUT = process.env.OUT || "shots";

(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  const report = { url: URL, place: PLACE, steps: [], errors: [] };
  const browser = await chromium.launch();
  const run = async (name, fn) => {
    const s = Date.now();
    try { await fn(); report.steps.push({ name, ok: true, ms: Date.now() - s }); } catch (e) { report.steps.push({ name, ok: false, ms: Date.now() - s, error: String(e).slice(0, 300) }); }
  };
  const open = async (viewport) => {
    const page = await browser.newPage({ viewport });
    page.on("pageerror", (e) => report.errors.push(String(e).slice(0, 300)));
    page.on("console", (m) => { if (m.type() === "error") report.errors.push(m.text().slice(0, 300)); });
    await page.goto(URL, { waitUntil: "networkidle", timeout: 90000 });
    await page.waitForFunction("window.__floodStatus && window.__floodStatus.mode === 'map'", null, { timeout: 60000 });
    return page;
  };
  const shot = async (page, name) => {
    try { await page.screenshot({ path: path.join(OUT, `${name}.png`), timeout: 60000 }); } catch (e) { report.steps.push({ name: `shot ${name}`, ok: false, error: String(e).slice(0, 200) }); }
  };
  const settle = (page, ms = 4000) => page.waitForTimeout(ms);
  try {
    // desktop
    const page = await open({ width: 1400, height: 900 });
    await settle(page, 6000);
    await shot(page, "01-australia");
    await run("zoom-qld", async () => { await page.evaluate(() => window.__floodTestZoom(-23.4, 150.5, 8)); await settle(page, 5000); });
    await shot(page, "02-region-gauges");
    await run("model", async () => {
      await page.selectOption("#area", `preset:${PLACE}`);
      await page.waitForFunction("window.__floodStatus.local && window.__floodStatus.local.ok === true", null, { timeout: 120000 });
      await page.waitForTimeout(600);
      await shot(page, "03a-toast");
      await settle(page, 5000);
    });
    await shot(page, "03-model");
    await run("channel-diag", async () => { report.channelDiag = await page.evaluate(() => window.__floodChannelDiag && window.__floodChannelDiag()); });
    await run("places-help-fold", async () => { await page.click("#placesHelp"); await settle(page, 500); });
    await shot(page, "03b-places-folded");
    await run("zoom-in", async () => {
      const g = await page.evaluate(() => window.__floodGaugeLatLng && window.__floodGaugeLatLng());
      if (g) await page.evaluate(([la, lo]) => window.__floodTestZoom(la, lo, 15), [g.lat ?? g[0], g.lng ?? g[1]]);
      await settle(page, 5000);
    });
    await shot(page, "04-street-zoom");
    await run("zoom-16", async () => {
      const g = await page.evaluate(() => window.__floodGaugeLatLng && window.__floodGaugeLatLng());
      if (g) await page.evaluate(([la, lo]) => window.__floodTestZoom(la, lo, 16), [g.lat ?? g[0], g.lng ?? g[1]]);
      await settle(page, 4000);
    });
    await settle(page, 4000);   // the 5 m LiDAR edges load after the move
    report.fine_z16 = await page.evaluate(() => window.__floodStatus.fine);
    await shot(page, "04b-street-z16");
    await run("key-collapsed", async () => { await page.click("#legendToggle"); await settle(page, 1000); });
    await shot(page, "04c-key-collapsed");
    await run("key-expanded", async () => { if ((await page.getAttribute("#legendToggle", "aria-expanded")) !== "true") await page.click("#legendToggle"); });
    await run("hazard", async () => { await page.evaluate(() => window.__floodColorMode && window.__floodColorMode("hazard")); await settle(page, 2500); });
    await shot(page, "05-hazard");
    await run("depth-back", async () => { await page.evaluate(() => window.__floodColorMode && window.__floodColorMode("depth")); });
    await run("high-flood", async () => {
      await page.evaluate(() => { const m = window.__floodMap; if (m) m.setZoom(12, { animate: false }); });
      await page.evaluate(() => window.__floodSetLevel && window.__floodSetLevel(9));
      await settle(page, 5000);
    });
    await shot(page, "06-big-flood");
    // a big flood's edges through town at street level: 5 m LiDAR edges
    for (const [z, dx, name] of [[16, 0, "06b-big-flood-z16"], [15, -0.012, "06c-big-flood-z15"]]) {
      await run(name, async () => {
        const g = await page.evaluate(() => window.__floodGaugeLatLng && window.__floodGaugeLatLng());
        if (g) await page.evaluate(([la, lo, zz]) => window.__floodTestZoom(la, lo, zz), [g.lat ?? g[0], (g.lng ?? g[1]) + dx, z]);
        await settle(page, 9000);
        report[`fine_${name}`] = await page.evaluate(() => window.__floodStatus.fine);
      });
      await shot(page, name);
    }
    await run("back-out", async () => { await page.evaluate(() => { const m = window.__floodMap; if (m) m.setZoom(12, { animate: false }); }); await settle(page, 3000); });
    await run("basemap-street", async () => { await page.evaluate(() => window.__floodSetBasemap && window.__floodSetBasemap("Streets")); await settle(page, 4000); });
    await shot(page, "07-street-basemap");
    await page.close();
    // phone
    const phone = await open({ width: 390, height: 844 });
    await settle(phone, 5000);
    await shot(phone, "08-phone-australia");
    await run("phone-model", async () => {
      await phone.selectOption("#area", `preset:${PLACE}`);
      await phone.waitForFunction("window.__floodStatus.local && window.__floodStatus.local.ok === true", null, { timeout: 120000 });
      await settle(phone, 5000);
    });
    await shot(phone, "09-phone-model");
    // on a phone the Scenario sheet opens by itself after the model loads (09);
    // close it for the map view with key chip and buttons, then reopen it tall
    await run("phone-map", async () => { await phone.click('.tool[data-open="panel-scenario"]'); await settle(phone, 1500); });
    await shot(phone, "10-phone-map");
    await run("phone-sheet", async () => { await phone.click('.tool[data-open="panel-scenario"]'); await settle(phone, 1500); await phone.click("#panel-scenario .sheet-grip"); await settle(phone, 1000); });
    await shot(phone, "11-phone-sheet-tall");
    await phone.close();
  } finally {
    fs.writeFileSync(path.join(OUT, "report.json"), JSON.stringify(report, null, 1));
    await browser.close();
  }
  console.log(JSON.stringify(report.steps));
})();
