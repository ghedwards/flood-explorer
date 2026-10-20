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
    page.on("response", (r) => { if (r.status() >= 400) { report.http = report.http || []; if (report.http.length < 30) report.http.push(`${r.status()} ${r.url().slice(0, 200)}`); } });
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
    report.dotClusters = await page.evaluate(() => window.__floodStatus.dotClusters);
    await shot(page, "01-australia");
    await run("zoom-se-qld-6", async () => { await page.evaluate(() => window.__floodTestZoom(-27.5, 152.8, 6)); await settle(page, 3000); });
    report.dotClusters6 = await page.evaluate(() => window.__floodStatus.dotClusters);
    await shot(page, "01b-se-qld-z6");
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
    // what the impact count and the flooded-roads layer cost: load, the
    // per-scenario sweep and the drawing, at 9 m and again at 7 m
    await run("impact-roads", async () => {
      // the user's path: Layers panel, tick the roads layer (no count yet)
      await page.click('.tool[data-open="panel-layers"]');
      await settle(page, 800);
      const t0 = Date.now();
      await page.click('#overlayList input[data-layer="Flooded (red) and cut-off (orange) roads"]');
      await page.waitForTimeout(300);
      report.layerStateStart = await page.evaluate(() => JSON.parse(JSON.stringify(window.__floodStatus.layerState || {})));
      await page.waitForFunction(() => { const s = (window.__floodStatus.layerState || {})["Flooded (red) and cut-off (orange) roads"]; return s && s.kind !== "loading"; }, null, { timeout: 60000 });
      report.impactWallMs = Date.now() - t0;
      report.impact = await page.evaluate(() => window.__floodStatus.impact);
      report.layerState9 = await page.evaluate(() => JSON.parse(JSON.stringify(window.__floodStatus.layerState || {})));
      await settle(page, 1000);
      await shot(page, "06f-layers-roads-on");
      await page.click('.tool[data-open="panel-layers"]');
      await settle(page, 500);
      report.impactTiming9 = await page.evaluate(() => window.__floodStatus.impactTiming);
      const t1 = Date.now();
      await page.evaluate(() => window.__floodSetLevel(7));
      await settle(page, 2500);
      report.levelChangeWallMs = Date.now() - t1;
      report.impactTiming7 = await page.evaluate(() => window.__floodStatus.impactTiming);
      report.impact7 = await page.evaluate(() => window.__floodStatus.impact);
    });
    await shot(page, "06e-roads-7m");
    // slow buttons show a spinner and what they're doing while they work
    await run("busy-button", async () => {
      const read = () => page.evaluate(() => { const b = document.getElementById("recordedBtn"); return b ? { busy: b.getAttribute("aria-busy"), disabled: b.disabled, text: b.textContent.trim() } : null; });
      await page.evaluate(() => document.getElementById("recordedBtn").click());
      await page.waitForTimeout(150);
      report.busyDuring = await read();
      await page.waitForFunction(() => document.getElementById("recordedBtn").getAttribute("aria-busy") !== "true", null, { timeout: 60000 });
      report.busyAfter = await read();
    });
    await run("roads-off", async () => { await page.evaluate(() => { window.__floodSetOverlay("Flooded (red) and cut-off (orange) roads", false); window.__floodSetLevel(9); }); await settle(page, 2500); });
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
    await run("big-flood-hazard-z15", async () => {
      await page.evaluate(() => window.__floodColorMode && window.__floodColorMode("hazard"));
      await settle(page, 6000);
      report.fine_hazard = await page.evaluate(() => window.__floodStatus.fine);
    });
    await shot(page, "06d-big-flood-hazard-z15");
    await run("depth-again", async () => { await page.evaluate(() => window.__floodColorMode && window.__floodColorMode("depth")); });
    await run("back-out", async () => { await page.evaluate(() => { const m = window.__floodMap; if (m) m.setZoom(12, { animate: false }); }); await settle(page, 3000); });
    await run("basemap-street", async () => { await page.evaluate(() => window.__floodSetBasemap && window.__floodSetBasemap("Streets")); await settle(page, 4000); });
    await shot(page, "07-street-basemap");
    await page.close();
    // a study area near Lismore: progress with Stop, stopped part-way, its
    // places grouped under it in Places
    const sp = await open({ width: 1400, height: 900 });
    await settle(sp, 5000);
    await run("study", async () => {
      await sp.evaluate(() => { window.__studyJob = window.__floodStudyArea(-28.95, 153.10, -28.65, 153.45); });
      await sp.waitForFunction(() => !document.getElementById("studyProgress").hidden && /flood model 1 of/.test(document.getElementById("studyProgressText").textContent), null, { timeout: 120000 });
      report.studyProgress = await sp.evaluate(() => document.getElementById("studyProgressText").textContent);
      await shot(sp, "12a-study-progress");
      await sp.click("#studyStop");
      report.study = await sp.evaluate(() => window.__studyJob);
      await settle(sp, 2000);
      report.studies = await sp.evaluate(() => window.__floodStudies());
      report.studyPlaces = await sp.evaluate(() => ({
        topRows: document.querySelectorAll("#areaList > ul.places > li.place").length,
        studyRows: document.querySelectorAll("#areaList [data-study]").length,
        toggle: (document.querySelector("[data-study-open]") || {}).textContent,
      }));
      await sp.evaluate(() => { const t = document.querySelector("[data-study-open]"); if (t) t.click(); });
      await settle(sp, 800);
      report.studyMembersShown = await sp.evaluate(() => document.querySelectorAll(".study-members li.place").length);
    });
    await shot(sp, "12b-study-grouped");
    // the problems log: an uncaught error is kept, badged on About, and copied
    await run("problems-log", async () => {
      await sp.evaluate(() => { setTimeout(() => { throw new Error("shots2d test problem"); }, 0); });
      await settle(sp, 800);
      report.problems = await sp.evaluate(() => ({
        list: window.__floodProblems().map((p) => `${p.kind}: ${p.msg}`),
        badge: document.getElementById("problemsBadge").hidden ? null : document.getElementById("problemsBadge").textContent,
        report: window.__floodProblemsReport().slice(0, 600),
      }));
      await sp.click('.tool[data-open="panel-about"]');
      await settle(sp, 600);
      await sp.evaluate(() => { const d = document.getElementById("problemsBox"); d.open = true; d.scrollIntoView(); });
      await settle(sp, 800);
      report.problemsBadgeAfterOpen = await sp.evaluate(() => document.getElementById("problemsBadge").hidden);
    });
    await shot(sp, "13-problems-log");
    await sp.close();
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
