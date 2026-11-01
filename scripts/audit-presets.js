// Usage: node scripts/audit-presets.js /path/to/gauges.geojson
// Use the published complete catalogue, not just the core gauge subset.
const { readFileSync } = require('node:fs');

(async () => {
  const { PRESETS, presetGauge } = await import('../viewer/presets.js');
  if (!process.argv[2]) throw new Error('Usage: node scripts/audit-presets.js /path/to/gauges.geojson');
  const { features } = JSON.parse(readFileSync(process.argv[2], 'utf8'));
  if (!Array.isArray(features) || !features.some(f => f.properties.kind === 'river')) throw new Error('Expected the complete gauge GeoJSON catalogue, including other river gauges');
  let anchored = 0, unexpected = 0;
  console.log('# River preset gauge audit\n');
  console.log(`Catalogue: ${features.length} gauges. Match the intended river in the gauge name within 8 km; flag anchors beyond 5 km for review.\n`);
  console.log('| Preset | Selected gauge | Distance | Review |\n|---|---|---:|---|');
  for (const p of PRESETS.filter(p => p.kind === 'river')) {
    const g = presetGauge(p, features);
    if (g) anchored++;
    const review = !g || g.km > 5;
    if (review && !p.anchorNote) unexpected++;
    console.log(`| ${p.name} | ${g ? g.f.properties.name : 'No suitable gauge; model starts at preset point'} | ${g ? g.km.toFixed(2) + ' km' : '—'} | ${p.anchorNote || (review ? 'Needs review' : 'Within 5 km')} |`);
  }
  console.log(`\n${anchored} of ${PRESETS.filter(p => p.kind === 'river').length} river presets anchored. ${unexpected} unexplained exceptions.\n\nA catalogue match checks the selected gauge and distance; it does not validate terrain, gauge datum or model accuracy.`);
  if (unexpected) process.exitCode = 1;
})().catch(error => { console.error(error); process.exitCode = 1; });
