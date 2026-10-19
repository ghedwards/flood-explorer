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
  await step("open3d", async () => {
    await page.evaluate(() => window.__floodOpen3D());
    await page.waitForSelector("#view3d canvas", { timeout: 30000 });
  });
  await page.waitForTimeout(6000);
  await shot("1-3d-opening");
  await page.waitForTimeout(20000);
  await state3d("settled");
  await shot("2-3d-settled");

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

  } catch (e) {
    report.fatal = String(e).slice(0, 400);
    console.log(`::error::shots3d stopped: ${report.fatal}`);
  }
  report.totalMs = Date.now() - t0;
  fs.writeFileSync(path.join(OUT, "report.json"), JSON.stringify(report, null, 1));
  await browser.close();
  console.log(JSON.stringify(report.steps));
})();
