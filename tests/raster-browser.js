// Deterministic coverage of delayed Esri images, without external services.
const { chromium } = require('playwright');
const { readFileSync } = require('node:fs');
const path = require('node:path');

(async () => {
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    const errors = [];
    page.on('pageerror', e => errors.push(e.stack || String(e)));
    await page.setContent('<div id="map" style="height:400px;width:600px"></div>');
    await page.addScriptTag({ path: require.resolve('leaflet/dist/leaflet.js') });
    await page.addScriptTag({ path: path.resolve('node_modules/esri-leaflet/dist/esri-leaflet.js') });
    if (!process.argv.includes('--original')) {
      await page.addScriptTag({ content: readFileSync('viewer/safe-raster.js', 'utf8').replace('export function guardRasterLayer', 'window.guardRasterLayer = function') });
    }
    const result = await page.evaluate(() => {
      const L = window.L;
      const map = L.map('map', { zoomAnimation: false }).setView([-27, 153], 12);
      const layer = L.esri.dynamicMapLayer({ url: 'https://example.invalid/MapServer', minZoom: 10, opacity: .6, zIndex: 4 });
      // Drive the real Esri renderer directly, without requests or timers.
      layer.metadata = () => {};
      const update = layer._update;
      layer._update = () => {};
      if (window.guardRasterLayer) window.guardRasterLayer(L, layer);
      const add = () => layer.addTo(map);
      const render = () => {
        const before = new Set(Object.values(map._layers));
        layer._renderImage('data:image/png;base64,broken', map.getBounds());
        return Object.values(map._layers).find(x => !before.has(x) && x instanceof L.ImageOverlay);
      };
      add();
      const delayed = render();
      map.removeLayer(layer);
      delayed.fire('error'); // used to dereference layer._map === null
      if (map.hasLayer(delayed)) throw new Error('Detached layer left a pending image on the map');
      delayed.fire('load');
      add();
      const current = render();
      current.fire('load', { target: current });
      if (layer._currentImage !== current || current.options.opacity !== .6) throw new Error('Current image not displayed');
      const stale = render();
      map.setView([-28, 153], 12);
      stale.fire('load', { target: stale });
      if (map.hasLayer(stale) || layer._currentImage !== current) throw new Error('Outdated image replaced the current one');
      map.removeLayer(layer);
      add();
      map.setZoom(8);
      update.call(layer); // used to dereference currentImage._map === null
      map.removeLayer(layer);
      map.remove();
      return 'Delayed error/load, outdated bounds, removal and re-add below minZoom passed';
    });
    await page.waitForTimeout(50);
    if (errors.length) throw new Error(errors.join('\n'));
    console.log(result);
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
