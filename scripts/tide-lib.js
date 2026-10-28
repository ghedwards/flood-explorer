// Tide states from published tidal planes.
//
// A tidal-planes table gives the heights of characteristic tide levels above a chart datum
// (for Queensland, Port Datum = LAT). The tsunami lab's terrain is in AVWS (close to AHD)
// and its sea level starts at a level in those units, so a tide state needs two things the
// table cannot give by itself: the level of MSL in the terrain's datum, and how often each
// state occurs. This module supplies the first as an explicit, adjustable offset (default 0,
// that is, MSL taken as the terrain's zero) and does not guess the second.
'use strict';

const ORDER = ['LAT', 'MLWS', 'MLWN', 'MSL', 'MHWN', 'MHWS', 'HAT'];

// Plane heights relative to MSL, lowest first: { name, aboveMsl }.
function levelsAboveMsl(data) {
  const planes = data?.planes;
  if (!planes || !ORDER.every(name => Number.isFinite(planes[name]))) throw new Error(`The tidal planes need numbers for ${ORDER.join(', ')}.`);
  for (let i = 1; i < ORDER.length; i++) if (!(planes[ORDER[i]] > planes[ORDER[i - 1]])) throw new Error(`The tidal planes must rise from ${ORDER[i - 1]} to ${ORDER[i]}.`);
  return ORDER.map(name => ({ name, aboveMsl: +(planes[name] - planes.MSL).toFixed(3) }));
}

// The level to start the local model at for a named tide state, in the terrain's datum.
function stateLevel(data, name, mslInTerrainDatum = 0) {
  const state = levelsAboveMsl(data).find(s => s.name === name);
  if (!state) throw new Error(`Unknown tide state ${name}; use one of ${ORDER.join(', ')}.`);
  if (!Number.isFinite(mslInTerrainDatum)) throw new Error('The MSL offset must be a number of metres.');
  return +(state.aboveMsl + mslInTerrainDatum).toFixed(3);
}

// Spring and neap ranges and the M2 and S2 amplitudes they imply if those two constituents
// alone made the semidiurnal tide: spring range = 2(M2+S2), neap range = 2(M2-S2).
function springNeap(data) {
  const p = data.planes;
  const spring = p.MHWS - p.MLWS, neap = p.MHWN - p.MLWN;
  return { springRange: +spring.toFixed(3), neapRange: +neap.toFixed(3), m2: +((spring + neap) / 4).toFixed(3), s2: +((spring - neap) / 4).toFixed(3) };
}

module.exports = { STATES: ORDER, levelsAboveMsl, stateLevel, springNeap };

// ---- Tide statistics from a gauge record -------------------------------------------------
// Harmonic analysis of a tide-gauge series gives the planes and how often each state occurs from
// measurements, with no tide prediction needed.

// Constituent speeds in degrees per hour.
const CONSTITUENTS = {
  Sa: 0.0410686, Ssa: 0.0821373, MSf: 1.0158958, Mf: 1.0980331,
  '2Q1': 12.8542862, Q1: 13.3986609, O1: 13.9430356, P1: 14.9589314, K1: 15.0410686, J1: 15.5854433,
  '2N2': 27.8953548, MU2: 27.9682084, N2: 28.4397295, NU2: 28.5125831, M2: 28.9841042, L2: 29.5284789, T2: 29.9589333, S2: 30, K2: 30.0821373,
  MN4: 57.4238337, M4: 57.9682084, MS4: 58.9841042,
};

// A gauge CSV (Date, Time, Ind, Reading; dates day/month/year) as { t: hours since 1970 (local time
// taken as UTC), y: metres }, skipping blank and non-numeric readings.
function parseGauge(csv) {
  const t = [], y = [];
  for (const line of csv.split(/\r?\n/).slice(1)) {
    const c = line.split(',');
    const d = /(\d+)\/(\d+)\/(\d+)/.exec(c[1] || ''), h = /(\d+):(\d+)/.exec(c[2] || '');
    const v = parseFloat(c[4]);
    if (!d || !h || !Number.isFinite(v)) continue;
    t.push(Date.UTC(+d[3], +d[2] - 1, +d[1], +h[1], +h[2]) / 3600000);
    y.push(v);
  }
  return { t, y };
}

// Least-squares mean level and constituent amplitudes and phases (degrees) for the series.
function fitHarmonics(t, y, names = Object.keys(CONSTITUENTS)) {
  const n = 1 + 2 * names.length, A = new Float64Array(n * n), b = new Float64Array(n), row = new Float64Array(n);
  const t0 = t[0], w = names.map(k => CONSTITUENTS[k] * Math.PI / 180);
  for (let i = 0; i < t.length; i++) {
    const dt = t[i] - t0;
    row[0] = 1;
    for (let k = 0; k < names.length; k++) { row[1 + 2 * k] = Math.cos(w[k] * dt); row[2 + 2 * k] = Math.sin(w[k] * dt); }
    for (let r = 0; r < n; r++) { b[r] += row[r] * y[i]; for (let c = r; c < n; c++) A[r * n + c] += row[r] * row[c]; }
  }
  for (let r = 0; r < n; r++) for (let c = 0; c < r; c++) A[r * n + c] = A[c * n + r];
  for (let p = 0; p < n; p++) {                       // Gaussian elimination with partial pivoting
    let m = p;
    for (let r = p + 1; r < n; r++) if (Math.abs(A[r * n + p]) > Math.abs(A[m * n + p])) m = r;
    if (Math.abs(A[m * n + p]) < 1e-12) throw new Error('The record is too short or too gappy to separate the constituents.');
    if (m !== p) { for (let c = 0; c < n; c++) [A[p * n + c], A[m * n + c]] = [A[m * n + c], A[p * n + c]]; [b[p], b[m]] = [b[m], b[p]]; }
    for (let r = p + 1; r < n; r++) {
      const f = A[r * n + p] / A[p * n + p];
      if (f) { for (let c = p; c < n; c++) A[r * n + c] -= f * A[p * n + c]; b[r] -= f * b[p]; }
    }
  }
  const x = new Float64Array(n);
  for (let r = n - 1; r >= 0; r--) { let s = b[r]; for (let c = r + 1; c < n; c++) s -= A[r * n + c] * x[c]; x[r] = s / A[r * n + r]; }
  const parts = names.map((name, k) => ({ name, speed: CONSTITUENTS[name], amp: Math.hypot(x[1 + 2 * k], x[2 + 2 * k]), phase: Math.atan2(-x[2 + 2 * k], x[1 + 2 * k]) * 180 / Math.PI }));
  return { z0: x[0], t0, parts };
}

// The fitted tide at hours t.
function synthesise(fit, t) {
  const out = new Float64Array(t.length);
  for (let i = 0; i < t.length; i++) {
    let v = fit.z0;
    for (const p of fit.parts) v += p.amp * Math.cos((p.speed * (t[i] - fit.t0) + p.phase) * Math.PI / 180);
    out[i] = v;
  }
  return out;
}

// MSL, the semidiurnal planes (MSL +/- (M2 +/- S2)) and the extremes the fitted tide reaches over
// `years` (no nodal corrections, so HAT and LAT are close to but not exactly the 18.6-year values).
function planesFromFit(fit, years = 19, stepHours = 0.5) {
  const amp = k => fit.parts.find(p => p.name === k)?.amp ?? 0, m2 = amp('M2'), s2 = amp('S2');
  const t = new Float64Array(Math.round(years * 8766 / stepHours));
  for (let i = 0; i < t.length; i++) t[i] = fit.t0 + i * stepHours;
  let lo = Infinity, hi = -Infinity;
  const v = synthesise(fit, t);
  for (let i = 0; i < v.length; i++) { if (v[i] < lo) lo = v[i]; if (v[i] > hi) hi = v[i]; }
  return { LAT: lo, MLWS: fit.z0 - (m2 + s2), MLWN: fit.z0 - (m2 - s2), MSL: fit.z0, MHWN: fit.z0 + (m2 - s2), MHWS: fit.z0 + (m2 + s2), HAT: hi };
}

// How often the sea sits nearest each plane: each state owns the levels halfway to its neighbours
// (below LAT and above HAT go to those ends). `levels` are metres in the planes' own datum.
function stateWeights(levels, planes) {
  const v = ORDER.map(k => planes[k]), cut = v.slice(1).map((x, i) => (x + v[i]) / 2), count = new Array(ORDER.length).fill(0);
  for (const y of levels) { let i = 0; while (i < cut.length && y > cut[i]) i++; count[i]++; }
  return Object.fromEntries(ORDER.map((k, i) => [k, +(count[i] / levels.length).toFixed(4)]));
}

Object.assign(module.exports, { CONSTITUENTS, parseGauge, fitHarmonics, synthesise, planesFromFit, stateWeights });
