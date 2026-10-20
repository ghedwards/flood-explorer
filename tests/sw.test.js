const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

const source = fs.readFileSync(require.resolve('../viewer/sw.js'), 'utf8');

function worker(fetch, cached) {
  const entries = new Map(cached ? [['https://example.test/app.js', cached]] : []);
  const context = vm.createContext({
    self: { addEventListener() {} }, fetch,
    caches: { open: async () => ({
      match: async (req) => entries.get(req.url)?.clone(),
      put: async (req, res) => entries.set(req.url, res),
    }) },
    // The response wins immediately in these tests; no real timer is needed.
    setTimeout() {},
  });
  vm.runInContext(source, context);
  return () => context.networkFirst(new Request('https://example.test/app.js'), 'app-__BUILD__', 4000);
}

for (const status of [404, 503]) {
  test(`HTTP ${status} uses an existing cached app file`, async () => {
    const run = worker(async () => new Response('error page', { status }), new Response('cached app'));
    const res = await run();
    assert.equal(res.status, 200);
    assert.equal(await res.text(), 'cached app');
  });
}

test('a network failure uses the cached app file', async () => {
  const run = worker(async () => { throw new Error('offline'); }, new Response('cached app'));
  assert.equal(await (await run()).text(), 'cached app');
});

test('a successful response replaces the cached copy', async () => {
  const run = worker(async () => new Response('new app'), new Response('cached app'));
  assert.equal(await (await run()).text(), 'new app');
});

test('an HTTP error without a cached copy preserves the server response', async () => {
  const run = worker(async () => new Response('unavailable', { status: 503 }));
  const res = await run();
  assert.equal(res.status, 503);
  assert.equal(await res.text(), 'unavailable');
});

test('broker readings: the last copy when offline', async () => {
  const handlers = {};
  const stored = new Map();
  const context = vm.createContext({
    self: { addEventListener(t, f) { handlers[t] = f; }, location: { origin: 'https://ghedwards.github.io' } },
    fetch: async () => { throw new Error('offline'); },
    caches: { open: async (name) => ({
      match: async (req) => stored.get(`${name} ${req.url}`)?.clone(),
      put: async (req, res) => stored.set(`${name} ${req.url}`, res),
      keys: async () => [],
    }) },
    setTimeout() {},
    URL,
  });
  vm.runInContext(source, context);
  const url = 'https://abc.lambda-url.ap-southeast-2.on.aws/v1/readings';
  stored.set(`live-v1 ${url}`, new Response('{"level":{}}', { headers: { 'content-type': 'application/json' } }));
  let answer = null;
  handlers.fetch({ request: new Request(url), respondWith: (p) => { answer = p; } });
  assert.ok(answer, 'the broker request is handled');
  assert.equal(await (await answer).text(), '{"level":{}}');
});
