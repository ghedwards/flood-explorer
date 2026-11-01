const HOUR = 3600;
const distance = (a, b) => Math.hypot((a.lat - b.lat) * 110.574,
  (a.lon - b.lon) * 111.32 * Math.cos((a.lat + b.lat) * Math.PI / 360));
export function nearbyStorms(snapshot, location, radiusKm = 50) {
  if (snapshot?.schemaVersion !== 1 || !Array.isArray(snapshot.events) || !location || !Number.isFinite(location.lat) || !Number.isFinite(location.lon)) return [];
  return snapshot.events.flatMap(event => {
    if (!event.id || !event.name || !Number.isFinite(Date.parse(event.start)) || !Number.isFinite(Date.parse(event.end))) return [];
    const stations = (Array.isArray(event.stations) ? event.stations : []).filter(station =>
      station.id && station.name && station.unit === 'mm' && station.intervalSeconds === HOUR
      && station.timestampConvention === 'interval-end'
      && Number.isFinite(station.lat) && Number.isFinite(station.lon) && distance(location, station) <= radiusKm
      && Array.isArray(station.rainMm) && station.rainMm.some(validRain));
    return stations.length ? [{ ...event, stations }] : [];
  });
}
const validRain = value => Number.isFinite(value) && value >= 0 && value <= 1000;
export function recordedWindow(event, station, startHour, seconds, runoffPercent) {
  if (!Number.isInteger(startHour) || startHour < 0 || !Number.isFinite(seconds) || seconds <= 0 || seconds > 86400
    || !Number.isFinite(runoffPercent) || runoffPercent < 0 || runoffPercent > 100) throw new Error('Choose a start, a duration up to 24 hours and runoff from 0 to 100%.');
  const count = Math.ceil(seconds / HOUR), values = station.rainMm.slice(startHour, startHour + count);
  const start = Date.parse(event.start) + startHour * HOUR * 1000;
  if (values.length !== count || !values.every(validRain) || start + seconds * 1000 > Date.parse(event.end)) {
    throw new Error('The selected window contains missing rainfall or extends beyond the record. Choose a shorter, complete window.');
  }
  const rainfallMm = values.reduce((sum, value, i) => sum + value * Math.min(1, (seconds - i * HOUR) / HOUR), 0);
  return { series: Float64Array.from([...values.map(v => v * runoffPercent / 100), 0]), stepSeconds: HOUR,
    eventId: event.id, eventName: event.name, stationId: station.id, stationName: station.name,
    start: new Date(start).toISOString(), end: new Date(start + seconds * 1000).toISOString(),
    rainfallMm, runoffPercent, effectiveMm: rainfallMm * runoffPercent / 100 };
}
export const stormTime = value => new Date(value).toLocaleString('en-AU', {
  timeZone: 'Australia/Brisbane', day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false,
}) + ' AEST';

export function createRecordedStormPicker({ document, getLocation, fetcher = fetch, onChange = () => {} }) {
  const el = id => document.getElementById(id);
  const root = el('recordedRainControls'), unavailable = el('recordedRainUnavailable');
  const eventSelect = el('recordedRainEvent'), stationSelect = el('recordedRainStation'), startSelect = el('recordedRainStart');
  const fraction = el('recordedRainRunoff'), preview = el('recordedRainPreview'), note = el('recordedRainNote');
  const manual = [el('inertialRain'), el('inertialRainSeries')];
  let snapshot = null, pending = null, events = [], locationKey = null;
  const option = (select, value, label) => { const item = document.createElement('option'); item.value = value; item.textContent = label; select.appendChild(item); };
  const current = () => {
    const event = events.find(e => e.id === eventSelect.value);
    return { event, station: event?.stations.find(s => s.id === stationSelect.value) };
  };
  function details(resetStart = false) {
    const { event, station } = current();
    stationSelect.disabled = !event;
    startSelect.disabled = !station; fraction.disabled = !station;
    fraction.required = !!station;
    manual.forEach(input => { input.disabled = !!event; });
    if (resetStart) {
      startSelect.replaceChildren();
      if (station) station.rainMm.forEach((value, hour) => {
        if (validRain(value)) option(startSelect, String(hour), `${stormTime(Date.parse(event.start) + hour * HOUR * 1000)} · ${value} mm`);
      });
      if (station) {
        const firstRain = station.rainMm.findIndex(value => validRain(value) && value > 0);
        if (firstRain >= 0) startSelect.value = String(firstRain);
      }
    }
    preview.replaceChildren();
    note.textContent = '';
    if (!station) return;
    const first = Number(startSelect.value), count = Math.ceil(Number(el('inertialMinutes').value) / 60);
    const max = Math.max(1, ...station.rainMm.filter(validRain));
    const bars = station.rainMm.map((value, hour) => {
      const selected = hour >= first && hour < first + count;
      return `<rect x="${hour}" y="${validRain(value) ? 48 - value / max * 44 : 47}" width="0.9" height="${validRain(value) ? Math.max(0, value / max * 44) : 1}" fill="${!validRain(value) ? '#c62828' : selected ? '#125f8c' : '#819ca8'}"/>`;
    });
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('viewBox', `0 0 ${station.rainMm.length} 50`); svg.setAttribute('preserveAspectRatio', 'none');
    svg.setAttribute('role', 'img'); svg.setAttribute('aria-label', 'Recorded hourly rainfall; selected hours blue, missing hours red.');
    svg.innerHTML = bars.join(''); preview.appendChild(svg);
    const missing = station.rainMm.filter(value => !validRain(value)).length;
    note.textContent = `${station.name}. ${stormTime(event.start)} to ${stormTime(event.end)}. ${missing} missing hours (red); gaps cannot be replayed. `;
    if (fraction.value.trim()) {
      try {
        const run = recordedWindow(event, station, first, Number(el('inertialMinutes').value) * 60, Number(fraction.value));
        note.textContent += `Selected: ${run.rainfallMm.toFixed(1)} mm observed, ${run.effectiveMm.toFixed(1)} mm effective runoff.`;
      } catch (error) { note.textContent += error.message; }
    } else note.textContent += 'Set the share of rainfall becoming runoff before running.';
  }
  function stations() {
    stationSelect.replaceChildren();
    const { event } = current();
    if (event) event.stations.forEach(station => option(stationSelect, station.id, station.name));
    details(true);
  }
  function refresh() {
    const location = getLocation();
    if (!location) { root.hidden = true; unavailable.hidden = true; locationKey = null; eventSelect.value = ''; stations(); return Promise.resolve(); }
    if (!pending) pending = Promise.resolve().then(() => fetcher('data/national/rain-storms.json', { cache: 'no-cache' }))
      .then(response => { if (!response.ok) throw new Error('Snapshot unavailable'); return response.json(); })
      .then(value => { if (value.schemaVersion !== 1) throw new Error('Unsupported snapshot'); snapshot = value; })
      .catch(() => { snapshot = null; });
    return pending.then(() => {
      const location = getLocation();
      if (!location) return;
      const key = `${location.lat},${location.lon}`;
      if (key === locationKey) return;
      locationKey = key;
      events = nearbyStorms(snapshot, location);
      root.hidden = !events.length; unavailable.hidden = !!events.length;
      unavailable.textContent = snapshot ? 'No recorded rainfall stations within 50 km of this model. Manual rainfall remains available.'
        : 'Recorded rainfall is unavailable in this data snapshot. Manual rainfall remains available.';
      eventSelect.replaceChildren(); option(eventSelect, '', 'Manual rainfall');
      events.forEach(event => option(eventSelect, event.id, event.name));
      stations();
    });
  }
  eventSelect.addEventListener('change', () => { stations(); onChange(); });
  stationSelect.addEventListener('change', () => { details(true); onChange(); });
  startSelect.addEventListener('change', () => { details(); onChange(); });
  fraction.addEventListener('input', () => { details(); });
  el('inertialMinutes').addEventListener('input', () => details());
  details();
  return { refresh, getRun(seconds) {
    if (!eventSelect.value) return null;
    const { event, station } = current();
    if (!event || !station || !fraction.value.trim()) throw new Error('Choose a recorded station and set the rainfall becoming runoff.');
    if (!nearbyStorms(snapshot, getLocation()).some(e => e.id === event.id && e.stations.some(s => s.id === station.id))) throw new Error('Choose a station near the current model.');
    return recordedWindow(event, station, Number(startSelect.value), seconds, Number(fraction.value));
  } };
}
