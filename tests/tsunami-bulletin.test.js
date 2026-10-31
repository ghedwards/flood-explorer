const test = require('node:test');
const assert = require('node:assert/strict');

const load = () => import('../viewer/tsunami-bulletin.js');
const NOW = Date.parse('2026-10-26T12:00:00Z');
const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const item = (extra) => ({ id: 'a', source: 'PTWC', level: 'warning', region: 'SOLOMON ISLANDS & VANUATU', magnitude: 7.4, point: [-8.5, 157.1], issued: '2026-10-26T09:00:00Z', nearby: true, bulletin: 'https://www.tsunami.gov/events/x.txt', cap: null, ...extra });

test('a recent watch or warning is active; an information statement or an old bulletin is not', async () => {
  const { bulletinView } = await load();
  const doc = { fetched: '2026-10-26T11:50:00Z', items: [item(), item({ level: 'information', issued: '2026-10-26T10:00:00Z' }), item({ level: 'advisory', issued: '2026-10-20T00:00:00Z' }), item({ id: 'd' }), item({ id: 'e' })] };
  const view = bulletinView(doc, NOW);
  assert.equal(view.state, 'ok');
  assert.equal(view.items.length, 3, 'at most three');
  assert.deepEqual(view.items.map((x) => x.active), [true, false, false]);
  assert.equal(view.items[0].magnitudeText, 'M7.4');
  assert.equal(view.items[0].ageText, '3 hours ago');
  assert.equal(view.items[2].ageText, '7 days ago');
});

test('a missing, malformed or old feed is never shown as "no threat"', async () => {
  const { bulletinView, bulletinHtml } = await load();
  for (const doc of [null, undefined, {}, { items: 'x' }]) {
    const view = bulletinView(doc, NOW);
    assert.equal(view.state, 'unavailable');
    const html = bulletinHtml(view, esc);
    assert.match(html, /not available/);
    assert.match(html, /does not mean there is no threat/);
    assert.doesNotMatch(html, /all clear|\bsafe\b/i);
  }
  const old = bulletinView({ fetched: '2026-10-26T06:00:00Z', items: [item()] }, NOW);
  assert.equal(old.state, 'stale');
  assert.match(bulletinHtml(old, esc), /may be out of date/);
  assert.match(bulletinHtml(bulletinView({ fetched: '2026-10-26T11:55:00Z', items: [] }, NOW), esc), /feed holds no bulletin/);
  assert.equal(bulletinView({ fetched: 'nonsense', items: [item()] }, NOW).state, 'stale');
});

test('the panel always points to the Bureau and escapes everything the feed gave it', async () => {
  const { bulletinView, bulletinHtml, BOM_TSUNAMI_URL } = await load();
  const nasty = item({ region: '<img src=x onerror=alert(1)>', bulletin: 'javascript:alert(1)' });
  const html = bulletinHtml(bulletinView({ fetched: '2026-10-26T11:55:00Z', items: [nasty] }, NOW), esc);
  assert.ok(!html.includes('<img'), 'markup in the region is escaped');
  assert.ok(!html.includes('javascript:'), 'only tsunami.gov links are followed');
  assert.ok(html.includes(BOM_TSUNAMI_URL) && /not an Australian warning/.test(html));
  assert.match(html, /ts-bulletin-active/);
});

test('the readings document keeps no copy rather than inventing an empty one, and rejects a malformed feed', async () => {
  const { readingsDocument, FEED_NAMES } = await import('../viewer/feed-health.js');
  assert.equal(FEED_NAMES.tsunami, 'Tsunami bulletins');
  const base = { fetched: '2026-10-26T11:55:00Z', level: {} };
  assert.equal(readingsDocument(base).data.tsunami, null, 'no tsunami key: null, not an empty list');
  const good = { fetched: '2026-10-26T11:55:00Z', items: [item()] };
  assert.deepEqual(readingsDocument({ ...base, tsunami: good }).data.tsunami, good);
  const kept = readingsDocument({ ...base, tsunami: { items: 'broken' } }, { tsunami: good });
  assert.deepEqual(kept.data.tsunami, good, 'the previous copy is kept');
  assert.ok(kept.issues.some((i) => i.name === 'Tsunami bulletins'));
});
