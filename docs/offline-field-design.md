# Offline field mode: close the gaps

## Problem

The service worker already does the heavy lifting — app shell + wasm
pre-cached per build, runtime caches with trimming for tiles (4000),
terrain (120) and map-service answers (600), network-first with a
timeout and cache fallback. But a real offline property check still
breaks in one place.

## Research (the actual gap)

`viewer/sw.js` routes to the API cache by
`/(MapServer|FeatureServer|ImageServer|wms|wfs|ows|WCSServer)/` hosts.
The **impact data comes from Overpass** (`overpass-api.de`,
`maps.mail.ru/osm/tools/overpass`, `overpass.kumi.systems` — ~4327),
which matches none of those patterns → buildings/roads/sites are *not*
available offline, so the flagship offline use ("is this property cut
off?") fails exactly where it matters most. ABS census fetches hit
`/FeatureServer`-style endpoints (covered ✓).

## Design

1. **Route Overpass to the API cache**: add the three Overpass hosts to
   the API-cache predicate. Overpass answers are big (hundreds of KB);
   lower that cache's trim limit to keep LRU honest (e.g. 600 → 400)
   and rely on the same oldest-first trim.
2. **Prefetch button.** In the Layers/About panel: "Prepare this area
   for offline use" — fires the area's known requests (impact data for
   the current area, national shell already cached) and reports what
   landed in the cache. Simple loop over cached-check + fetch.
3. **Offline indicator.** `navigator.onLine` + SW reachability: a small
   dot/label on the screen header ("offline — showing saved data"),
   and `say()` when a fetch fell back to cache (the SW could post a
   message to clients on cache-fallback; throttle to once per episode).
4. **Quota honesty.** If `caches.put` rejects (quota), drop the oldest
   half of that cache and retry once; if it still fails, stop caching
   that cache silently (tiles are nice-to-have, the shell is not).

## Test plan

- Node: the routing predicate is a pure function — test Overpass hosts
  match; quota-retry helper tested with a fake cache.
- Manual: load an area online, kill the network, reload, check a
  property, confirm impact numbers render from cache.

## Effort

S for the caching fix (the real gap); M with the prefetch UI and
indicators.
