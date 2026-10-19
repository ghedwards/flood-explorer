// Service-worker tile cache check, in Chromium and Firefox: load the map,
// overwrite the cached copies of the visible basemap tiles with opaque
// (no-cors) responses — what a cache filled before the basemap was loaded
// crossOrigin holds — then reload and count tiles that fail to show. A
// cached response whose type doesn't fit the request must never be served.
//   SITE_URL=http://127.0.0.1:8000/ OUT=shots node tests/sw-tiles.js
const pw = require("playwright");
const fs = require("node:fs");
const path = require("node:path");

const URL = process.env.SITE_URL || "http://127.0.0.1:8000/";
const OUT = process.env.OUT || "shots";

const tiles = (page) => page.evaluate(() => {
  const imgs = [...document.querySelectorAll(".leaflet-tile-pane img.leaflet-tile")].filter((i) => /arcgisonline/.test(i.src));
  return {
    srcs: imgs.map((i) => i.src),
    total: imgs.length,
    loaded: imgs.filter((i) => i.classList.contains("leaflet-tile-loaded") && i.naturalWidth > 0).length,
  };
});

async function run(name) {
  const r = { browser: name };
  const browser = await pw[name].launch();
  try {
    const ctx = await browser.newContext({ viewport: { width: 1200, height: 800 } });
    const page = await ctx.newPage();
    await page.goto(URL, { waitUntil: "load", timeout: 90000 });
    await page.waitForFunction("window.__floodStatus && window.__floodStatus.mode === 'map'", null, { timeout: 60000 });
    await page.evaluate(() => navigator.serviceWorker.ready);
    if (!(await page.evaluate(() => !!navigator.serviceWorker.controller))) {
      await page.reload({ waitUntil: "load" });
      await page.waitForFunction("navigator.serviceWorker.controller", null, { timeout: 30000 });
    }
    await page.waitForTimeout(8000);
    const before = await tiles(page);
    r.before = { total: before.total, loaded: before.loaded };
    // replace the cached copies with opaque ones
    r.poisoned = await page.evaluate(async (srcs) => {
      let n = 0;
      for (const s of srcs) { try { await fetch(s, { mode: "no-cors" }); n++; } catch (e) { /* ignore */ } }
      return n;
    }, before.srcs);
    await page.waitForTimeout(2000);
    await page.reload({ waitUntil: "load" });
    await page.waitForFunction("window.__floodStatus && window.__floodStatus.mode === 'map'", null, { timeout: 60000 });
    await page.waitForTimeout(10000);
    const after = await tiles(page);
    r.after = { total: after.total, loaded: after.loaded };
    r.ok = after.total > 0 && after.loaded === after.total;
    await page.screenshot({ path: path.join(OUT, `sw-tiles-${name}.png`) });
  } catch (e) {
    r.ok = false; r.error = String(e).slice(0, 400);
  }
  await browser.close();
  return r;
}

(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  const results = [];
  for (const b of ["chromium", "firefox"]) results.push(await run(b));
  fs.writeFileSync(path.join(OUT, "sw-tiles.json"), JSON.stringify(results, null, 1));
  for (const r of results) {
    console.log(`${r.ok ? "" : "::error::"}sw-tiles ${r.browser}: ${JSON.stringify(r)}`);
  }
  process.exitCode = results.every((r) => r.ok) ? 0 : 1;
})();
