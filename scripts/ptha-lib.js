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
    `# frictionless linear model, 1 arc-minute grid: not reliable nearshore or for late arrivals${meta.friction ? '; delayed linear friction applied (12 h delay, 1e-5 drag)' : ''}${meta.scale && meta.scale !== 1 ? `; scaled by ${meta.scale.toFixed(3)} (Green's law, to ${meta.localDepth} m)` : ''}`,
    '# Geoscience Australia PTHA18, CC BY 4.0, (c) Commonwealth of Australia (Geoscience Australia); https://www.ga.gov.au/scientific-topics/community-safety/data-and-products/ptha ; report http://dx.doi.org/10.11636/Record.2018.041',
    'seconds,metres',
  ];
  series.times.forEach((t, i) => lines.push(`${t},${series.values[i].toFixed(5)}`));
  return lines.join('\n') + '\n';
}

module.exports = {
  DAP_BASE, SLIP_TYPES, parseDapAscii, parseIndices, parseSlips, relativePath, hazardPoints, nearestPoints, pointByGaugeID,
  scenario, findScenarios, scenarioStage, delayedLinearFriction, greenScale, trimSeries, toCsv,
};
