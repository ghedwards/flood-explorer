const test = require('node:test');
const assert = require('node:assert/strict');
const { pathToFileURL } = require('node:url');
const path = require('node:path');

async function loadModule() {
  return import(pathToFileURL(path.resolve(__dirname, '../viewer/share-session.js')).href);
}

test('b64 and unb64 round-trip UTF-8 and large payloads', async () => {
  const { b64, unb64 } = await loadModule();
  const sample = JSON.stringify({ name: 'Brisbane — 2011 peak', payload: 'x'.repeat(80000) });
  const encoded = b64(sample);
  assert.ok(!/[+/=]/.test(encoded), 'URL-safe base64 without padding');
  assert.equal(unb64(encoded), sample);
});

test('sanitizeView, sanitizePin, and sanitizeStudy reject malformed or out-of-range inputs', async () => {
  const { sanitizeView, sanitizePin, sanitizeStudy } = await loadModule();
  assert.deepEqual(sanitizeView([-27.47, 153.02, 12]), [-27.47, 153.02, 12]);
  assert.equal(sanitizeView([95, 153, 12]), null);
  assert.equal(sanitizeView([-27, 153, 99]), null);

  assert.deepEqual(sanitizePin({ n: 2, lat: -27.5, lon: 153.0, name: 'Gauge' }), { n: 2, lat: -27.5, lon: 153.0, name: 'Gauge' });
  assert.equal(sanitizePin({ n: '<b>1</b>', lat: -27.5, lon: 153.0 }).n, undefined);
  assert.equal(sanitizePin({ n: 1, lat: NaN, lon: 153.0 }), null);

  assert.deepEqual(sanitizeStudy({ l: 'a', b: [-28, 152, -27, 153], name: 'Study', m: [1, -2, 'bad', 3] }), {
    letter: 'A',
    bounds: [-28, 152, -27, 153],
    name: 'Study',
    nums: [1, 3],
  });
  assert.equal(sanitizeStudy({ l: '<script>', b: [-28, 152, -27, 153] }).letter, undefined);
  assert.equal(sanitizeStudy({ l: 'A', b: [1, 2] }), null);
});
