// Tidal planes, a tide distribution and a check of the published planes, from Maritime Safety
// Queensland's Gold Coast Seaway gauge records (observed and predicted 10-minute levels, CC BY 4.0,
// from data.qld.gov.au; the files are not kept in the repository).
//
//   node scripts/tide-analysis.js <dir with obs_YYYY.csv and pred_YYYY.csv> [--out tide-distribution.json]
//
// Harmonic constituents are fitted to the predicted series (what the published planes come from) and to the
// observed series; the planes follow from them, the observed levels give how often each tide state occurs
// (weather and all), and the observed minus predicted levels are the gauge check on the tide model.
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const tide = require('./tide-lib.js');

const r3 = x => +x.toFixed(3);
const pct = (sorted, p) => sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))];

function load(dir, prefix) {
  const t = [], y = [];
  for (const f of fs.readdirSync(dir).filter(f => f.startsWith(prefix + '_') && f.endsWith('.csv')).sort()) {
    const g = tide.parseGauge(fs.readFileSync(path.join(dir, f), 'utf8'));
    for (let i = 0; i < g.t.length; i++) { t.push(g.t[i]); y.push(g.y[i]); }
  }
  return { t, y };
}

function analyse(dir, { published = null, source = 'Maritime Safety Queensland Gold Coast Seaway tide gauge (station 045044A), CC BY 4.0, data.qld.gov.au' } = {}) {
  const obs = load(dir, 'obs'), pred = load(dir, 'pred');
  if (obs.t.length < 20000 || pred.t.length < 20000) throw new Error('Need at least a few months of observed and predicted records.');
  // MSQ moves MSL each year for sea-level rise, so the planes come from the latest predicted year alone, the table's own year
  const lastYear = new Date(pred.t[pred.t.length - 1] * 3600000).getUTCFullYear();
  const keep = pred.t.map((t, i) => i).filter(i => new Date(pred.t[i] * 3600000).getUTCFullYear() === lastYear);
  const pt = keep.map(i => pred.t[i]), py = keep.map(i => pred.y[i]);
  const predFit = tide.fitHarmonics(pt, py), obsFit = tide.fitHarmonics(obs.t, obs.y);
  const fitted = tide.synthesise(predFit, pt);
  let sq = 0; for (let i = 0; i < fitted.length; i++) sq += (fitted[i] - py[i]) ** 2;
  const planes = tide.planesFromFit(predFit), obsPlanes = tide.planesFromFit(obsFit);

  // observed minus predicted at matching times (same 10-minute stamps)
  const byTime = new Map(); pred.t.forEach((t, i) => byTime.set(t, pred.y[i]));
  const resid = [];
  obs.t.forEach((t, i) => { const p = byTime.get(t); if (p !== undefined) resid.push(obs.y[i] - p); });
  resid.sort((a, b) => a - b);
  const mean = resid.reduce((a, b) => a + b, 0) / resid.length;
  const sd = Math.sqrt(resid.reduce((a, b) => a + (b - mean) ** 2, 0) / resid.length);

  // MSL rose over the record, so the observed levels are moved to the table's year along the linear trend of
  // the annual means before counting how often each state occurs
  const annual = new Map();
  obs.t.forEach((t, i) => { const yr = new Date(t * 3600000).getUTCFullYear(), a = annual.get(yr) || [0, 0]; a[0] += obs.y[i]; a[1]++; annual.set(yr, a); });
  const pts = [...annual].filter(([, a]) => a[1] > 40000).map(([yr, a]) => [yr + 0.5, a[0] / a[1]]);
  const mx = pts.reduce((a, p) => a + p[0], 0) / pts.length, my = pts.reduce((a, p) => a + p[1], 0) / pts.length;
  // fewer than six annual means cannot separate the rise from year-to-year swings (ENSO), so no trend is removed then
  const slope = pts.length < 6 ? 0 : pts.reduce((a, p) => a + (p[0] - mx) * (p[1] - my), 0) / pts.reduce((a, p) => a + (p[0] - mx) ** 2, 0);
  const moved = obs.t.map((t, i) => obs.y[i] + slope * (lastYear + 0.5 - (new Date(t * 3600000).getUTCFullYear() + 0.5)));
  const years = [...new Set(obs.t.map(t => new Date(t * 3600000).getUTCFullYear()))];
  return {
    source,
    observed: { samples: obs.t.length, years, from: new Date(obs.t[0] * 3600000).toISOString().slice(0, 10), to: new Date(obs.t[obs.t.length - 1] * 3600000).toISOString().slice(0, 10) },
    harmonicFitVsPrediction: { year: lastYear, rmsM: r3(Math.sqrt(sq / fitted.length)), samples: pt.length },
    planesFromPredictions: Object.fromEntries(Object.entries(planes).map(([k, v]) => [k, r3(v)])),
    planesFromObservations: Object.fromEntries(Object.entries(obsPlanes).map(([k, v]) => [k, r3(v)])),
    ...(published && { publishedPlanes: published, publishedMinusPredictions: Object.fromEntries(Object.keys(published).map(k => [k, r3(published[k] - planes[k])])) }),
    constituents: predFit.parts.filter(p => p.amp > 0.01).map(p => ({ name: p.name, ampM: r3(p.amp) })),
    observedMinusPredicted: { n: resid.length, meanM: r3(mean), sdM: r3(sd), p01: r3(pct(resid, 0.01)), p99: r3(pct(resid, 0.99)), min: r3(resid[0]), max: r3(resid[resid.length - 1]) },
    // how often the sea is nearest each plane, measured on the observed levels against the predicted planes
    stateWeights: tide.stateWeights(moved, planes),
    meanSeaLevelTrendMPerYear: r3(slope),
  };
}

if (require.main === module) {
  const argv = process.argv.slice(2), dir = argv.find(a => !a.startsWith('--')), opt = name => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : null; };
  if (!dir) { console.error('Usage: node scripts/tide-analysis.js <dir> [--out file.json] [--published planes.json] [--source "gauge description"] [--planes-out file.json --place "Place name"]'); process.exit(1); }
  const publishedFile = opt('--published') || (opt('--source') ? null : path.join(__dirname, '../viewer/public/tsunami-data/gold-coast-seaway-tidal-planes.json'));
  const result = analyse(dir, { published: publishedFile && JSON.parse(fs.readFileSync(publishedFile, 'utf8')).planes, ...(opt('--source') && { source: opt('--source') }) });
  console.log(JSON.stringify(result, null, 2));
  if (opt('--out')) fs.writeFileSync(opt('--out'), JSON.stringify(result, null, 2) + '\n');
  // planes taken from the fit to the latest predicted year, in the shape tide-lib.js reads (not read from a published table, so not verified)
  if (opt('--planes-out')) fs.writeFileSync(opt('--planes-out'), JSON.stringify({ place: opt('--place'), source: `Harmonic fit to ${result.harmonicFitVsPrediction.year} predicted levels: ${result.source}`, datum: 'Queensland Port Datum (LAT), metres above datum, as the gauge reports', planes: result.planesFromPredictions, verified: false, note: 'Fitted by scripts/tide-analysis.js from the predicted 10-minute levels, not read from a published tidal-planes table; HAT and LAT are the extremes of the fitted tide over 19 years without nodal corrections. Only heights relative to MSL are used by the tide scripts.' }, null, 2) + '\n');
}
module.exports = { analyse };
