// Screenshots of the 3D view for review: opens the site, builds a preset
// model, opens 3D and captures it from several camera poses, plus the
// state the view reports and any console errors.
//   SITE_URL=https://... PLACE=rockhampton OUT=shots node tests/shots3d.js
const { chromium } = require("playwright");
const fs = require("node:fs");
const path = require("node:path");

const URL = process.env.SITE_URL || "https://ghedwards.github.io/brisbane-flood-explorer/";
const PLACE = process.env.PLACE || "rockhampton";
const OUT = process.env.OUT || "shots";

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
  const shot = async (name) => { await page.screenshot({ path: path.join(OUT, `${name}.png`) }); };
  const state3d = async (label) => {
    const st = await page.evaluate(() => (window.__flood3DState ? window.__flood3DState() : null)).catch((e) => String(e));
    report[`state_${label}`] = st;
  };

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
  // tilt towards the horizon (left-drag down rotates in OrbitControls)
  await step("tilt", async () => {
    await page.mouse.move(box.x, box.y);
    await page.mouse.down();
    for (let i = 0; i < 12; i++) await page.mouse.move(box.x, box.y - 12 * i, { steps: 2 });
    await page.mouse.up();
  });
  await page.waitForTimeout(15000);
  await shot("4-3d-low-angle");
  // turn around
  await step("turn", async () => {
    await page.mouse.move(box.x, box.y);
    await page.mouse.down();
    for (let i = 0; i < 12; i++) await page.mouse.move(box.x + 25 * i, box.y, { steps: 2 });
    await page.mouse.up();
  });
  await page.waitForTimeout(15000);
  await shot("5-3d-turned");
  // zoom right out
  await step("zoom-out", async () => {
    await page.mouse.move(box.x, box.y);
    for (let i = 0; i < 14; i++) { await page.mouse.wheel(0, 500); await page.waitForTimeout(250); }
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

  report.totalMs = Date.now() - t0;
  fs.writeFileSync(path.join(OUT, "report.json"), JSON.stringify(report, null, 1));
  await browser.close();
  console.log(JSON.stringify(report.steps));
})();
