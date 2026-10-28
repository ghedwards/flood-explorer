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
const BROKER_PATH = /^\/v1\/(readings|now|series|levels|history)$/;

// Vite replaces this list with every emitted chunk, worker, font and WASM asset.
const BUILD_ASSETS = [];
const SHELL = [
  './', 'index.html', 'tsunami.html', 'manifest.webmanifest', ...BUILD_ASSETS,
  ...['places', 'ptha18-hazard', 'gold-coast-seaway', 'pine-estuary', 'brisbane-mouth', 'currumbin', 'sunshine-coast', 'port-macquarie', 'wollongong', 'moreton', 'gold-coast', 'coffs', 'newcastle', 'sydney'].map(id => `tsunami-data/${id}.json`),
  'tsunami-data/scenarios/index.json', 'tsunami-data/scenarios/1450-5.json', 'tsunami-data/scenarios/1570-2.json',
  ...['moderate-kermadec-tonga-kermadectonga2-38914-1450-5', 'large-new-hebrides-newhebrides2-11816-1450-5', 'distant-mega-quake-south-america-southamerica-146274-1450-5', 'very-large-kermadec-tonga-kermadectonga2-42930-1450-5', 'moderate-kermadec-tonga-kermadectonga2-41565-1570-2', 'large-new-hebrides-newhebrides2-12022-1570-2', 'distant-mega-quake-south-america-southamerica-146274-1570-2', 'very-large-kermadec-tonga-kermadectonga2-43746-1570-2'].map(id => `tsunami-data/scenarios/${id}.csv`),
  'tsunami-data/extents/index.json', 'tsunami-data/extents/gold-coast-seaway.json', 'tsunami-data/extents/currumbin.json', 'tsunami-data/extents/pine-estuary.json',
  'icons/icon-192.png', 'icons/icon-512.png', 'icons/apple-touch-icon.png',
  'data/national/gauges-core.min.json', 'data/national/storages.geojson', 'data/national/readings.json', 'data/national/meta.json',
];
const TILE_HOSTS = /(^|\.)basemaps\.cartocdn\.com$|^tile\.openstreetmap\.org$|^server\.arcgisonline\.com$|^tiles\.arcgis\.com$|^[a-c]\.tile\.opentopomap\.org$|^spatial-img\.information\.qld\.gov\.au$|^tilecache\.rainviewer\.com$/;
// 3D terrain tiles (AWS Terrain Tiles, terrarium PNGs): immutable per z/x/y
const TERRAIN_TILES = /^s3\.amazonaws\.com$/;

self.addEventListener('install', (e) => {
  e.waitUntil((async () => {
    try {
      const app = await caches.open(APP);
      // one at a time, so a missing optional file doesn't stop the rest
      await Promise.all(SHELL.map((u) => app.add(new Request(u, { cache: 'reload' })).catch(() => {})));
    } catch (err) { /* a broken cache storage must not stop install */ }
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', (e) => {
  e.waitUntil((async () => {
    try {
      const keep = new Set([APP, TILES, TERRAIN, ELEV, API, LIVE]);
      for (const k of await caches.keys()) if (!keep.has(k)) await caches.delete(k);
    } catch (err) { /* an old cache left behind is harmless */ }
    await self.clients.claim();
  })());
});

async function trim(name) {
  const max = LIMITS[name];
  if (!max) return;
  // nothing here is worth failing a request over: storage can break (a
  // corrupt or full cache database — Firefox refuses Cache-API calls then,
  // and every tile the worker answered would go black until the storage is
  // cleared), so treat each cache call as optional
  try {
    const c = await caches.open(name);
    const keys = await c.keys();
    for (let i = 0; i < keys.length - max; i++) await c.delete(keys[i]);
  } catch (err) { /* no trim this time */ }
}

// open a cache, or null when the cache storage refuses (corrupt/full); the
// callers then answer from the network only
async function openCache(name) {
  try { return await caches.open(name); } catch (err) { return null; }
}

// a cache hit that can be served to this request mode: an opaque response
// only answers a no-cors request (a crossOrigin <img>, fetch() or WebGL
// texture rejects it, so the tile stays dark for good), and a cors response
// is rejected when the request was a plain <img> (no-cors). Firefox enforces
// both strictly; Chromium mostly does too.
function usable(req, res) {
  if (!res || !res.type) return false;
  if (res.type === 'opaque') return req.mode === 'no-cors';
  if (res.type === 'cors') return req.mode !== 'no-cors' && req.mode !== 'navigate';
  return res.type === 'basic' || res.type === 'default';
}

// a match that survives a broken cache: nothing cached is then usable
async function find(c, req, opts) {
  try { return await c.match(req, Object.assign({ ignoreVary: true }, opts)); } catch (err) { return null; }
}

// fresh when online (within a few seconds), the cached copy otherwise
async function networkFirst(req, name, waitMs) {
  const c = await openCache(name);
  const net = fetchWithin(req, Math.max(NET_TIMEOUT_MS, waitMs * 4)).then((res) => {
    if (c && res && (res.ok || res.type === 'opaque')) try { c.put(req, res.clone()).then(() => trim(name)).catch(() => {}); } catch (err) { /* no copy kept */ }
    return res;
  });
  const hit = c && (await find(c, req) || (name === APP ? await find(c, req, { ignoreSearch: true }) : null));
  try {
    const res = await Promise.race([net, new Promise((_, rej) => setTimeout(() => rej(new Error('slow')), waitMs))]);
    if (!res.ok && res.type !== 'opaque') throw new Error(`HTTP ${res.status}`);
    return res;
  } catch (err) {
    // no compatible copy: a slow network that eventually answers still wins
    return usable(req, hit) ? hit : net;
  }
}

// a network request that hangs would never fail, so the page could neither
// get the tile nor switch basemap: give up after this long
const NET_TIMEOUT_MS = 20000;
function fetchWithin(req, ms) {
  // Promise.resolve().then keeps a fetch that throws outright (as an
  // offline storage state can) inside the promise chain
  if (typeof AbortController === 'undefined' || typeof setTimeout !== 'function') return Promise.resolve().then(() => fetch(req));
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), ms);
  const done = () => { if (typeof clearTimeout === 'function') clearTimeout(t); };
  return Promise.resolve().then(() => fetch(req, { signal: ac.signal })).then((r) => { done(); return r; }, (e) => { done(); throw e; });
}

// the cache first (immutable per address), refetch and replace when the copy
// can't be served to this request
async function cacheFirst(req, name) {
  const c = await openCache(name);
  const hit = c && await find(c, req);
  if (usable(req, hit)) return hit;
  const res = await fetchWithin(req, NET_TIMEOUT_MS);
  if (c && res && (res.ok || res.type === 'opaque')) try { c.put(req, res.clone()).then(() => trim(name)).catch(() => {}); } catch (err) { /* no copy kept */ }
  return res;
}

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  let url;
  try { url = new URL(req.url); } catch (err) { return; }
  if (url.pathname === '/v1/elev') {
    e.respondWith(cacheFirst(req, TERRAIN));
    return;
  }
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
