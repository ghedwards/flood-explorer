const test = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");
const { chromium } = require("playwright");
const site = path.resolve(__dirname, "../../site");
test(
  "bundle runs below a nested path without library/font CDNs",
  { timeout: 60000 },
  async () => {
    const prefix = "/nested/flood/";
    const types = {
      ".html": "text/html",
      ".js": "text/javascript",
      ".css": "text/css",
      ".wasm": "application/wasm",
      ".json": "application/json",
      ".woff2": "font/woff2",
    };
    const server = http.createServer((req, res) => {
      const url = new URL(req.url, "http://localhost");
      const file = path.resolve(
        site,
        decodeURIComponent(url.pathname.slice(prefix.length)) || "index.html",
      );
      if (
        !url.pathname.startsWith(prefix) ||
        !file.startsWith(site + path.sep) ||
        !fs.existsSync(file) ||
        !fs.statSync(file).isFile()
      ) {
        res.writeHead(404).end();
        return;
      }
      res.setHeader(
        "Content-Type",
        types[path.extname(file)] || "application/octet-stream",
      );
      res.end(fs.readFileSync(file));
    });
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    let browser;
    try {
      browser = await chromium.launch({ headless: true });
      const context = await browser.newContext({ serviceWorkers: "block" });
      const cdn = [];
      const errors = [];
      await context.route("**/*", (route) => {
        const url = new URL(route.request().url());
        if (
          /^(unpkg\.com|cdn\.jsdelivr\.net|fonts\.googleapis\.com|fonts\.gstatic\.com)$/.test(
            url.hostname,
          )
        )
          cdn.push(url.href);
        return url.hostname === "127.0.0.1" ? route.continue() : route.abort();
      });
      const page = await context.newPage();
      page.on("pageerror", (err) => errors.push(err.message));
      await page.goto(`http://127.0.0.1:${server.address().port}${prefix}`);
      await page.waitForFunction(
        () => window.L?.map && window.FloodCore?.engine === "rust",
      );
      await page.evaluate(() => document.fonts.ready);
      assert.equal(
        await page.evaluate(() =>
          document.fonts.check('16px "Archivo Variable"'),
        ),
        true,
      );
      // Exercise the bundled module worker directly and ensure its WASM loads.
      const sw = fs.readFileSync(path.join(site, "sw.js"), "utf8");
      const assets = JSON.parse(sw.match(/const BUILD_ASSETS = (\[.*?\]);/)[1]);
      const workerFile = assets.find((p) => /flood-worker-.*\.js$/.test(p));
      const result = await page.evaluate(async (file) => {
        const worker = new Worker(new URL(file, document.baseURI), {
          type: "module",
        });
        try {
          return await new Promise((resolve, reject) => {
            const timer = setTimeout(
              () => reject(new Error("worker timed out")),
              15000,
            );
            worker.onerror = (e) => {
              clearTimeout(timer);
              reject(new Error(e.message));
            };
            worker.onmessage = (e) => {
              if (e.data.id !== 1) return; // readiness is a separate message
              clearTimeout(timer);
              resolve({ error: e.data.error, cells: e.data.a?.N });
            };
            worker.postMessage({
              id: 1,
              grid: window.FloodCore.syntheticTerrain(),
              opts: {},
            });
          });
        } finally {
          worker.terminate();
        }
      }, workerFile);
      assert.ok(!result.error && result.cells > 0, JSON.stringify(result));
      await page.waitForFunction(() => window.__floodStatus?.national?.loaded);
      await page.evaluate(() => window.__floodOpenPanel('panel-layers'));
      const groups = page.locator('#overlayList .layer-group');
      assert.equal(await groups.count(), 4);
      const council = page.locator('#overlayList [data-group="council"]');
      await council.locator('summary').click();
      assert.equal(await council.evaluate(el => el.open), true);
      const selected = await groups.evaluateAll(items => items.map(group => ({
        count: group.querySelector('.layer-group-count').textContent,
        expected: `${group.querySelectorAll('input:checked').length} of ${group.querySelectorAll('input').length} on`,
      })));
      assert.ok(selected.every(group => group.count === group.expected));
      const appSource = fs.readFileSync(path.join(__dirname, '../../viewer/app.js'), 'utf8');
      const ringStart = appSource.indexOf('  function warningGaugeMarker(');
      const ringSource = appSource.slice(ringStart, appSource.indexOf('\n  }', ringStart) + 4);
      const clicks = await page.evaluate(async fn => {
        const box = document.createElement('div'); box.style.cssText = 'position:fixed;left:0;top:0;width:400px;height:300px;z-index:99999'; document.body.appendChild(box);
        const map = window.L.map(box, { zoomControl: false }).setView([-27, 153], 10);
        const calls = [];
        const makeRing = new Function('onDotClick', `${fn}; return warningGaugeMarker`)((feature) => calls.push(feature.properties.name));
        makeRing(window.L, window.L.canvas(), { geometry: { coordinates: [153, -27] }, properties: { name: 'Warned gauge' } }).addTo(map);
        window.__ringAudit = { map, box, calls };
        await new Promise(requestAnimationFrame);
        return calls.length;
      }, ringSource);
      assert.equal(clicks, 0);
      // Eight pixels from the centre hits the warning ring beyond a small gauge dot.
      await page.mouse.click(208, 150);
      assert.deepEqual(await page.evaluate(() => window.__ringAudit.calls), ['Warned gauge']);
      await page.evaluate(() => { window.__ringAudit.map.remove(); window.__ringAudit.box.remove(); delete window.__ringAudit; });
      assert.deepEqual(cdn, []);
      assert.deepEqual(errors, []);
      await context.close();

      // A fresh service worker must cache every lazy chunk before going offline.
      const offline = await browser.newContext();
      const cachedPage = await offline.newPage();
      await cachedPage.goto(
        `http://127.0.0.1:${server.address().port}${prefix}`,
      );
      await cachedPage.evaluate(async () => {
        const registration = await navigator.serviceWorker.ready;
        if (registration.installing)
          await new Promise((resolve) =>
            registration.installing.addEventListener("statechange", resolve),
          );
      });
      await cachedPage.waitForFunction(
        () => !!navigator.serviceWorker.controller,
      );
      const geotiffFile = assets.find((p) => /geotiff-.*\.js$/.test(p));
      await offline.setOffline(true);
      await cachedPage.reload();
      await cachedPage.waitForFunction(
        () => window.L?.map && window.FloodCore?.engine === "rust",
      );
      const dimensions = await cachedPage.evaluate(async (file) => {
        const lib = await import(new URL(file, document.baseURI).href);
        const buffer = lib.writeArrayBuffer([1, 2, 3, 4], {
          width: 2,
          height: 2,
        });
        const tiff = await lib.fromArrayBuffer(buffer);
        const image = await tiff.getImage();
        return [image.getWidth(), image.getHeight()];
      }, geotiffFile);
      assert.deepEqual(dimensions, [2, 2]);
      await offline.close();
    } finally {
      if (browser) await browser.close();
      await new Promise((resolve) => server.close(resolve));
    }
  },
);
