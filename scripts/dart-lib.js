// Observed deep-ocean tsunami records (NOAA DART buoys) and the comparisons used
// to judge modelled waves against them.
//
// NOAA NCEI publishes, for each tsunami event, one text file per buoy with the
// raw bottom-pressure observations, a fitted tide and the residual, all in metres
// of water column (https://www.ngdc.noaa.gov/hazard/dart/). The residual is the
// de-tided record; it still carries a slow offset and noise of a centimetre or
// two, so it is high-pass filtered before comparison. Pure functions: anything
// that touches the network is injected by the caller.
'use strict';

const NGDC = 'https://www.ngdc.noaa.gov';

// Links to each buoy's data file on an NCEI event page (…_dart.html), by station ID.
function stationFiles(html) {
  const files = {};
  for (const match of String(html).matchAll(/href="([^"]*\/dart(\d{5})_[^"]*_meter\.txt)"/g)) {
    files[match[2]] = new URL(match[1], NGDC).href;
  }
  return files;
}

// One buoy's file: "julian-day year month day hour minute second raw tide residual flag".
// `origin` is the earthquake time (ms since the epoch, UTC). Times come back as
// seconds after it. Rows that do not parse, or hold fill values, are skipped.
function parseNgdcDart(text, origin) {
  const t = [], raw = [], tide = [], residual = [];
  for (const line of String(text).split(/\r?\n/)) {
    const c = line.trim().split(/\s+/);
    if (c.length < 10) continue;
    const n = c.slice(1, 10).map(Number);
    if (n.some(v => !Number.isFinite(v))) continue;
    const [year, month, day, hour, minute, second, observed, fitted, resid] = n;
    if (Math.abs(resid) > 50 || Math.abs(observed) > 20000) continue;
    t.push((Date.UTC(year, month - 1, day, hour, minute, second) - origin) / 1000);
    raw.push(observed); tide.push(fitted); residual.push(resid);
  }
  if (t.length < 2) throw new Error('No readable DART rows in this file.');
  for (let i = 1; i < t.length; i++) if (t[i] <= t[i - 1]) throw new Error('DART times do not increase.');
  return { t, raw, tide, residual };
}

// Linear interpolation of an irregular record onto `grid` (seconds), leaving NaN
// where the nearest samples are more than `maxGap` seconds apart or outside the record.
function resample(t, values, grid, maxGap = 600) {
  const out = new Float64Array(grid.length);
  let j = 0;
  for (let i = 0; i < grid.length; i++) {
    const x = grid[i];
    while (j + 1 < t.length && t[j + 1] < x) j++;
    if (x < t[0] || x > t[t.length - 1] || j + 1 >= t.length) { out[i] = x === t[t.length - 1] ? values[t.length - 1] : NaN; continue; }
    const [a, b] = [t[j], t[j + 1]];
    out[i] = b - a > maxGap ? NaN : values[j] + (values[j + 1] - values[j]) * ((x - a) / (b - a));
  }
  return out;
}

// Replace isolated outliers (a sample or two far from its neighbours, as a bottom-pressure recorder's occasional bad reading is) with the running median. A Hampel
// filter: a sample is a spike when it is more than `threshold` robust standard deviations (1.4826 x the median absolute deviation, never less than `floor` metres, the
// record's quantisation and noise) from the median of the `2 * half + 1` samples around it. A tsunami is smooth over many samples (periods of minutes against 15 s to
// 1 min sampling), so its crest is carried by the median and kept; a spike wider than `half` samples is not removable this way and stays. NaN stays NaN. Returns the
// cleaned values and how many were replaced.
function despike(values, { half = 3, threshold = 6, floor = .005 } = {}) {
  const out = Float64Array.from(values);
  let replaced = 0;
  for (let i = 0; i < values.length; i++) {
    if (!Number.isFinite(values[i])) continue;
    const window = [];
    for (let k = Math.max(0, i - half); k <= Math.min(values.length - 1, i + half); k++) if (Number.isFinite(values[k])) window.push(values[k]);
    if (window.length < 5) continue;
    window.sort((a, b) => a - b);
    const median = window[window.length >> 1];
    const deviations = window.map(v => Math.abs(v - median)).sort((a, b) => a - b);
    const sigma = Math.max(floor, 1.4826 * deviations[deviations.length >> 1]);
    if (Math.abs(values[i] - median) > threshold * sigma) { out[i] = median; replaced++; }
  }
  return { values: out, replaced };
}

// Remove slow drift: subtract a running median over `windowSeconds` (robust to
// the tsunami's own peaks). Tsunami periods of minutes to an hour or two pass;
// the semi-diurnal tide residual and instrument drift do not.
function highpass(values, step, windowSeconds = 4 * 3600) {
  const half = Math.max(1, Math.round(windowSeconds / step / 2));
  const out = new Float64Array(values.length);
  for (let i = 0; i < values.length; i++) {
    const window = [];
    for (let k = Math.max(0, i - half); k <= Math.min(values.length - 1, i + half); k++) if (Number.isFinite(values[k])) window.push(values[k]);
    if (!Number.isFinite(values[i]) || window.length < 3) { out[i] = NaN; continue; }
    window.sort((a, b) => a - b);
    out[i] = values[i] - window[window.length >> 1];
  }
  return out;
}

// First sample (index) where |v| exceeds max(floor, fraction * peak) inside [from, to).
function onset(v, from, to, { fraction = .15, floor = .01 } = {}) {
  let peak = 0;
  for (let i = from; i < to; i++) if (Number.isFinite(v[i])) peak = Math.max(peak, Math.abs(v[i]));
  const level = Math.max(floor, fraction * peak);
  for (let i = from; i < to; i++) if (Math.abs(v[i]) > level) return i;
  return -1;
}

// Great-circle distance in km.
function distanceKm(lon1, lat1, lon2, lat2) {
  const rad = Math.PI / 180;
  const h = Math.sin((lat2 - lat1) * rad / 2) ** 2 + Math.cos(lat1 * rad) * Math.cos(lat2 * rad) * Math.sin((lon2 - lon1) * rad / 2) ** 2;
  return 2 * 6371 * Math.asin(Math.sqrt(h));
}

// Bottom-pressure recorders also feel the earthquake's own shaking and
// hydro-acoustic waves, minutes after the rupture and long before the tsunami.
// A tsunami cannot arrive sooner than distance / sqrt(g * deepest ocean), so
// blank the record before `fraction` of that time (default 0.9, to allow for
// the path being shorter than the great circle in the model's eyes).
function maskBeforeTsunami(values, time, distanceKmFromSource, { maxDepth = 6000, fraction = .9 } = {}) {
  const earliest = fraction * distanceKmFromSource * 1000 / Math.sqrt(9.81 * maxDepth);
  return Float64Array.from(values, (v, i) => time[i] < earliest ? NaN : v);
}

// First index in [from, to) where |v| exceeds `level`, or -1.
function firstExceed(v, from, to, level) {
  for (let i = from; i < to; i++) if (Math.abs(v[i]) > level) return i;
  return -1;
}

// Best Pearson correlation between a model and an observed record over [from, to)
// when the model is shifted by up to +/- maxLag samples. Returns { correlation, lag }
// (lag in samples; positive means the model is later than the observation).
function bestLagCorrelation(model, observed, from, to, maxLag) {
  let best = { correlation: -Infinity, lag: 0 };
  for (let lag = -maxLag; lag <= maxLag; lag++) {
    let n = 0, sm = 0, so = 0, smm = 0, soo = 0, smo = 0;
    for (let i = from; i < to; i++) {
      const k = i - lag;
      if (k < 0 || k >= model.length) continue;
      const [m, o] = [model[k], observed[i]];
      if (!Number.isFinite(m) || !Number.isFinite(o)) continue;
      n++; sm += m; so += o; smm += m * m; soo += o * o; smo += m * o;
    }
    if (n < 10) continue;
    const cov = smo - sm * so / n, vm = smm - sm * sm / n, vo = soo - so * so / n;
    const correlation = vm > 0 && vo > 0 ? cov / Math.sqrt(vm * vo) : 0;
    if (correlation > best.correlation) best = { correlation, lag };
  }
  if (best.correlation === -Infinity) throw new Error('Too little overlapping data to correlate.');
  return best;
}

module.exports = { distanceKm, maskBeforeTsunami, firstExceed, bestLagCorrelation, stationFiles, parseNgdcDart, resample, despike, highpass, onset };
