import '@fontsource-variable/archivo/standard.css';
import '@fontsource/ibm-plex-mono/latin-400.css';
import './tsunami.css';
import { tsunamiGrid } from './tsunami-grid.js';

const $ = id => document.getElementById(id);
const map = $('waveMap'), ctx = map.getContext('2d');
const traces = $('traces'), chart = traces.getContext('2d');
const pixels = document.createElement('canvas');
const pixelContext = pixels.getContext('2d');
const colours = ['#007e92', '#ac5528', '#7f60a0'];
let probes = [[65, 48], [105, 35], [122, 60]];
let source = [38, 48], grid, frame, worker, ready = false, busy = false, running = false;
let budget = 0, previousWall = 0, history = [];
let bathymetry = null, sceneVersion = 0;
const coastIds = ['moreton', 'gold-coast', 'coffs', 'newcastle', 'sydney'];
const options = () => ({ preset: $('preset').value, deep: +$('deep').value, amplitude: +$('amplitude').value,
  width: +$('width').value, source, absorbing: $('absorbing').checked, method: $('method').value });
const totalSeconds = () => +$('duration').value * 60;
const sample = (values, [x, y]) => grid.depth[y * grid.W + x] > 0 ? values[y * grid.W + x] : null;
const timeLabel = seconds => `${String(Math.floor(seconds / 60)).padStart(2, '0')}:${String(Math.floor(seconds % 60)).padStart(2, '0')}`;

function controls() {
  $('play').disabled = !ready;
  $('step').disabled = !ready || running || busy || frame.time >= totalSeconds();
  $('play').textContent = !ready ? 'Loading Rust…' : running ? 'Pause' : frame.time >= totalSeconds() ? 'Replay' : 'Play';
}

function labels() {
  $('deep').disabled = !!bathymetry;
  $('deepValue').textContent = `${Math.round(bathymetry ? Math.max(...grid.depth) : +$('deep').value).toLocaleString('en-AU')} m`;
  $('amplitudeValue').textContent = `${(+$('amplitude').value).toFixed(2)} m`;
  $('widthValue').textContent = `${$('width').value} km`;
  const sourceDepth = grid.depth[source[1] * grid.W + source[0]];
  $('sourceValue').textContent = bathymetry ? coordinates(source) : `${source[0]} km E · ${source[1]} km S`;
  $('waveSpeed').textContent = `${(Math.sqrt(9.81 * sourceDepth) * 3.6).toFixed(0)} km/h`;
  $('scenarioName').textContent = $('preset').selectedOptions[0].textContent;
  $('methodHint').textContent = $('method').value === 'staggered'
    ? 'Staggered-grid propagation with low numerical damping. Both methods solve linear shallow-water equations; neither models onshore flooding.'
    : 'Finite-volume acoustic fluxes with RK2 time stepping. This first-order spatial method damps short waves more. It solves the same linear equations; it does not add inundation physics.';
  $('mapHint').textContent = `${grid.W * grid.cell / 1000} × ${grid.H * grid.cell / 1000} km ${bathymetry ? 'Australian coastal subset' : 'idealised basin'} · ${grid.cell / 1000} km cells · Click the ocean to move the hypothetical source. Markers 1–3 are virtual gauges.`;
  $('dataNote').textContent = bathymetry
    ? 'Real coastal topography and bathymetry, with a hypothetical offshore pulse. This is not a historical earthquake reconstruction or a coastal hazard prediction. Land remains a reflecting wall: no river flow, run-up or inundation.'
    : 'Synthetic ocean depths and a prescribed uplift/subsidence pulse. This is not an earthquake scenario or a prediction for a real coast. It does not model wave breaking, shoreline run-up or inundation.';
  $('dataCredit').hidden = !bathymetry;
  if (bathymetry) {
    $('dataCredit').replaceChildren(document.createTextNode(`${bathymetry.source}. Resampled to 1.5 km; wet cells shallower than 10 m are floored to 10 m. ${bathymetry.attribution}. `));
    const link = document.createElement('a'); link.href = bathymetry.metadataUrl; link.target = '_blank'; link.rel = 'noopener'; link.textContent = 'Dataset metadata ↗'; $('dataCredit').append(link);
  }
}

function coordinates([x, y]) {
  const [west, south, east, north] = bathymetry.bounds;
  return `${Math.abs(north - (y + .5) / grid.H * (north - south)).toFixed(3)}° S · ${(west + (x + .5) / grid.W * (east - west)).toFixed(3)}° E`;
}

function waterPoint(elevation, target, minDepth) {
  let best = null, distance = Infinity;
  for (let i = 0; i < elevation.length; i++) if (elevation[i] < -minDepth) {
    const point = [i % 160, Math.floor(i / 160)];
    const d = Math.hypot(point[0] - target[0], point[1] - target[1]);
    if (d < distance) { distance = d; best = point; }
  }
  if (!best) throw new Error('No suitable ocean cells in this subset.');
  return best;
}

async function changeScene() {
  const version = ++sceneVersion, id = $('preset').value;
  if (!coastIds.includes(id)) { bathymetry = null; source = [38, 48]; probes = [[65, 48], [105, 35], [122, 60]]; reset(); return; }
  ready = running = false; controls();
  if (worker) worker.terminate();
  $('status').textContent = 'Loading the prefetched Australian coastal grid…';
  try {
    const response = await fetch(new URL(`tsunami-data/${id}.json`, document.baseURI), { signal: AbortSignal.timeout(15000) });
    if (!response.ok) throw new Error(`Coastal grid: HTTP ${response.status}`);
    const data = await response.json();
    const nextSource = waterPoint(data.elevation || [], [120, 48], 500);
    // Validate the entire numeric grid before accepting it into the UI.
    tsunamiGrid({ ...options(), bathymetry: data, source: nextSource });
    if (version !== sceneVersion) return;
    bathymetry = data; source = nextSource;
    probes = [[62, 26], [62, 48], [62, 70]].map(point => waterPoint(data.elevation, point, 30));
    reset();
  } catch (error) {
    if (version === sceneVersion) $('status').textContent = `${error.message} The grid could not load. Reset to retry or choose an idealised scene.`;
  }
}

function paint() {
  if (!frame || !grid) return;
  const peakView = $('view').value === 'peak';
  const values = peakView ? frame.peak : frame.eta;
  const scale = +$('amplitude').value * 1.5;
  pixels.width = grid.W; pixels.height = grid.H;
  const image = pixelContext.createImageData(grid.W, grid.H);
  for (let i = 0; i < values.length; i++) {
    let rgb;
    if (!grid.depth[i]) rgb = [77, 91, 79];
    else {
      const v = Math.max(-1, Math.min(1, values[i] / scale));
      const referenceDepth = bathymetry ? 5500 : +$('deep').value;
      const base = 220 + 25 * (1 - Math.min(1, grid.depth[i] / referenceDepth));
      const target = v < 0 ? [22, 113, 174] : [216, 80, 27];
      rgb = target.map(c => Math.round(base + (c - base) * Math.abs(v)));
    }
    image.data.set([...rgb, 255], i * 4);
  }
  pixelContext.putImageData(image, 0, 0);
  ctx.imageSmoothingEnabled = false;
  ctx.drawImage(pixels, 0, 0, map.width, map.height);
  const sx = map.width / grid.W, sy = map.height / grid.H;
  const screen = map.width / Math.max(1, map.getBoundingClientRect().width);
  ctx.strokeStyle = '#35657855'; ctx.lineWidth = screen;
  for (let x = 20; x < grid.W; x += 20) { ctx.beginPath(); ctx.moveTo(x * sx, 0); ctx.lineTo(x * sx, map.height); ctx.stroke(); }
  for (let y = 20; y < grid.H; y += 20) { ctx.beginPath(); ctx.moveTo(0, y * sy); ctx.lineTo(map.width, y * sy); ctx.stroke(); }
  ctx.strokeStyle = '#172f3b'; ctx.lineWidth = 1.5 * screen;
  const px = (source[0] + .5) * sx, py = (source[1] + .5) * sy;
  ctx.beginPath(); ctx.moveTo(px - 7 * screen, py); ctx.lineTo(px + 7 * screen, py); ctx.moveTo(px, py - 7 * screen); ctx.lineTo(px, py + 7 * screen); ctx.stroke();
  ctx.font = `bold ${12 * screen}px system-ui`; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  probes.forEach(([x, y], n) => {
    ctx.beginPath(); ctx.arc((x + .5) * sx, (y + .5) * sy, 10 * screen, 0, Math.PI * 2);
    ctx.fillStyle = '#ffffff'; ctx.fill(); ctx.strokeStyle = colours[n]; ctx.stroke();
    ctx.fillStyle = colours[n]; ctx.fillText(String(n + 1), (x + .5) * sx, (y + .5) * sy);
  });
  $('clock').textContent = `${timeLabel(frame.time)} simulated`;
  $('range').textContent = peakView ? `0 to ${scale.toFixed(2)} m` : `−${scale.toFixed(2)} to +${scale.toFixed(2)} m`;
  $('legend').textContent = peakView ? 'White: no displacement · Orange: maximum |wave|' : 'Blue: drawdown · White: still water · Orange: crest';
  $('peakValue').textContent = `${Math.max(...frame.peak).toFixed(2)} m`;
  $('gaugeValues').replaceChildren(...probes.map((point, i) => {
    const span = document.createElement('span');
    const value = sample(frame.eta, point);
    span.textContent = `${i + 1}: ${value == null ? 'on land' : `${value >= 0 ? '+' : ''}${value.toFixed(3)} m`}`;
    span.style.color = colours[i];
    return span;
  }));
  paintTraces();
}

function paintTraces() {
  const W = Math.max(1, traces.getBoundingClientRect().width), H = 180, pad = 50;
  const ratio = window.devicePixelRatio || 1;
  traces.width = Math.round(W * ratio); traces.height = Math.round(H * ratio);
  chart.setTransform(ratio, 0, 0, ratio, 0, 0);
  const scale = Math.max(.1, ...history.flatMap(row => row.slice(1).filter(Number.isFinite).map(Math.abs))) * 1.2;
  chart.clearRect(0, 0, W, H);
  chart.fillStyle = '#526c7c'; chart.font = '12px system-ui'; chart.textAlign = 'left';
  chart.strokeStyle = '#d8e3e5'; chart.lineWidth = 1;
  for (const n of [-1, 0, 1]) {
    const y = H / 2 - n * (H / 2 - 25);
    chart.beginPath(); chart.moveTo(pad, y); chart.lineTo(W - 10, y); chart.stroke();
    chart.fillText(`${(n * scale).toFixed(2)} m`, 0, y - 5);
  }
  chart.fillText('0 min', pad, H - 2);
  chart.textAlign = 'right'; chart.fillText(`${$('duration').value} min`, W - 10, H - 2);
  for (let p = 0; p < probes.length; p++) {
    chart.beginPath(); chart.strokeStyle = colours[p]; chart.lineWidth = 2;
    let first = true;
    for (const row of history) {
      if (row[p + 1] == null) continue;
      const x = pad + row[0] / totalSeconds() * (W - pad - 10);
      const y = H / 2 - row[p + 1] / scale * (H / 2 - 25);
      if (first) chart.moveTo(x, y); else chart.lineTo(x, y);
      first = false;
    }
    chart.stroke();
  }
}

function fail(message) {
  ready = running = busy = false;
  if (worker) worker.terminate();
  controls();
  $('play').textContent = 'Unavailable';
  $('status').textContent = `${message} Reset to try again.`;
}

function reset(play = false) {
  let next;
  try { next = tsunamiGrid({ ...options(), bathymetry }); } catch (error) { $('status').textContent = error.message; return; }
  if (worker) worker.terminate();
  grid = next; frame = null; history = []; ready = running = busy = false; budget = 0;
  labels(); controls();
  $('status').textContent = 'Starting a fresh Rust wave simulation…';
  const current = worker = new Worker(new URL('./tsunami-worker.js', import.meta.url), { type: 'module' });
  current.onerror = () => { if (worker === current) fail('The wave worker could not start.'); };
  current.onmessage = ({ data }) => {
    if (worker !== current) return;
    if (data.error) { fail(data.error); return; }
    frame = data.frame; busy = false;
    if (!ready) { ready = true; running = play; }
    if (!history.length || frame.time - history.at(-1)[0] >= 15)
      history.push([frame.time, ...probes.map(point => sample(frame.eta, point))]);
    if (frame.time >= totalSeconds()) running = false;
    $('status').textContent = frame.time >= totalSeconds() ? 'Simulation complete. Replay or adjust the source to explore another scenario.'
      : running ? 'Running in a Rust / WASM worker. Controls remain responsive.' : 'Paused. Press Play, Step, or move the source.';
    paint(); controls();
  };
  current.postMessage({ type: 'start', grid });
}

function advance(steps) {
  if (!ready || busy || frame.time >= totalSeconds()) return;
  busy = true;
  const remaining = Math.ceil((totalSeconds() - frame.time) / frame.dt);
  worker.postMessage({ type: 'step', steps: Math.min(200, steps, remaining) });
  controls();
}

function animate(now) {
  const elapsed = Math.min(.1, Math.max(0, (now - previousWall) / 1000));
  previousWall = now;
  if (ready && running) {
    budget += elapsed * +$('speed').value * 60;
    const steps = Math.min(200, Math.floor(budget / frame.dt));
    if (steps > 0 && !busy) { budget -= steps * frame.dt; advance(steps); }
  } else budget = 0;
  requestAnimationFrame(animate);
}

$('play').addEventListener('click', () => {
  if (frame.time >= totalSeconds()) { reset(true); return; }
  running = !running;
  $('status').textContent = running ? 'Running in a Rust / WASM worker.' : 'Paused.';
  controls();
});
$('step').addEventListener('click', () => advance(8));
$('reset').addEventListener('click', () => coastIds.includes($('preset').value) && bathymetry?.id !== $('preset').value ? changeScene() : reset());
$('preset').addEventListener('change', changeScene);
for (const id of ['deep', 'amplitude', 'width', 'absorbing', 'duration', 'method']) $(id).addEventListener('change', () => reset());
for (const id of ['deep', 'amplitude', 'width']) $(id).addEventListener('input', labels);
$('view').addEventListener('change', paint);
function moveSource(next) {
  if (!ready) return;
  const x = Math.floor(next[0]), y = Math.floor(next[1]);
  if (x < 0 || y < 0 || x >= grid.W || y >= grid.H || !grid.depth[y * grid.W + x]) {
    $('status').textContent = 'Choose a source in the ocean; the fixed land cells cannot generate a wave.';
    return;
  }
  source = [x, y]; reset();
}
map.addEventListener('click', event => {
  const rect = map.getBoundingClientRect();
  moveSource([(event.clientX - rect.left) / rect.width * grid.W, (event.clientY - rect.top) / rect.height * grid.H]);
});
map.addEventListener('keydown', event => {
  const direction = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] }[event.key];
  if (direction) { event.preventDefault(); moveSource([source[0] + direction[0], source[1] + direction[1]]); }
  if (event.key === 'Enter' && ready) { event.preventDefault(); $('play').click(); }
});
$('export').addEventListener('click', () => {
  const metadata = `# Hypothetical tsunami propagation; ${JSON.stringify({ ...options(), bathymetry: bathymetry ? { source: bathymetry.source, bounds: bathymetry.bounds, attribution: bathymetry.attribution, cell: grid.cell } : 'synthetic' })}\n`;
  const csv = metadata + 'seconds,gauge_1_m,gauge_2_m,gauge_3_m\n' + history.map(row => row.map(v => v == null ? '' : v).join(',')).join('\n');
  const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv' }));
  const link = document.createElement('a'); link.href = url; link.download = 'tsunami-lab-gauges.csv'; link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
});
window.__tsunamiStatus = () => ({ ready, running, time: frame?.time || 0, engine: 'rust-wasm', method: $('method').value, coast: bathymetry?.id || null, source: [...source], samples: history.length, peak: frame ? Math.max(...frame.peak) : 0 });
window.addEventListener('pagehide', () => { if (worker) worker.terminate(); });
window.addEventListener('resize', paint);
reset();
requestAnimationFrame(animate);
