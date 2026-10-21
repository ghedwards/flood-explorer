/* Flood Explorer service worker: keeps the app working when the signal drops.
 *
 * - The app itself and the national data are fetched fresh when online and
 *   served from the cache when not.
 * - Bundled libraries and fonts are cached with each app version.
 * - Map tiles, terrain (Geoscience Australia elevation) and map-service
 *   answers (councils, states, census areas) are kept as they are used, so
 *   areas you have looked at and models you have built work offline. Each
 *   of these caches is trimmed to a set number of entries, oldest first.
 * - Live readings from the data broker are fetched fresh when online and the
 *   last copy is served when not, so the map shows the latest levels offline.
 * The build stamps its version below, so each deploy refreshes the app.
 */
const VERSION = '__BUILD__';
const APP = `app-${VERSION}`;
// tiles-v2: drops v1, which held opaque copies of tiles the map now loads
// crossOrigin (served to it, they failed and were never refetched)
const TILES = 'tiles-v2', TERRAIN = 'terrain-v1', ELEV = 'elev-v1', API = 'api-v1', LIVE = 'live-v1';
const LIMITS = { [TILES]: 4000, [TERRAIN]: 120, [ELEV]: 800, [API]: 400, [LIVE]: 40 };
// the live data broker (rust/flood-broker): Lambda function URLs, or any host serving its paths
const BROKER_PATH = /^\/v1\/(readings|levels|history)$/;

// Vite replaces this list with every emitted chunk, worker, font and WASM asset.
const BUILD_ASSETS = [];
const SHELL = [
  './', 'index.html', 'manifest.webmanifest', ...BUILD_ASSETS,
  'icons/icon-192.png', 'icons/icon-512.png', 'icons/apple-touch-icon.png',
  'data/national/gauges-core.min.json', 'data/national/storages.geojson', 'data/national/readings.json', 'data/national/meta.json',
];
const TILE_HOSTS = /(^|\.)basemaps\.cartocdn\.com$|^tile\.openstreetmap\.org$|^server\.arcgisonline\.com$|^tiles\.arcgis\.com$|^[a-c]\.tile\.opentopomap\.org$|^spatial-img\.information\.qld\.gov\.au$|^tilecache\.rainviewer\.com$/;
// 3D terrain tiles (AWS Terrain Tiles, terrarium PNGs): immutable per z/x/y
const TERRAIN_TILES = /^s3\.amazonaws\.com$/;

self.addEventListener('install', (e) => {
  e.waitUntil((async () => {
    const app = await caches.open(APP);
    // one at a time, so a missing optional file doesn't stop the rest
    await Promise.all(SHELL.map((u) => app.add(new Request(u, { cache: 'reload' })).catch(() => {})));
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', (e) => {
  e.waitUntil((async () => {
    const keep = new Set([APP, TILES, TERRAIN, ELEV, API, LIVE]);
    for (const k of await caches.keys()) if (!keep.has(k)) await caches.delete(k);
    await self.clients.claim();
  })());
});

async function trim(name) {
  const max = LIMITS[name];
  if (!max) return;
  const c = await caches.open(name);
  const keys = await c.keys();
  for (let i = 0; i < keys.length - max; i++) await c.delete(keys[i]);
}

// a cached response may only be served to a request whose mode allows that
// response type: an opaque response only answers a no-cors request (a
// crossOrigin <img>, fetch() or WebGL texture rejects it, so the tile stays
// dark for good), and a cors response is rejected when the request was a
// plain <img> (no-cors). Firefox enforces both strictly; Chromium mostly
// does too. An unusable copy is refetched and replaced.
function usable(req, res) {
  if (!res || !res.type) return false;
  if (res.type === 'opaque') return req.mode === 'no-cors';
  if (res.type === 'cors') return req.mode !== 'no-cors' && req.mode !== 'navigate';
  return res.type === 'basic' || res.type === 'default';
}

// fresh when online (within a few seconds), the cached copy otherwise
async function networkFirst(req, name, waitMs) {
  const c = await caches.open(name);
  const net = fetch(req).then((res) => {
    if (res && (res.ok || res.type === 'opaque')) c.put(req, res.clone()).then(() => trim(name)).catch(() => {});
    return res;
  });
  try {
    const res = await Promise.race([net, new Promise((_, rej) => setTimeout(() => rej(new Error('slow')), waitMs))]);
    if (!res.ok && res.type !== 'opaque') throw new Error(`HTTP ${res.status}`);
    return res;
  } catch (err) {
    const hit = await c.match(req, { ignoreVary: true }) || (name === APP ? await c.match(req, { ignoreSearch: true }) : null);
    // no compatible copy: a slow network that eventually answers still wins
    return usable(req, hit) ? hit : net;
  }
}

async function cacheFirst(req, name) {
  const c = await caches.open(name);
  const hit = await c.match(req, { ignoreVary: true });
  if (usable(req, hit)) return hit;
  const res = await fetch(req);
  if (res && (res.ok || res.type === 'opaque')) c.put(req, res.clone()).then(() => trim(name)).catch(() => {});
  return res;
}

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  let url;
  try { url = new URL(req.url); } catch (err) { return; }
  if (url.origin === self.location.origin) {
    if (url.pathname.endsWith('/sw.js')) return;
    e.respondWith(networkFirst(req, APP, url.pathname.includes('/data/') ? 6000 : 4000));
    return;
  }
  // live readings: fresh within 6 s (the app gives up at 8), else the last copy
  if (BROKER_PATH.test(url.pathname)) {
    e.respondWith(networkFirst(req, LIVE, 6000));
    return;
  }
  if (TERRAIN_TILES.test(url.hostname) && url.pathname.startsWith('/elevation-tiles-prod/')) {
    e.respondWith(cacheFirst(req, ELEV));   // its own cache: ~100 KB each, kept apart from imagery
    return;
  }
  if (TILE_HOSTS.test(url.hostname) || /\/tile\/\d+\/\d+\/\d+/.test(url.pathname)) {
    e.respondWith(cacheFirst(req, TILES));
    return;
  }
  // terrain for models: the same window always returns the same heights
  if (url.hostname === 'services.ga.gov.au' && /GetCoverage/i.test(url.search)) {
    e.respondWith(cacheFirst(req, TERRAIN));
    return;
  }
  // map-service answers (feature queries, exported images, census areas)
  if (/\/(MapServer|FeatureServer|ImageServer|wms|wfs|ows|WCSServer)\b/i.test(url.pathname) || url.hostname === 'ows.dea.ga.gov.au') {
    e.respondWith(networkFirst(req, API, 8000));
    return;
  }
  // impact data comes from Overpass (OpenStreetMap): it must ride the same
  // API cache or "is this property cut off?" breaks offline (the whole
  // reason offline mode exists).
  if (/overpass-api\.de$|overpass\.kumi\.systems$|maps\.mail\.ru$/.test(url.hostname)) {
    e.respondWith(networkFirst(req, API, 8000));
    return;
  }
});
