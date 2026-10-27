// Read tsunami scenario time series from Geoscience Australia's PTHA18 (the 2018
// Australian Probabilistic Tsunami Hazard Assessment) and turn one into the
// "seconds, metres" series the tsunami lab accepts as an incoming wave.
//
// PTHA18 stores, for every source zone, one linear-model run per unit source
// (1 m of slip on one patch of fault). A scenario is a set of unit sources with
// slips, and its wave at a "hazard point" is the slip-weighted sum of the unit
// sources' waves there. This mirrors ptha_access/R/get_PTHA_results.R in
// https://github.com/GeoscienceAustralia/ptha, reading the NCI THREDDS server
// over OPeNDAP so only the needed values are fetched. Data: CC BY 4.0,
// (c) Commonwealth of Australia (Geoscience Australia).
//
// Everything that touches the network goes through an injected `get(url)`
// returning text, so the logic is testable offline.
'use strict';

const DAP_BASE = 'https://thredds.nci.org.au/thredds/dodsC/fj6/PTHA/AustPTHA_1/';
const SLIP_TYPES = ['stochastic', 'variable_uniform', 'uniform'];

// An OPeNDAP .ascii response: a DDS header, a dashed line, then one block per
// variable. 1-D variables are "name[N]" then comma-separated values; 2-D ones
// are "name[a][b]" then rows beginning "[i], ...". Strings are quoted.
function parseDapAscii(text) {
  if (/^\s*Error\s*{/.test(text)) {
    const message = /message\s*=\s*"([^"]*)"/.exec(text);
    throw new Error(`The data server refused the request: ${message ? message[1] : text.slice(0, 120)}`);
  }
  const split = text.indexOf('\n---');
  if (split < 0) throw new Error('Unexpected data server response (no data section).');
  const body = text.slice(text.indexOf('\n', split + 1) + 1);
  const out = {};
  for (const block of body.split(/\n\s*\n/)) {
    const lines = block.split('\n').filter(line => line.trim() !== '');
    if (!lines.length) continue;
    const head = /^([A-Za-z_][\w.]*)((?:\[\d+\])+)\s*$/.exec(lines[0].trim());
    if (!head) continue;
    const parse = token => {
      const value = token.trim();
      if (value.startsWith('"')) return JSON.parse(value);
      const number = Number(value);
      if (!Number.isFinite(number) && !/^[-+]?(NaN|Infinity)$/i.test(value)) throw new Error(`Unreadable value "${value.slice(0, 20)}".`);
      return number;
    };
    const dims = head[2].match(/\[\d+\]/g).length;
    if (dims === 1) out[head[1]] = splitList(lines.slice(1).join(' ')).map(parse);
    else out[head[1]] = lines.slice(1).map(line => splitList(line.replace(/^\s*(\[\d+\],?\s*)+/, '')).map(parse));
  }
  return out;
}

// Split on commas that are not inside a quoted string.
function splitList(text) {
  const items = [];
  let current = '', quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === '"' && text[i - 1] !== '\\') quoted = !quoted;
    if (c === ',' && !quoted) { items.push(current); current = ''; } else current += c;
  }
  if (current.trim() !== '') items.push(current);
  return items;
}

const range = (start, end) => `[${start}:1:${end}]`;
const ascii = (file, query) => `${DAP_BASE}${file}.ascii?${query}`;

// "17-18-" -> [17, 18]; "0.8975_0.07469_" -> [0.8975, 0.07469]
const parseIndices = text => String(text).split('-').filter(Boolean).map(Number);
const parseSlips = text => String(text).split('_').filter(Boolean).map(Number);

// PTHA18 paths read "/g/data/fj6/PTHA/AustPTHA_1/SOURCE_ZONES/..." (sometimes g/data1a).
function relativePath(path) {
  const match = /(SOURCE_ZONES|EVENT_RATES)\/.*$/.exec(path);
  if (!match) throw new Error(`Unrecognised PTHA18 file path: ${path}`);
  return match[0];
}

const eventsFile = (zone, slipType) => `SOURCE_ZONES/${zone}/TSUNAMI_EVENTS/all_${slipType}_slip_earthquake_events_${zone}.nc`;
const unitFile = zone => `SOURCE_ZONES/${zone}/TSUNAMI_EVENTS/unit_source_statistics_${zone}.nc`;
const STATIONS = 'EVENT_RATES/STATIONS_ONLY_lon_lat_elev_gaugeID.nc';
const RATES = 'EVENT_RATES/revised1_tsunami_stage_exceedance_rates_sum_over_all_source_zones.nc';

function checkZone(zone) {
  if (!/^[a-z0-9_]+$/.test(String(zone))) throw new Error('A source zone name is lower-case letters, digits and underscores (for example puysegur2 or southamerica).');
}
function checkSlipType(slipType) {
  if (!SLIP_TYPES.includes(slipType)) throw new Error(`Slip type must be one of ${SLIP_TYPES.join(', ')}.`);
}

// Every hazard point: lon, lat, ocean elevation (m, negative below sea level) and gauge ID.
async function hazardPoints(get) {
  const data = parseDapAscii(await get(ascii(STATIONS, 'lon,lat,elev,gaugeID')));
  const count = data.gaugeID.length;
  if (!count || data.lon.length !== count || data.lat.length !== count || data.elev.length !== count) throw new Error('The hazard point list is inconsistent.');
  return { lon: data.lon, lat: data.lat, elev: data.elev, gaugeID: data.gaugeID.map(v => Math.round(v * 100) / 100) };
}

// Hazard points nearest a longitude/latitude, closest first. `minDepth` keeps
// only points at least that deep (m), since PTHA18's 1 arc-minute linear model
// is not reliable in shallow water.
function nearestPoints(points, lon, lat, { count = 8, minDepth = 0 } = {}) {
  const kx = Math.cos(lat * Math.PI / 180);
  const rows = [];
  for (let i = 0; i < points.gaugeID.length; i++) {
    if (-points.elev[i] < minDepth) continue;
    rows.push({ index: i, gaugeID: points.gaugeID[i], lon: points.lon[i], lat: points.lat[i], depth: -points.elev[i],
      km: 111.32 * Math.hypot((points.lon[i] - lon) * kx, points.lat[i] - lat) });
  }
  return rows.sort((a, b) => a.km - b.km).slice(0, count);
}

function pointByGaugeID(points, gaugeID) {
  const wanted = Math.round(gaugeID * 100) / 100;
  const index = points.gaugeID.indexOf(wanted);
  if (index < 0) throw new Error(`No hazard point has gauge ID ${gaugeID}.`);
  return { index, gaugeID: wanted, lon: points.lon[index], lat: points.lat[index], depth: -points.elev[index] };
}

// PTHA18's own hazard curve at a hazard point: the annual rate at which the peak
// stage exceeds each of 100 stages (0.02 to 20 m), summed over every source zone
// (`index` is the 0-based position of the point in the station list). Besides the
// logic-tree mean rate there are the 16th, 50th and 84th percentiles of its
// uncertainty. Stage is above mean sea level, without tide.
async function exceedanceCurve(get, index, slipType = 'stochastic') {
  checkSlipType(slipType);
  if (!Number.isInteger(index) || index < 0) throw new Error('The hazard point index is a whole number from 0.');
  const names = [`${slipType}_slip_rate`, `${slipType}_slip_rate_16pc`, `${slipType}_slip_rate_median`, `${slipType}_slip_rate_84pc`];
  const query = ['stage[0:1:99]', ...names.map(n => `${n}${range(index, index)}[0:1:99]`)].join(',');
  const data = parseDapAscii(await get(ascii(RATES, query)));
  const rows = names.map(n => data[`${n}.${n}`]?.[0]);
  if (!data.stage || data.stage.length !== 100 || rows.some(r => !r || r.length !== 100)) throw new Error('The exceedance-rate curve is not the expected 100 stages.');
  const station = data[`${names[0]}.station`]?.[0];
  if (station !== undefined && station !== index + 1) throw new Error('The exceedance-rate curve belongs to a different hazard point.');
  const [rate, p16, median, p84] = rows;
  return { slipType, stage: data.stage, rate, p16, median, p84 };
}

// Annual exceedance rate of `stage` on one of the curve's rate series, by
// interpolating log(rate) between the tabulated stages. Below the first stage
// the rate is a lower bound (`atLeast`); above the last, or where the curve has
// fallen to zero, there is no estimate (`rate` 0 means below PTHA18's resolution).
function exceedanceRate(curve, stage, which = 'rate') {
  const { stage: axis } = curve, rates = curve[which];
  if (!rates) throw new Error(`Unknown rate series ${which}.`);
  if (!(stage >= 0)) throw new Error('The stage must be a non-negative number of metres.');
  if (stage <= axis[0]) return { rate: rates[0], atLeast: true };
  const last = axis.length - 1;
  if (stage > axis[last]) return { rate: null, beyond: true };
  let k = 1;
  while (axis[k] < stage) k++;
  const [lo, hi] = [rates[k - 1], rates[k]], f = (stage - axis[k - 1]) / (axis[k] - axis[k - 1]);
  if (lo > 0 && hi > 0) return { rate: Math.exp(Math.log(lo) + f * (Math.log(hi) - Math.log(lo))) };
  return { rate: hi > 0 ? hi * f : lo * (1 - f) };
}

// Words for the rate: "about 1 in 17 years" (return period = 1 / rate).
function describeRate({ rate, atLeast, beyond }) {
  if (beyond) return 'above the largest stage PTHA18 tabulates (20 m)';
  if (!(rate > 0)) return 'too rare for PTHA18 to give a rate';
  const years = 1 / rate;
  const text = years < 10 ? years.toFixed(1) : years < 1000 ? String(Math.round(years)) : String(Math.round(years / 100) * 100);
  return `${atLeast ? 'at least as often as ' : ''}about 1 in ${text} years`;
}

// PTHA18's source zones, each with its own exceedance-rate file (which sums to
// the all-zone curve). The zone list is the SOURCE_ZONES directory of the data set.
const ZONES = [
  'alaskaaleutians',
  'arutrough',
  'banda_detachment',
  'cascadia',
  'flores',
  'floreswetar',
  'hjort',
  'izumariana',
  'kermadectonga',
  'kermadectonga2',
  'kurilsjapan',
  'macquarieislandnorth',
  'macquarienorth',
  'makran',
  'makran2',
  'manokwari',
  'manus',
  'mexico',
  'moresby_trough',
  'mussau',
  'newguinea',
  'newguinea2',
  'newhebrides',
  'newhebrides2',
  'north_sulawesi',
  'outer_rise_timor',
  'outerrise_kermadectonga',
  'outerrise_puysegur',
  'outerrisenewhebrides',
  'outerrisesolomon',
  'outerrisesunda',
  'philippine',
  'puysegur',
  'puysegur2',
  'ryuku',
  'sandwich',
  'sangihe',
  'sangihe_backthrust',
  'se_sulawesi',
  'seram_thrust',
  'seramsouth',
  'solomon',
  'solomon2',
  'southamerica',
  'sunda',
  'sunda2',
  'tanimbar',
  'timor',
  'timortrough',
  'tolo_thrust',
  'trobriand',
];

// One zone's exceedance-rate curve at a hazard point, from its own file.
async function zoneCurve(get, zone, index, slipType) {
  checkZone(zone);
  const name = `${slipType}_slip_rate`;
  let lastError;
  for (const prefix of ['revised1_', '']) {
    try {
      const file = `SOURCE_ZONES/${zone}/TSUNAMI_EVENTS/${prefix}tsunami_stage_exceedance_rates_${zone}.nc`;
      const data = parseDapAscii(await get(ascii(file, `${name}${range(index, index)}[0:1:99]`)));
      const rate = data[`${name}.${name}`]?.[0];
      if (rate && rate.length === 100) return rate;
      lastError = new Error(`${zone} returned no ${name} curve`);
    } catch (error) { lastError = error; }
  }
  throw lastError;
}

// Which source zones contribute to the hazard at a point: each zone's annual
// rate of exceeding `stage` and its share of the zones' total, largest first.
// Zones that cannot be read are listed in `failed`.
async function zoneContributions(get, index, stage, { slipType = 'stochastic', zones = ZONES, concurrency = 6 } = {}) {
  checkSlipType(slipType);
  const axis = (await exceedanceCurve(get, index, slipType)).stage;
  const rows = [], failed = [];
  for (let k = 0; k < zones.length; k += concurrency) {
    await Promise.all(zones.slice(k, k + concurrency).map(async zone => {
      try {
        const { rate } = exceedanceRate({ stage: axis, rate: await zoneCurve(get, zone, index, slipType) }, stage);
        rows.push({ zone, rate: rate || 0 });
      } catch { failed.push(zone); }
    }));
  }
  const total = rows.reduce((sum, r) => sum + r.rate, 0);
  rows.forEach(r => { r.share = total > 0 ? r.rate / total : 0; });
  rows.sort((a, b) => b.rate - a.rate || a.zone.localeCompare(b.zone));
  return { rows, total, failed: failed.sort() };
}

// The stage whose annual exceedance rate is `rate` (for example 1/500), by
// interpolating log(rate) along the curve; null if the curve never reaches it.
function stageAtRate(curve, rate, which = 'rate') {
  const rates = curve[which];
  if (!rates) throw new Error(`Unknown rate series ${which}.`);
  if (!(rate > 0)) throw new Error('The annual rate must be positive.');
  if (rates[0] < rate) return null;
  for (let k = 1; k < rates.length; k++) {
    if (rates[k] > rate) continue;
    if (!(rates[k] > 0)) return curve.stage[k];
    const f = (Math.log(rates[k - 1]) - Math.log(rate)) / (Math.log(rates[k - 1]) - Math.log(rates[k]));
    return curve.stage[k - 1] + f * (curve.stage[k] - curve.stage[k - 1]);
  }
  return null;
}

// Candidate scenarios ({ row, mw, rateAnnual, peak }) ordered by how close their
// peak at the hazard point is to `target` metres (compared as a ratio, so 0.5 m
// and 2 m are equally far from 1 m). Candidates with no wave are dropped.
function rankByPeak(candidates, target) {
  if (!(target > 0)) throw new Error('The target stage must be positive.');
  return candidates.filter(c => c.peak > 0).map(c => ({ ...c, off: Math.abs(Math.log(c.peak / target)) })).sort((a, b) => a.off - b.off || b.rateAnnual - a.rateAnnual);
}

// `count` rows spread evenly through a list of scenario rows (all of them if fewer).
function sampleEvenly(rows, count) {
  if (!Number.isInteger(count) || count < 1) throw new Error('The sample size is a whole number from 1.');
  if (rows.length <= count) return rows.slice();
  return Array.from({ length: count }, (_, i) => rows[Math.floor(i * rows.length / count)]);
}

// Scenarios drawn with probability proportional to their annual rate, by systematic
// sampling: `count` equally spaced points through the cumulative rate, from a random
// start (`random()` in [0, 1)). A scenario carrying more than 1/count of the total rate
// is drawn several times, so draws are returned as { row, mw, rateAnnual, draws } with
// distinct rows; `total` is the summed rate of the pool the draws represent.
function sampleByRate(rows, count, random = Math.random) {
  if (!Number.isInteger(count) || count < 1) throw new Error('The sample size is a whole number from 1.');
  const total = rows.reduce((sum, r) => sum + r.rateAnnual, 0);
  if (!(total > 0)) throw new Error('None of the scenarios has a positive rate.');
  const step = total / count, start = random() * step, drawn = new Map();
  let cumulative = 0, k = 0;
  for (const r of rows) {
    cumulative += r.rateAnnual;
    while (k < count && start + k * step < cumulative) {
      drawn.set(r.row, { ...r, draws: (drawn.get(r.row)?.draws || 0) + 1 });
      k++;
    }
  }
  return { draws: [...drawn.values()], total, count };
}

// Annual rate at which `metric` reaches each threshold, from rate-proportional draws:
// total rate times the fraction of draws at or above it. `results` are { draws, value }
// for the distinct scenarios drawn. The 90% interval is the Wilson interval on that
// fraction, so it covers the sampling error only (not the model's, nor PTHA18's own
// uncertainty), and it is wide when few draws reach the threshold.
function sampledExceedance(results, total, count, thresholds) {
  const z = 1.645;
  return thresholds.map(threshold => {
    const hits = results.reduce((n, r) => n + (r.value >= threshold ? r.draws : 0), 0), p = hits / count;
    const denominator = 1 + z * z / count, centre = (p + z * z / (2 * count)) / denominator;
    const half = z * Math.sqrt(p * (1 - p) / count + z * z / (4 * count * count)) / denominator;
    return { threshold, hits, rate: total * p, low: total * Math.max(0, centre - half), high: total * Math.min(1, centre + half) };
  });
}

// A small seeded generator (mulberry32) so a sampled ensemble can be repeated.
function seededRandom(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// One scenario (1-based table row, as in the R code) of a source zone.
async function scenario(get, zone, slipType, row) {
  checkZone(zone); checkSlipType(slipType);
  if (!Number.isInteger(row) || row < 1) throw new Error('The scenario row is a whole number from 1.');
  const at = row - 1;
  // Uniform-slip scenarios have a single slip and no target location columns.
  const varying = slipType !== 'uniform';
  const names = ['event_index_string', 'Mw', 'rate_annual', ...(varying ? ['target_lon', 'target_lat', 'event_slip_string'] : ['slip'])];
  const data = parseDapAscii(await get(ascii(eventsFile(zone, slipType), names.map(n => `${n}${range(at, at)}`).join(','))));
  const indices = parseIndices(data.event_index_string[0]);
  const slips = varying ? parseSlips(data.event_slip_string[0]) : indices.map(() => data.slip[0]);
  if (!indices.length || indices.length !== slips.length) throw new Error(`Scenario ${row} lists ${indices.length} unit sources but ${slips.length} slips.`);
  return { zone, slipType, row, mw: data.Mw[0], rateAnnual: data.rate_annual[0], lon: data.target_lon?.[0], lat: data.target_lat?.[0], indices, slips };
}

// Scenario rows within a magnitude range, for choosing one. Reads the whole
// magnitude and rate columns (a few MB for the largest zones).
async function findScenarios(get, zone, slipType, { mwMin = 0, mwMax = 10, onlyPossible = true } = {}) {
  checkZone(zone); checkSlipType(slipType);
  const data = parseDapAscii(await get(ascii(eventsFile(zone, slipType), 'Mw,rate_annual')));
  const rows = [];
  data.Mw.forEach((mw, i) => {
    if (mw >= mwMin && mw <= mwMax && (!onlyPossible || data.rate_annual[i] > 0)) rows.push({ row: i + 1, mw, rateAnnual: data.rate_annual[i] });
  });
  return rows;
}

// The stage (m above mean sea level) over time at one hazard point for a
// scenario: the slip-weighted sum of each unit source's stage there.
async function scenarioStage(get, zone, slipType, row, pointIndex, { concurrency = 4 } = {}) {
  const event = await scenario(get, zone, slipType, row);
  const units = parseDapAscii(await get(ascii(unitFile(zone), `tide_gauge_file${range(0, Math.max(...event.indices) - 1)}`)));
  const files = units.tide_gauge_file;
  if (!files || files.length < Math.max(...event.indices)) throw new Error('A unit source of this scenario has no tsunami run.');
  const path = k => relativePath(files[event.indices[k] - 1]);
  const first = parseDapAscii(await get(ascii(path(0), 'time')));
  const time = first.time;
  const stage = new Float64Array(time.length);
  const unit = async k => {
    const data = parseDapAscii(await get(ascii(path(k), `stage${range(pointIndex, pointIndex)}${range(0, time.length - 1)}`)));
    const series = data.stage?.[0];
    if (!series || series.length !== time.length) throw new Error(`Unit source ${event.indices[k]} returned ${series ? series.length : 0} of ${time.length} time steps.`);
    return series;
  };
  for (let k = 0; k < event.indices.length; k += concurrency) {
    const batch = await Promise.all(Array.from({ length: Math.min(concurrency, event.indices.length - k) }, (_, j) => unit(k + j)));
    batch.forEach((series, j) => { const slip = event.slips[k + j]; for (let t = 0; t < time.length; t++) stage[t] += slip * series[t]; });
  }
  return { event, time: Float64Array.from(time), stage };
}

// ---- many scenarios at one point (for validation against observations) ------

// Every unit source's stage series at one hazard point, as Float32 arrays, plus
// the shared time vector. A scenario at that point is then just a weighted sum
// (see sumScenario), so thousands of scenarios can be tried after one download.
async function unitSeriesAt(get, zone, pointIndex, { concurrency = 6, onProgress = () => {} } = {}) {
  checkZone(zone);
  const stats = parseDapAscii(await get(ascii(unitFile(zone), 'tide_gauge_file')));
  const files = stats.tide_gauge_file;
  const first = parseDapAscii(await get(ascii(relativePath(files[0]), 'time')));
  const time = Float64Array.from(first.time);
  const series = new Array(files.length);
  let next = 0, done = 0;
  const worker = async () => {
    while (next < files.length) {
      const k = next++;
      const data = parseDapAscii(await get(ascii(relativePath(files[k]), `stage${range(pointIndex, pointIndex)}${range(0, time.length - 1)}`)));
      const values = data.stage?.[0];
      if (!values || values.length !== time.length) throw new Error(`Unit source ${k + 1} returned ${values ? values.length : 0} of ${time.length} time steps.`);
      series[k] = Float32Array.from(values);
      onProgress(++done, files.length);
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, files.length) }, worker));
  return { time, series };
}

// Scenario rows `from`..`to` (1-based, inclusive) with their unit sources and slips.
async function scenarioRange(get, zone, slipType, from, to) {
  checkZone(zone); checkSlipType(slipType);
  if (!Number.isInteger(from) || !Number.isInteger(to) || from < 1 || to < from) throw new Error('The scenario range is whole numbers from 1, in order.');
  const varying = slipType !== 'uniform';
  const names = ['Mw', 'rate_annual', 'event_index_string', varying ? 'event_slip_string' : 'slip'];
  const data = parseDapAscii(await get(ascii(eventsFile(zone, slipType), names.map(n => `${n}${range(from - 1, to - 1)}`).join(','))));
  return data.Mw.map((mw, i) => {
    const indices = parseIndices(data.event_index_string[i]);
    return { row: from + i, mw, rateAnnual: data.rate_annual[i], indices, slips: varying ? parseSlips(data.event_slip_string[i]) : indices.map(() => data.slip[i]) };
  });
}

// Magnitude, rate and target (peak-slip) location of scenario rows `from`..`to`
// (1-based, inclusive). Not available for uniform-slip tables.
async function scenarioTargets(get, zone, slipType, from, to) {
  checkZone(zone); checkSlipType(slipType);
  if (slipType === 'uniform') throw new Error('Uniform-slip scenarios have no target location.');
  if (!Number.isInteger(from) || !Number.isInteger(to) || from < 1 || to < from) throw new Error('The scenario range is whole numbers from 1, in order.');
  const data = parseDapAscii(await get(ascii(eventsFile(zone, slipType), ['Mw', 'rate_annual', 'target_lon', 'target_lat'].map(n => `${n}${range(from - 1, to - 1)}`).join(','))));
  return data.Mw.map((mw, i) => ({ row: from + i, mw, rateAnnual: data.rate_annual[i], lon: data.target_lon[i], lat: data.target_lat[i] }));
}

// A scenario's stage at a point from per-unit-source series (arrays as from unitSeriesAt).
function sumScenario(series, indices, slips, out = new Float64Array(series[0].length)) {
  out.fill(0);
  indices.forEach((unit, k) => {
    const u = series[unit - 1];
    if (!u) throw new Error(`Unit source ${unit} is not in this zone.`);
    const slip = slips[k];
    for (let t = 0; t < out.length; t++) out[t] += slip * u[t];
  });
  return out;
}

// ---- turning a long series into a lab input ---------------------------------

// PTHA18's frictionless model overstates late waves; this slow decay after a
// delay is Equation 16 of Davies (2020), as in the PTHA18 access guide.
function delayedLinearFriction(time, stage, { delayHours = 12, drag = 1e-5 } = {}) {
  return Float64Array.from(stage, (v, i) => v * Math.exp(-drag / 2 * Math.max(0, time[i] - delayHours * 3600)));
}

// Green's law from the hazard point's depth to the local depth: eta ~ H^(-1/4),
// bounded so a shallow local depth cannot amplify wildly.
function greenScale(hazardDepth, localDepth) {
  if (!(hazardDepth > 0) || !(localDepth > 0)) throw new Error('Depths for Green\'s-law scaling must be positive.');
  return Math.min(2, Math.max(.5, (hazardDepth / localDepth) ** .25));
}

// Choose the part of a long series to keep. `align`:
//   'arrival' (default) starts `lead` seconds before the wave first exceeds
//             `threshold` of its peak;
//   'peak'    starts `beforePeak` seconds before the largest wave of the whole
//             series, since the biggest waves often arrive hours after the first;
//   'none'    keeps the time since the earthquake.
// `hours` of series are kept. Times are seconds from the new start; `offset` is
// how long after the earthquake that start is. `peak` is the largest |stage| in
// the whole series and `windowPeak` the largest in what is kept.
function trimSeries(time, stage, { lead = 120, threshold = .02, hours = 6, align = 'arrival', beforePeak = 1800 } = {}) {
  if (align === true) align = 'arrival';
  if (align === false) align = 'none';
  if (!['arrival', 'peak', 'none'].includes(align)) throw new Error("Alignment must be 'arrival', 'peak' or 'none'.");
  let peak = 0, peakIndex = 0;
  stage.forEach((v, i) => { if (Math.abs(v) > peak) { peak = Math.abs(v); peakIndex = i; } });
  if (!(peak > 1e-4)) throw new Error('This scenario produces no wave larger than 0.1 mm at this point.');
  let arrival = 0;
  while (Math.abs(stage[arrival]) <= threshold * peak) arrival++;
  const start = align === 'none' ? 0 : align === 'peak' ? Math.max(0, time[peakIndex] - beforePeak) : Math.max(0, time[arrival] - lead);
  const times = [], values = [];
  let windowPeak = 0;
  for (let i = 0; i < time.length; i++) {
    if (time[i] < start) continue;
    if (time[i] - start > hours * 3600) break;
    times.push(+(time[i] - start).toFixed(3));
    values.push(stage[i]);
    windowPeak = Math.max(windowPeak, Math.abs(stage[i]));
  }
  if (times.length < 2) throw new Error('Nothing left after trimming the series.');
  return { times, values, arrival: time[arrival], offset: start, peak, peakTime: time[peakIndex], windowPeak, align };
}

// "seconds,metres" with the provenance as # comments (which the lab ignores).
function toCsv(series, meta) {
  const lines = [
    '# PTHA18 scenario wave series for the Flood Explorer tsunami lab',
    `# source zone ${meta.zone}, ${meta.slipType} slip, scenario row ${meta.row}: Mw ${meta.mw}, annual rate ${Number(meta.rateAnnual).toExponential(2)} (a scenario rate, not a hazard estimate)`,
    `# hazard point ${meta.gaugeID} at ${meta.lon.toFixed(4)} E ${meta.lat.toFixed(4)} N, ocean depth ${meta.depth.toFixed(0)} m, stage above mean sea level (no tide)`,
    `# t = 0 is ${(series.offset / 60).toFixed(1)} min after the earthquake (window aligned to the ${series.align}); the wave first exceeds 2% of its whole-series peak ${(series.arrival / 60).toFixed(1)} min after it, and the largest wave (${series.peak.toFixed(3)} m) is ${(series.peakTime / 60).toFixed(1)} min after it; this file's largest is ${series.windowPeak.toFixed(3)} m`,
    ...(meta.hazard ? [`# PTHA18 hazard at this point: ${meta.hazard}`] : []),
    `# frictionless linear model, 1 arc-minute grid: not reliable nearshore or for late arrivals${meta.friction ? '; delayed linear friction applied (12 h delay, 1e-5 drag)' : ''}${meta.scale && meta.scale !== 1 ? `; scaled by ${meta.scale.toFixed(3)} (Green's law, to ${meta.localDepth} m)` : ''}`,
    '# Geoscience Australia PTHA18, CC BY 4.0, (c) Commonwealth of Australia (Geoscience Australia); https://www.ga.gov.au/scientific-topics/community-safety/data-and-products/ptha ; report http://dx.doi.org/10.11636/Record.2018.041',
    'seconds,metres',
  ];
  series.times.forEach((t, i) => lines.push(`${t},${series.values[i].toFixed(5)}`));
  return lines.join('\n') + '\n';
}

module.exports = {
  DAP_BASE, SLIP_TYPES, parseDapAscii, parseIndices, parseSlips, relativePath, hazardPoints, nearestPoints, pointByGaugeID,
  exceedanceCurve, exceedanceRate, describeRate, ZONES, zoneContributions, stageAtRate, rankByPeak, sampleEvenly, sampleByRate, sampledExceedance, seededRandom, scenario, findScenarios, scenarioStage, unitSeriesAt, scenarioRange, scenarioTargets, sumScenario, delayedLinearFriction, greenScale, trimSeries, toCsv,
};
