const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const stateModule = import('../viewer/overlay-state.js');

// The modelled-area flood layer is a canvas filled by setPixels. Before this
// module, "drawn" only recognised the PNG-URL fallback, so every canvas layer
// read as undrawn (the live smoke test waits on it) and the printable report
// lost its flood-extent map.
test('a flood layer counts as drawn once it has pixels or an image URL', async () => {
  const { overlayDrawn, PIXELS_DRAWN } = await stateModule;
  assert.equal(overlayDrawn(null), false);
  assert.equal(overlayDrawn({}), false);
  assert.equal(overlayDrawn({ _image: {} }), false);
  assert.equal(overlayDrawn({ [PIXELS_DRAWN]: true }), true);
  assert.equal(overlayDrawn({ _floodUrl: 'blob:abc' }), true);
});

test('a canvas flood layer can be turned back into an image for the report', async () => {
  const { overlayImageUrl, PIXELS_DRAWN } = await stateModule;
  const canvas = { toDataURL: type => `data:${type};base64,AAAA` };
  assert.equal(overlayImageUrl(null), null);
  assert.equal(overlayImageUrl({ _image: canvas }), null, 'an unpainted canvas is not a flood map');
  assert.equal(overlayImageUrl({ [PIXELS_DRAWN]: true, _image: canvas }), 'data:image/png;base64,AAAA');
  assert.equal(overlayImageUrl({ _floodUrl: 'blob:abc', _image: canvas }), 'blob:abc', 'the URL path still wins');
  assert.equal(overlayImageUrl({ [PIXELS_DRAWN]: true, _image: { toDataURL() { throw new Error('tainted'); } } }), null);
  assert.equal(overlayImageUrl({ [PIXELS_DRAWN]: true, _image: {} }), null);
});

test('the viewer marks canvas layers drawn and reads both through these helpers', () => {
  const source = fs.readFileSync(path.join(__dirname, '../viewer/app.js'), 'utf8');
  const setPixels = source.slice(source.indexOf('setPixels(rgba, w, h) {'));
  assert.match(setPixels.slice(0, setPixels.indexOf('\n        },')), /this\[PIXELS_DRAWN\] = true/);
  assert.match(source, /drawn: overlayDrawn\(a\.overlay\)/);
  assert.match(source, /img = overlayImageUrl\(area\.overlay\)/);
  assert.doesNotMatch(source, /drawn: !!a\.overlay\._floodUrl/);
});
