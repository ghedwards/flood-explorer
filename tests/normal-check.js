// Normal water ("river or lake") against the satellite record: Brisbane
// Port Office (the gauge's own model, and the Brisbane area), plus a few
// presets. Shows how much land the normal-level run wets that satellites
// rarely or never see as water, with screenshots at the gauge.
//   SITE_URL=http://127.0.0.1:8000/ OUT=shots node tests/normal-check.js
const { chromium } = require("playwright");
const fs = require("node:fs");
const path = require("node:path");

const URL = process.env.SITE_URL || "http://127.0.0.1:8000/";
const OUT = process.env.OUT || "shots";

async function ready(page) {
  await page.waitForFunction("window.__floodDownstreamDiag && window.__floodDownstreamDiag()", null, { timeout: 240000 });
  await page.waitForTimeout(2500);
}

async function measure(page, tag) {
  const r = await page.evaluate(async () => Object.assign({ summary: document.getElementById("summaryLine").textContent, area: window.__floodStatus.area || null }, await window.__floodNormalCheck()));
  const ll = await page.evaluate(() => window.__floodGaugeLatLng());
  if (ll) {
    await page.evaluate((c) => { if (window.__floodMap) window.__floodMap.setView(c, 15); }, ll);
  }
  await page.waitForTimeout(3000);
  await page.screenshot({ path: path.join(OUT, `normal-${tag}.png`) });
  // at the normal level itself: only normal water shows
  if (r.gauge && r.gauge.normalLevel != null) {
    await page.evaluate((v) => window.__floodSetLevel(v), r.gauge.normalLevel);
    await page.waitForTimeout(3000);
    r.atNormal = await page.evaluate(() => document.getElementById("summaryLine").textContent);
    await page.screenshot({ path: path.join(OUT, `normal-${tag}-at-normal.png`) });
  }
  return r;
}

(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  const results = {};
  const browser = await chromium.launch();
  const open = async () => {
    const page = await browser.newPage({ viewport: { width: 1280, height: 860 } });
    await page.goto(URL, { waitUntil: "load", timeout: 90000 });
    await page.waitForFunction("window.__floodStatus && window.__floodStatus.mode === 'map'", null, { timeout: 60000 });
    return page;
  };
  const run = async (tag, fn) => {
    const page = await open();
    try {
      await fn(page);
      await ready(page);
      results[tag] = await measure(page, tag);
    } catch (e) {
      results[tag] = { error: String(e).slice(0, 300) };
      await page.screenshot({ path: path.join(OUT, `normal-${tag}-error.png`) }).catch(() => {});
    }
    console.log(tag, JSON.stringify(results[tag]));
    await page.close();
  };

  await run("port-office", async (page) => {
    await page.waitForFunction("window.__floodStatus.national && window.__floodStatus.national.loaded", null, { timeout: 90000 });
    const p = await page.evaluate(() => window.__floodOpenGaugeNamed("port office"));
    results.portOfficeGauge = p;
    if (!p) throw new Error("no gauge named Port Office");
    await page.click(".report-card:last-of-type .js-model");
  });
  const opts = await (await open()).evaluate(() => [...document.querySelectorAll("#area option")].map((o) => [o.value, o.textContent]));
  results.areaOptions = opts.filter(([v, t]) => /brisbane/i.test(v + t));
  const bris = opts.find(([v, t]) => /brisbane/i.test(v + t) && !/^preset:/.test(v));
  if (bris) await run("brisbane-area", async (page) => { await page.selectOption("#area", bris[0]); });
  for (const place of ["maitland", "rockhampton", "lismore"]) {
    await run(place, async (page) => { await page.selectOption("#area", `preset:${place}`); });
  }
  fs.writeFileSync(path.join(OUT, "normal-check.json"), JSON.stringify(results, null, 1));
  await browser.close();
})();
