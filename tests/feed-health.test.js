const test = require('node:test');
const assert = require('node:assert/strict');
const api = import('../viewer/feed-health.js');
const fresh = () => ({ fetched: '2026-10-25T09:22:51Z', level: { river: { latest: ['2026-10-25T09:20:00Z', 2] } } });

test('malformed feed sections retain previous data without discarding healthy sources', async () => {
  const { readingsDocument } = await api;
  const previous = { roads: { items: [{ id: 'old' }] }, storage: { dam: { latest: ['today', 12] } } };
  const { data, issues } = readingsDocument({ ...fresh(), roads: { items: 'bad' }, storage: [] }, previous);
  assert.equal(data.roads, previous.roads);
  assert.equal(data.storage, previous.storage);
  assert.equal(data.level.river.latest[1], 2);
  assert.equal(issues.length, 2);
  for (const invalid of [null, '<html>', { level: [] }, { ...fresh(), fetched: 'bad' }])
    assert.throws(() => readingsDocument(invalid));
});

test('provider failures identify the source even when the broker request succeeded', async () => {
  const { readingsDocument } = await api;
  const { issues } = readingsDocument({ ...fresh(), sources: { warnings: { lastError: 'FTP unavailable', lastGood: '2026-10-25T08:00:00Z' } } });
  assert.deepEqual(issues, [{ name: 'Flood warnings', reason: 'FTP unavailable', lastGood: '2026-10-25T08:00:00Z' }]);
});

test('rain forecast pairs and empty healthy warning lists remain usable', async () => {
  const { readingsDocument } = await api;
  const raw = { ...fresh(), rain: { river: [7.8, 16.7] }, warnings: { ok: true, warnings: [] } };
  const result = readingsDocument(raw);
  assert.deepEqual(result.issues, []);
  assert.equal(result.data.rain, raw.rain);
  assert.equal(result.data.warnings, raw.warnings);
});

test('timeouts and later failures retry with backoff, keep data and recover', async () => {
  const { createFeedClient } = await api;
  const timers = [], changes = [];
  let attempts = 0, last = fresh(), client;
  client = createFeedClient({
    url: 'https://broker.test/v1/now', previous: () => last, now: () => 1000,
    fetch: async () => {
      attempts++;
      if (attempts !== 3) throw new DOMException('operation aborted', 'TimeoutError');
      return Response.json(fresh());
    },
    onChange: health => changes.push(health),
    schedule: (fn, delay) => { timers.push({ fn, delay }); return timers.length; }, cancel() {},
    retry: async () => { last = await client.request(); },
  });
  const old = last;
  await assert.rejects(client.request());
  assert.equal(last, old);
  assert.equal(client.health.error, 'The request timed out.');
  assert.equal(timers[0].delay, 45000);
  await assert.rejects(client.request());
  assert.equal(timers[1].delay, 90000);
  timers[1].fn();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(client.health.error, null);
  assert.equal(client.health.nextRetry, null);
  assert.equal(attempts, 3);
  // An outage after a successful fetch must still schedule another retry.
  await assert.rejects(client.request());
  assert.equal(timers[2].delay, 45000);
  assert.equal(changes.at(-1).checking, false);
});

test('HTTP rate limits respect Retry-After and overlapping requests share one fetch', async () => {
  const { createFeedClient } = await api;
  let release, count = 0, delay;
  const client = createFeedClient({
    url: '/v1/now', previous: () => ({}), now: () => 0, onChange() {}, retry() {}, cancel() {},
    schedule: (_, ms) => { delay = ms; },
    fetch: () => { count++; return new Promise(resolve => { release = resolve; }); },
  });
  const a = client.request(), b = client.request();
  assert.equal(a, b);
  release(new Response('limited', { status: 429, headers: { 'Retry-After': '600' } }));
  await assert.rejects(a, /429/);
  assert.equal(count, 1);
  assert.equal(delay, 600000);
});

test('invalid JSON and invalid documents cannot replace the last usable readings', async () => {
  const { createFeedClient } = await api;
  for (const response of [new Response('<html>upstream error</html>'), Response.json({ level: [] })]) {
    const old = fresh();
    let retried = false;
    const client = createFeedClient({
      fetch: async () => response, url: '/v1/now', previous: () => old,
      onChange() { throw new Error('broken status display'); },
      retry() {}, schedule() { retried = true; }, cancel() {},
    });
    await assert.rejects(client.request());
    assert.equal(old.level.river.latest[1], 2);
    assert.equal(retried, true);
  }
});
