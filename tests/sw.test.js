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

// a cached tile served through the fetch handler: the same tile that broke
// before, when the worker handed a cached body to a request whose mode
// cannot read it
function tileWorker(caches, fetch) {
  const handlers = {};
  const context = vm.createContext({
    self: { addEventListener(t, f) { handlers[t] = f; }, location: { origin: 'https://ghedwards.github.io' } },
    fetch: fetch || (async () => new Response('net tile')),
    caches,
    setTimeout() {},
    URL,
  });
  vm.runInContext(source, context);
  return {
    ask(url, mode) {
      let answer = null;
      handlers.fetch({ request: new Request(url, { mode }), respondWith: (p) => { answer = p; } });
      return answer;
    },
  };
}

test('tiles: a healthy cache serves its copy, storage failures still answer', async () => {
  const good = { open: async (name) => ({ match: async () => ({ type: 'cors', text: async () => 'good tile' }), put: async () => {}, keys: async () => [] }) };
  let w = tileWorker(good);
  const url = 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/4/3/5';
  assert.equal(await (await w.ask(url, 'cors')).text(), 'good tile');
  // a cors copy is not served to a request in another mode; it is refetched
  // (usable() says no)
  assert.equal(await (await w.ask(url, 'no-cors')).text(), 'net tile');

  // cache storage refuses entirely (corrupt or full, as Firefox does): the
  // request itself must still get the network's answer, never a rejection
  let hitCalls = 0;
  const broken = {
    open: async () => ({ match: async () => { hitCalls++; throw new Error('The cache storage is broken'); }, put: async () => {}, keys: async () => [] }),
  };
  w = tileWorker(broken, async () => new Response('net tile'));
  const res = await w.ask(url, 'cors');
  assert.equal(await res.text(), 'net tile', 'a broken cache answers from the network');
  assert.ok(hitCalls >= 1, 'the broken match was attempted, not skipped');
  // caches.open itself refusing: same outcome
  w = tileWorker({ open: async () => { throw new Error('Storage quota exceeded'); } }, async () => new Response('net tile'));
  assert.equal(await (await w.ask(url, 'cors')).text(), 'net tile');
});
