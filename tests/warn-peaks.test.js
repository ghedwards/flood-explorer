// River heights in Bureau flood warning text (viewer/warn-peaks.js).
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');

(async () => {
  const { parseWarningLevels, warningTargets, gaugeForTarget } = await import('../viewer/warn-peaks.js');

  const TEXT = `Minor flooding is occurring along the Barcoo River at Blackall. The Barcoo River at Blackall is currently at 2.35 metres and rising, with minor flooding. The Barcoo River at Blackall may peak near 2.60 metres Wednesday afternoon, with minor flooding.
The Barcoo River at Isisford may exceed the moderate flood level (5.00 m) on Thursday. It peaked at 4.45 metres on Tuesday at Retreat.
The Bulloo River at Quilpie peaked at 4.45 metres on Tuesday and is now falling.`;

  test('peaks, current heights, class levels and past peaks are told apart', () => {
    const got = parseWarningLevels(TEXT).map((x) => [x.river, x.place, x.level, x.kind, x.cls, x.predicted]);
    assert.deepEqual(got, [
      ['Barcoo River', 'Blackall', 2.35, 'now', null, false],
      ['Barcoo River', 'Blackall', 2.6, 'peak', null, true],
      ['Barcoo River', 'Isisford', 5, 'class', 'moderate', true],
      ['Barcoo River', 'Isisford', 4.45, 'peaked', null, false],
      ['Bulloo River', 'Quilpie', 4.45, 'peaked', null, false],
    ]);
  });

  test('one target per place: the predicted peak, else the class level', () => {
    const t = warningTargets(TEXT).map((x) => [x.place, x.level, x.kind]);
    assert.deepEqual(t, [['Blackall', 2.6, 'peak'], ['Isisford', 5, 'class']]);
  });

  test('other phrasings', () => {
    const t = (s) => warningTargets(s).map((x) => [x.river, x.place, x.level, x.kind]);
    assert.deepEqual(t('The Warrego River at Augathella is likely to peak around 4.5 metres overnight Wednesday.'), [['Warrego River', 'Augathella', 4.5, 'peak']]);
    assert.deepEqual(t('Warrego River at The 27 Mile Garden is expected to reach around 3.2 m during Thursday.'), [['Warrego River', 'The 27 Mile Garden', 3.2, 'peak']]);
    assert.deepEqual(t('The Condamine River at Chinchilla Weir may reach the major flood level (7.00 m) late Friday.'), [['Condamine River', 'Chinchilla Weir', 7, 'class']]);
    assert.deepEqual(t('Rainfall totals of 20 to 50 mm are possible. Minor flooding is occurring.'), []);
  });

  test('a target finds its gauge by place and river', () => {
    const g = (name, props) => ({ type: 'Feature', geometry: { type: 'Point', coordinates: [145, -24] }, properties: { name, state: 'QLD', ...props } });
    const gauges = [g('Blackall Weir (Other River)'), g('Blackall (Barcoo River)', { bom: 1, kind: 'forecast' }), g('Isisford (Barcoo River)', { bom: 2 }), g('Quilpie', { state: 'NSW' })];
    const [blackall, isisford] = warningTargets(TEXT);
    assert.equal(gaugeForTarget(blackall, gauges, 'QLD').properties.name, 'Blackall (Barcoo River)');
    assert.equal(gaugeForTarget(isisford, gauges, 'QLD').properties.name, 'Isisford (Barcoo River)');
    assert.equal(gaugeForTarget({ river: 'Bulloo River', place: 'Quilpie' }, gauges, 'QLD'), null, 'other state');
  });
})();
