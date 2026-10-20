// River below the gauge, across a spread of preset towns: how deep the
// normal-level run puts water on the channel downstream (should be about
// 0.3 m), and how much land it wets away from mapped channels.
//   SITE_URL=http://127.0.0.1:8000/ OUT=shots node tests/downstream-check.js
const { chromium } = require("playwright");
const fs = require("node:fs");
const path = require("node:path");

const URL = process.env.SITE_URL || "http://127.0.0.1:8000/";
const OUT = process.env.OUT || "shots";
const PLACES = (process.env.PLACES || "gympie,lismore,grantham,ipswich,maitland,rockhampton,launceston,wagga,gundagai,katherine").split(",");

(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  const results = {};
  const browser = await chromium.launch();
  for (const place of PLACES) {
    const page = await browser.newPage({ viewport: { width: 1200, height: 800 } });
    const t0 = Date.now();
    try {
      await page.goto(URL, { waitUntil: "load", timeout: 90000 });
      await page.waitForFunction("window.__floodStatus && window.__floodStatus.mode === 'map'", null, { timeout: 60000 });
      await page.selectOption("#area", `preset:${place}`);
      await page.waitForFunction("window.__floodStatus.local && window.__floodStatus.local.ok === true", null, { timeout: 240000 });
      await page.waitForTimeout(2500);
      results[place] = await page.evaluate(() => Object.assign({ summary: document.getElementById("summaryLine").textContent }, window.__floodDownstreamDiag()));
      results[place].sec = Math.round((Date.now() - t0) / 1000);
      await page.screenshot({ path: path.join(OUT, `ds-${place}.png`) });
    } catch (e) {
      results[place] = { error: String(e).slice(0, 300) };
    }
    console.log(place, JSON.stringify(results[place]));
    await page.close();
  }
  fs.writeFileSync(path.join(OUT, "downstream.json"), JSON.stringify(results, null, 1));
  await browser.close();
})();
