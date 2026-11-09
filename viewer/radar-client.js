// Fetches recent radar frames from the broker's /v1/radar (rust/flood-broker/src/radar.rs) for one model area.
//
// It asks the broker where its radar is (meta=1), works out the window around the area in the radar's own
// coordinates, fetches the latest frames for that window, and checks everything the live-storm builder
// (rust/flood-core/src/live.rs) relies on. Anything that is missing, old, irregular or in a coordinate system the
// page cannot place is an error with a plain message: a radar problem never turns into "no rain".

export const RADAR_FRAMES = 7;          // the last hour at 10-minute spacing, the newest being now
export const RADAR_MARGIN_M = 60000;    // radar kept around the area: upwind rain the forecast will bring in
export const MAX_AGE_S = 30 * 60;       // an older newest frame is refused

export class RadarError extends Error {
  constructor(code, message) { super(message); this.name = 'RadarError'; this.code = code; }
}

// EPSG codes of the Map Grid of Australia: GDA94 zones 49 to 58 (28349 to 28358) and GDA2020 zones 49 to 59 (7849 to 7859).
export function mgaZone(crs) {
  const m = /^EPSG:(\d+)$/i.exec(String(crs || '').trim());
  if (!m) return null;
  const code = Number(m[1]);
  if (code >= 28349 && code <= 28358) return code - 28300;
  if (code >= 7849 && code <= 7859) return code - 7800;
  return null;
}

// The window to ask for: the area's corners and edge midpoints in the radar's coordinates, plus a margin.
// `toMga(lat, lon, zone)` returns [easting, northing]. The result is [easting0, northing0, easting1, northing1].
export function radarWindow(geo, zone, toMga, margin = RADAR_MARGIN_M) {
  const lats = [geo.south, (geo.south + geo.north) / 2, geo.north], lons = [geo.west, (geo.west + geo.east) / 2, geo.east];
  const pts = lats.flatMap((la) => lons.map((lo) => toMga(la, lo, zone)));
  const es = pts.map((p) => p[0]), ns = pts.map((p) => p[1]);
  return [Math.min(...es) - margin, Math.min(...ns) - margin, Math.max(...es) + margin, Math.max(...ns) + margin];
}

async function getJson(fetchFn, url, timeoutMs) {
  let res;
  try { res = await fetchFn(url, { cache: 'no-store', signal: AbortSignal.timeout(timeoutMs) }); }
  catch (e) { throw new RadarError('network', e && e.name === 'TimeoutError' ? 'The radar service took too long to answer.' : 'The radar service could not be reached.'); }
  let body = null;
  try { body = await res.json(); } catch (e) { /* a non-JSON error page */ }
  if (res.ok) {
    if (!body || typeof body !== 'object') throw new RadarError('bad-data', 'The radar service sent something that is not data.');
    return body;
  }
  if (res.status === 404 && body && body.status === 'unconfigured') throw new RadarError('unconfigured', 'This broker has no radar set up.');
  if (res.status === 404 && body && body.status === 'outside') throw new RadarError('outside', 'This area is outside the radar\'s coverage.');
  if (res.status === 503) throw new RadarError('unavailable', `The radar has no data right now${body && body.status === 'empty' ? ' (its store is empty)' : ''}. It is not treated as dry.`);
  throw new RadarError('unavailable', `The radar service had a problem (${res.status}${body && body.error ? `: ${String(body.error).slice(0, 120)}` : ''}).`);
}

const finite = (v) => typeof v === 'number' && Number.isFinite(v);

// Check a /v1/radar answer and join its frames end to end for the solver. Returns { radar, zone, info }.
export function readRadar(body, zone) {
  if (body.status === 'stale') throw new RadarError('stale', `The newest radar frame is ${Math.round((body.ageSeconds || 0) / 60)} minutes old, too old to forecast from.`);
  if (body.status !== 'ok') throw new RadarError('bad-data', 'The radar service did not say its data was current.');
  const g = body.grid;
  if (!g || !['w', 'h', 'x0', 'y0', 'dx', 'dy'].every((k) => finite(g[k])) || g.w < 2 || g.h < 2 || g.dx <= 0 || g.dy <= 0) throw new RadarError('bad-data', 'The radar grid is not usable.');
  if (!Array.isArray(body.frames) || body.frames.length < 2) throw new RadarError('bad-data', 'Need at least two radar frames to see which way the rain is moving.');
  if (body.regular !== true || !finite(body.stepSeconds) || body.stepSeconds < 60 || body.stepSeconds > 3600) throw new RadarError('bad-data', 'The radar frames are not evenly spaced, so the rain\'s speed cannot be told.');
  if (finite(body.ageSeconds) && body.ageSeconds > MAX_AGE_S) throw new RadarError('stale', `The newest radar frame is ${Math.round(body.ageSeconds / 60)} minutes old, too old to forecast from.`);
  const cells = g.w * g.h, flat = new Float64Array(cells * body.frames.length);
  body.frames.forEach((f, k) => {
    if (!Array.isArray(f) || f.length !== cells) throw new RadarError('bad-data', `Radar frame ${k} is the wrong size.`);
    for (let i = 0; i < cells; i++) {
      const v = f[i];
      if (!finite(v)) throw new RadarError('bad-data', `Radar frame ${k} has a value that is not a number.`);
      flat[k * cells + i] = v;
    }
    if (f.some((v) => v < 0)) throw new RadarError('gaps', `Radar frame ${k} has cells the radar did not measure, so a live storm cannot be built from it.`);
  });
  return {
    radar: { radarW: g.w, radarH: g.h, radarX0: g.x0, radarY0: g.y0, radarDx: g.dx, radarDy: g.dy, radarStepS: body.stepSeconds, radarFrames: flat },
    zone,
    info: { source: body.source, attribution: body.attribution, licence: body.licence, crs: body.crs, times: body.times, ageSeconds: body.ageSeconds, frames: body.frames.length, stepSeconds: body.stepSeconds },
  };
}

// Fetch the radar for an area. `geo` is the area's { west, east, north, south }; `toMga` projects a point.
export async function fetchRadar({ broker, geo, toMga, frames = RADAR_FRAMES, fetchFn = (...a) => fetch(...a), timeoutMs = 20000 }) {
  if (!broker) throw new RadarError('unconfigured', 'This build has no live data broker.');
  const base = String(broker).replace(/\/+$/, '');
  const meta = await getJson(fetchFn, `${base}/v1/radar?meta=1`, timeoutMs);
  const zone = mgaZone(meta.crs);
  if (zone == null) throw new RadarError('unsupported-crs', `The radar uses ${String(meta.crs).slice(0, 40)}, which this page cannot place on the map (it understands the MGA zones).`);
  const win = radarWindow(geo, zone, toMga);
  const body = await getJson(fetchFn, `${base}/v1/radar?frames=${frames}&bbox=${win.map((v) => Math.round(v)).join(',')}`, timeoutMs);
  return readRadar(body, zone);
}
