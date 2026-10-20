// Screenshots of the 3D view for review: opens the site, builds a preset
// model, opens 3D and captures it from several camera poses, plus the
// state the view reports and any console errors.
//   SITE_URL=https://... PLACE=rockhampton OUT=shots node tests/shots3d.js
const { chromium } = require("playwright");
const fs = require("node:fs");
const path = require("node:path");

const URL = process.env.SITE_URL || "https://ghedwards.github.io/flood-explorer/";
const PLACE = process.env.PLACE || "rockhampton";
const OUT = process.env.OUT || "shots";

process.on("unhandledRejection", (e) => { console.log(`::error::unhandled: ${String(e).slice(0, 300)}`); });
(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  const report = { url: URL, place: PLACE, steps: [], errors: [], requests: { failed: [] } };
  const browser = await chromium.launch({ args: ["--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader"] });
  const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
  page.on("response", (r) => { if (r.status() >= 400) { report.http = report.http || []; if (report.http.length < 30) report.http.push(`${r.status()} ${r.url().slice(0, 200)}`); } });
  page.on("pageerror", (e) => report.errors.push(String(e).slice(0, 400)));
  page.on("console", (m) => { if (m.type() === "error" || m.type() === "warning") report.errors.push(`${m.type()}: ${m.text().slice(0, 300)}`); });
  page.on("requestfailed", (r) => { if (report.requests.failed.length < 40) report.requests.failed.push(`${r.failure() && r.failure().errorText} ${r.url().slice(0, 160)}`); });
  const t0 = Date.now();
  const step = async (name, fn) => {
    const s = Date.now();
    try { await fn(); report.steps.push({ name, ok: true, ms: Date.now() - s }); } catch (e) { report.steps.push({ name, ok: false, ms: Date.now() - s, error: String(e).slice(0, 300) }); }
  };
  const shot = async (name) => {
    try { await page.screenshot({ path: path.join(OUT, `${name}.png`), timeout: 60000 }); } catch (e) {
      report.steps.push({ name: `shot ${name}`, ok: false, error: String(e).slice(0, 300) });
      console.log(`::error::screenshot ${name} failed: ${String(e).slice(0, 200)}`);
    }
  };
  const state3d = async (label) => {
    const st = await page.evaluate(() => (window.__flood3DState ? window.__flood3DState() : null)).catch((e) => String(e));
    report[`state_${label}`] = st;
  };

  try {
  await step("load", async () => {
    await page.goto(URL, { waitUntil: "networkidle", timeout: 90000 });
    await page.waitForFunction("window.__floodStatus && window.__floodStatus.mode === 'map'", null, { timeout: 60000 });
  });
  await step("model", async () => {
    await page.selectOption("#area", `preset:${PLACE}`);
    await page.waitForFunction("window.__floodStatus.local && window.__floodStatus.local.ok === true", null, { timeout: 120000 });
    await page.waitForTimeout(4000);
  });
  await shot("0-map-2d");
  // imagery tone by zoom over the preset (is z<=9 really darker than z>=10?)
  await step("imagery-probe", async () => {
    report.imageryProbe = await page.evaluate(async () => {
      const lon = 150.51, lat = -23.38, out = {};
      const load = (u) => new Promise((res) => { const im = new Image(); im.crossOrigin = "anonymous"; im.onload = () => res(im); im.onerror = () => res(null); im.src = u; });
      for (const z of [7, 8, 9, 10, 11, 12]) {
        const n = 2 ** z, la = (lat * Math.PI) / 180;
        const x = Math.floor(((lon + 180) / 360) * n), y = Math.floor(((1 - Math.log(Math.tan(la) + 1 / Math.cos(la)) / Math.PI) / 2) * n);
        const im = await load(`https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/${z}/${y}/${x}`);
        if (!im) { out[z] = null; continue; }
        const c = document.createElement("canvas"); c.width = c.height = 8;
        const ctx = c.getContext("2d"); ctx.drawImage(im, 0, 0, im.naturalWidth, im.naturalHeight, 0, 0, 8, 8);
        const d = ctx.getImageData(0, 0, 8, 8).data, m = [0, 0, 0];
        for (let i = 0; i < d.length; i += 4) { m[0] += d[i]; m[1] += d[i + 1]; m[2] += d[i + 2]; }
        out[z] = m.map((v) => Math.round(v / 64));
      }
      return out;
    });
  });
  await step("open3d", async () => {
    await page.evaluate(() => window.__floodOpen3D());
    await page.waitForSelector("#view3d canvas", { timeout: 30000 });
  });
  await page.waitForTimeout(6000);
  await shot("1-3d-opening");
  await page.waitForTimeout(20000);
  await state3d("settled");
  await shot("2-3d-settled");
  // the same view as plain relief colours (is any band the imagery or the geometry?)
  await step("relief-settled", async () => { await page.click("#mode3d"); });
  await page.waitForTimeout(3000);
  await shot("2b-3d-settled-relief");
  await step("imagery-back", async () => { await page.click("#mode3d"); });
  await page.waitForTimeout(3000);

  const box = { x: 700, y: 450 };
  // zoom in towards the centre
  await step("zoom-in", async () => {
    await page.mouse.move(box.x, box.y);
    for (let i = 0; i < 6; i++) { await page.mouse.wheel(0, -400); await page.waitForTimeout(250); }
  });
  await page.waitForTimeout(20000);
  await state3d("zoomed");
  await shot("3-3d-zoomed-in");
  // the water against the ground at 5x, then back to the default
  const setExag = async (v) => page.evaluate((val) => { const r = document.getElementById("exag3d"); if (r) { r.value = String(val); r.dispatchEvent(new Event("input")); } }, v);
  await step("exaggeration-5", async () => { await setExag(5); });
  await page.waitForTimeout(3000);
  await shot("3b-3d-exaggeration-5");
  await step("exaggeration-default", async () => { await setExag(1.5); });
  await page.waitForTimeout(1500);
  // street level: imagery keeps refining past the terrain's z14
  await step("zoom-street", async () => {
    await page.mouse.move(box.x, box.y);
    for (let i = 0; i < 7; i++) { await page.mouse.wheel(0, -400); await page.waitForTimeout(250); }
  });
  await page.waitForTimeout(20000);
  await state3d("street");
  await shot("3c-3d-street");
  await step("zoom-back", async () => {
    await page.mouse.move(box.x, box.y);
    for (let i = 0; i < 7; i++) { await page.mouse.wheel(0, 400); await page.waitForTimeout(250); }
  });
  await page.waitForTimeout(5000);
  // MapControls: right-drag tilts (up) and turns (sideways); left-drag pans
  const drag = async (button, dx, dy, n = 12) => {
    await page.mouse.move(box.x, box.y);
    await page.mouse.down({ button });
    for (let i = 1; i <= n; i++) await page.mouse.move(box.x + (dx * i) / n, box.y + (dy * i) / n, { steps: 2 });
    await page.mouse.up({ button });
  };
  await step("tilt", async () => { await drag("right", 0, -150); });
  await page.waitForTimeout(15000);
  await state3d("tilted");
  await shot("4-3d-low-angle");
  await step("turn", async () => { await drag("right", 300, 0); });
  await page.waitForTimeout(15000);
  await shot("5-3d-turned");
  // pan with the left button
  await step("pan", async () => { await drag("left", -250, 120); });
  await page.waitForTimeout(12000);
  await state3d("panned");
  await shot("5b-3d-panned");
  // double-click flies to the point
  await step("fly-to", async () => { await page.mouse.dblclick(box.x + 100, box.y + 60); });
  await page.waitForTimeout(15000);
  await state3d("flown");
  await shot("5c-3d-fly-to");
  // zoom right out
  await step("zoom-out", async () => {
    await page.mouse.move(box.x, box.y);
    for (let i = 0; i < 16; i++) { await page.mouse.wheel(0, 500); await page.waitForTimeout(250); }
  });
  await page.waitForTimeout(25000);
  await state3d("zoomed_out");
  await shot("6-3d-zoomed-out");
  // vertical exaggeration down to 2x
  await step("exaggeration", async () => {
    await page.evaluate(() => { const r = document.getElementById("exag3d"); if (r) { r.value = "2"; r.dispatchEvent(new Event("input")); } });
  });
  await page.waitForTimeout(3000);
  await shot("7-3d-exaggeration-2");
  // relief colours instead of imagery
  await step("relief", async () => { await page.click("#mode3d"); });
  await page.waitForTimeout(3000);
  await state3d("relief");
  await shot("8-3d-relief");
  // switching the basemap while in 3D re-drapes the terrain with it
  await step("imagery-again", async () => { await page.click("#mode3d"); });
  await step("basemap-streets", async () => { await page.evaluate(() => window.__floodSetBasemap("Streets")); });
  await page.waitForTimeout(12000);
  await state3d("streets");
  await shot("8b-3d-streets-basemap");
  await step("basemap-satellite", async () => { await page.evaluate(() => window.__floodSetBasemap("Satellite (Esri)")); });
  await page.waitForTimeout(8000);
  // the Scenario button brings its panel back over the 3D view
  await step("scenario-panel", async () => { await page.click('.tool[data-open="panel-scenario"]'); });
  await page.waitForTimeout(2000);
  await shot("9-3d-scenario-panel");
  await step("scenario-panel-hide", async () => { await page.click('.tool[data-open="panel-scenario"]'); });


  // the DEM-H fallback: forced with ?terrain3d=demh (a fresh page, same preset)
  const page2 = await browser.newPage({ viewport: { width: 1400, height: 900 } });
  page2.on("pageerror", (e) => report.errors.push(`demh page: ${String(e).slice(0, 300)}`));
  page2.on("console", (m) => { if (m.type() === "error") report.errors.push(`demh page: ${m.text().slice(0, 250)}`); });
  await step("demh-load", async () => {
    await page2.goto(`${URL}${URL.includes("?") ? "&" : "?"}terrain3d=demh`, { waitUntil: "networkidle", timeout: 90000 });
    await page2.waitForFunction("window.__floodStatus && window.__floodStatus.mode === 'map'", null, { timeout: 60000 });
    await page2.selectOption("#area", `preset:${PLACE}`);
    await page2.waitForFunction("window.__floodStatus.local && window.__floodStatus.local.ok === true", null, { timeout: 120000 });
    await page2.waitForTimeout(3000);
    await page2.evaluate(() => window.__floodOpen3D());
    await page2.waitForSelector("#view3d canvas", { timeout: 30000 });
  });
  await page2.waitForTimeout(45000);
  report.state_demh = await page2.evaluate(() => (window.__flood3DState ? window.__flood3DState() : null)).catch((e) => String(e));
  try { await page2.screenshot({ path: path.join(OUT, "10-3d-demh-settled.png"), timeout: 60000 }); } catch (e) { report.steps.push({ name: "shot demh", ok: false, error: String(e).slice(0, 200) }); }
  await step("demh-zoom", async () => {
    await page2.mouse.move(700, 450);
    for (let i = 0; i < 6; i++) { await page2.mouse.wheel(0, -400); await page2.waitForTimeout(250); }
  });
  await page2.waitForTimeout(30000);
  report.state_demh_zoomed = await page2.evaluate(() => (window.__flood3DState ? window.__flood3DState() : null)).catch((e) => String(e));
  try { await page2.screenshot({ path: path.join(OUT, "11-3d-demh-zoomed.png"), timeout: 60000 }); } catch (e) { report.steps.push({ name: "shot demh zoomed", ok: false, error: String(e).slice(0, 200) }); }
  } catch (e) {
    report.fatal = String(e).slice(0, 400);
    console.log(`::error::shots3d stopped: ${report.fatal}`);
  }
  report.totalMs = Date.now() - t0;
  fs.writeFileSync(path.join(OUT, "report.json"), JSON.stringify(report, null, 1));
  await browser.close();
  console.log(JSON.stringify(report.steps));
})();
