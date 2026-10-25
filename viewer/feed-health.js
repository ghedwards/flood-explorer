// Feed transport and shape failures stay separate from the last usable data.
const object = value => !!value && typeof value === 'object' && !Array.isArray(value);
export const FEED_NAMES = {
  wdo: 'Water Data Online', qld: 'Queensland river levels', rain: 'Rain forecasts',
  sea: 'Storm tides', warnings: 'Flood warnings', warningAreas: 'Warning areas',
  floodclass: 'Flood classes', roads: 'Road events', emergency: 'Emergency warnings',
};

export function feedError(error) {
  if (error?.name === 'TimeoutError' || error?.name === 'AbortError') return 'The request timed out.';
  if (error instanceof SyntaxError) return 'The service returned unreadable data.';
  if (error instanceof TypeError) return 'The service could not be reached (network or browser access failure).';
  return String(error?.message || error || 'The service did not answer.');
}

export function readingsDocument(raw, previous = {}) {
  if (!object(raw) || !object(raw.level) || !Number.isFinite(Date.parse(raw.fetched)))
    throw new Error('The live readings service returned an invalid readings document.');
  const data = { ...raw }, issues = [];
  const keep = (key, valid, empty) => {
    if (raw[key] == null) { data[key] = previous[key] ?? empty; return; }
    if (valid(raw[key])) return;
    data[key] = previous[key] ?? empty;
    issues.push({ name: FEED_NAMES[key] || key, reason: 'Invalid feed data; keeping the previous copy.' });
  };
  const records = value => object(value) && Object.values(value).every(object);
  const readings = value => records(value) && Object.values(value).every(r =>
    !r.latest || (Array.isArray(r.latest) && r.latest.length >= 2));
  keep('level', readings, {});
  keep('storage', readings, {});
  keep('rain', value => object(value) && Object.values(value).every(r =>
    Array.isArray(r) && r.length >= 2 && r.every(x => x == null || typeof x === 'number')), {});
  for (const key of ['sea', 'rainObs', 'floodclass']) keep(key, records, {});
  keep('watch', value => Array.isArray(value) && value.every(object), []);
  keep('warnings', value => object(value) && Array.isArray(value.warnings) && value.warnings.every(object), { ok: false, warnings: [] });
  for (const key of ['roads', 'emergency'])
    keep(key, value => object(value) && Array.isArray(value.items) && value.items.every(object), { items: [] });
  keep('sources', value => object(value) && Object.values(value).every(object), {});
  keep('errors', value => Array.isArray(value) && value.every(x => typeof x === 'string'), []);
  for (const [key, source] of Object.entries(data.sources)) {
    if ((key === 'roads' || key === 'emergency') && Object.values(data[key].sources || {}).some(value => typeof value === 'string' && value.startsWith('error'))) continue;
    if (source.lastError) issues.push({ name: FEED_NAMES[key] || key, reason: String(source.lastError), lastGood: source.lastGood });
  }
  // Road and emergency aggregates also expose individual provider failures.
  for (const key of ['roads', 'emergency']) {
    for (const [name, result] of Object.entries(data[key].sources || {})) {
      if (typeof result === 'string' && result.startsWith('error'))
        issues.push({ name: `${name} ${key === 'roads' ? 'road events' : 'emergency warnings'}`, reason: result });
    }
  }
  return { data, issues };
}

export function createFeedClient({ fetch, url, previous, onChange, retry, schedule = setTimeout, cancel = clearTimeout, now = Date.now }) {
  let pending = null, timer = null, failures = 0;
  const health = { error: null, issues: [], nextRetry: null, checking: false };
  const publish = () => { try { onChange({ ...health }); } catch { /* diagnostics cannot stop a feed */ } };
  const clear = () => { if (timer !== null) cancel(timer); timer = null; health.nextRetry = null; };
  function request(timeout = 15000, cache = 'default') {
    if (pending) return pending;
    clear();
    health.checking = true;
    publish();
    pending = (async () => {
      try {
        const response = await fetch(url, { cache, signal: AbortSignal.timeout(timeout) });
        if (!response.ok) {
          const error = new Error(response.status === 429 ? 'The service is rate limited (HTTP 429).' : `The live readings service returned HTTP ${response.status}.`);
          const wait = response.headers.get('retry-after');
          error.retryMs = /^\d+$/.test(wait || '') ? Number(wait) * 1000 : Date.parse(wait) - now();
          throw error;
        }
        const result = readingsDocument(await response.json(), previous());
        failures = 0;
        health.error = null;
        health.issues = result.issues;
        return result.data;
      } catch (error) {
        failures++;
        health.error = feedError(error);
        const delay = Math.max(45000, Number.isFinite(error.retryMs) && error.retryMs > 0
          ? error.retryMs : Math.min(300000, 45000 * 2 ** Math.min(failures - 1, 3)));
        health.nextRetry = now() + delay;
        timer = schedule(() => {
          timer = null;
          // Retry callbacks can include rendering; never leave a rejection unhandled.
          Promise.resolve().then(retry).catch(() => {});
        }, delay);
        throw error;
      } finally {
        pending = null;
        health.checking = false;
        publish();
      }
    })();
    return pending;
  }
  return { request, health };
}
