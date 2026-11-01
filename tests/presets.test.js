const test = require('node:test');
const assert = require('node:assert/strict');
const load = () => import('../viewer/presets.js');
const gauge = (name, kind = 'forecast', lon = 153, basin = 'Tamar River') => ({
  geometry: { coordinates: [lon, -27] }, properties: { name, kind, basin },
});
const preset = river => ({ kind: 'river', river, lat: -27, lon: 153 });

test('river metadata covers every river preset and does not depend on label order', async () => {
  const { PRESETS, presetGauge } = await load();
  assert.equal(new Set(PRESETS.map(p => p.id)).size, PRESETS.length);
  assert.equal(PRESETS.filter(p => p.kind === 'river').length, 46);
  for (const p of PRESETS.filter(p => p.kind === 'river')) assert.ok(p.river, p.id);
  for (const id of ['logan', 'maribyrnong']) {
    const p = PRESETS.find(p => p.id === id);
    const f = gauge(`A town (${p.river})`); f.geometry.coordinates = [p.lon, p.lat];
    assert.equal(presetGauge({ ...p, name: 'Unrelated display label' }, [f]).f, f);
  }
});
test('a tributary or reservoir in the same basin is not an anchor for the intended river', async () => {
  const { presetGauge } = await load();
  assert.equal(presetGauge(preset('Tamar River'), [gauge('Trevallyn Pond (South Esk River)'), gauge('Tamar Street Bridge (North Esk River)')]), null);
  const tributary = gauge('Mysterton (Mindham Park Drain)', 'forecast', 153, 'Ross River');
  const river = gauge('Aplin Weir (Ross River)', 'information', 153.01, 'Ross River');
  assert.equal(presetGauge(preset('Ross River'), [tributary, river]).f, river);
});
test('full river names match whole words, including River Murray, and reject lookalikes', async () => {
  const { presetGauge } = await load();
  assert.equal(presetGauge(preset('Mary River'), [gauge('Maryborough (Saltwater Creek)')]), null);
  assert.equal(presetGauge(preset('North Esk River'), [gauge('South Esk River')]), null);
  assert.equal(presetGauge(preset('Murray River'), [gauge('Long Island (River Murray)')]).km, 0);
});
test('only nearby river gauges qualify; forecast priority is preserved', async () => {
  const { presetGauge } = await load();
  const p = preset('Gascoyne River');
  assert.equal(presetGauge(p, [gauge('Gascoyne River', 'forecast', 153.13)]), null);
  assert.equal(presetGauge(p, [gauge('Gascoyne River', 'tide')]), null);
  assert.equal(presetGauge(p, []), null);
  assert.equal(presetGauge({ ...p, kind: 'coast' }, [gauge('Gascoyne River')]), null);
  const forecast = gauge('Gascoyne River', 'forecast', 153.01);
  assert.equal(presetGauge(p, [gauge('Gascoyne River', 'river'), forecast]).f, forecast);
});
