import { desktopUpdates } from './desktop-updates.js';
import { createFeedClient } from './feed-health.js';
import './inertial-grid.js';
import { fineRaster, fineWindow, cropGrid } from './fine-raster.js';
import { classifyDemGaps } from './dem-voids.js';
import { warningTargets, gaugeForTarget } from './warn-peaks.js';
import { overlayDrawn, overlayImageUrl, PIXELS_DRAWN } from './overlay-state.js';
/* Flood Explorer — viewer
 *
 * Loads a terrain (sample, a pipeline-processed area, or the user's own DEM),
 * runs FloodCore for the chosen scenario and draws the map, stats and river
 * long-section.
 */
(function () {
  'use strict';
  const F = window.FloodCore;
  const $ = (id) => document.getElementById(id);

  // Peak heights at the Brisbane City gauge (m), from the Bureau of
  // Meteorology's lower Brisbane River flood warning brochure.
  const BRISBANE_EVENTS = [
    { id: '2013', label: '2013', level: 2.30 },
    { id: '2022', label: '2022', level: 3.85 },
    { id: '2011', label: '2011', level: 4.46 },
    { id: '1974', label: '1974', level: 5.45 },
    { id: '1893', label: '1893', level: 8.35 },
  ];
  const BASELINE = { gaugeLevel: 0.5, bayLevel: 0 }; // "normal" water for comparison

  const state = {
    areaId: null, areaMeta: null,
    grid: null, a: null, gauge: -1,
    events: BRISBANE_EVENTS, eventsApply: true,
    streamAreaKm2: 4,
    run: null, base: null, terrain: null,
    offscreen: document.createElement('canvas'),
    hover: -1,
  };

  /* ------------------------------------------------------------ controls */

  const ctl = {
    gaugeLevel: $('gaugeLevel'), bayLevel: $('bayLevel'), slr: $('slr'),
    extra: $('extra'), grad: $('grad'), streamArea: $('streamArea'),
    floodType: $('floodType'), rainMm: $('rainMm'), stormHours: $('stormHours'), ground: $('ground'), pipes: $('pipes'), warming: $('warming'),
  };
  // soil and surface losses for each ground type: initial loss (mm) and
  // continuing loss (mm/h), in the range Australian Rainfall and Runoff
  // gives for sealed urban, typical and dry/sandy catchments
  const GROUND = { urban: [3, 0.5], typical: [20, 2], dry: [40, 6] };
  // example storms (not official design values for any place)
  const STORMS = [['Heavy shower', 30, 1], ['Severe storm', 80, 1], ['Long downpour', 150, 3], ['Extreme rain', 300, 24]];
  function storm() {
    const [il, cl] = GROUND[ctl.ground.value] || GROUND.typical;
    const hours = parseFloat(ctl.stormHours.value), warm = parseFloat(ctl.warming.value) || 0;
    // a warmer climate: more rain from the same storm (ARR draft guidance)
    const uplift = F.stormUplift(hours, warm);
    const o = { rainMm: parseFloat(ctl.rainMm.value) * uplift, hours, initialLoss: il, contLoss: cl, uplift, warming: warm };
    const pipeMmH = parseFloat(ctl.pipes.value) || 0;
    if (pipeMmH > 0) {
      const urban = urbanMask();
      if (urban) Object.assign(o, { urban, pipeMmH });
    }
    return o;
  }
  // Built-up land for the pipes: cells with at least 3 OpenStreetMap
  // buildings within about 60 m (the buildings come with the impact data;
  // they are fetched the first time pipes are needed)
  function urbanMask() {
    const area = state.areaKey && areaReg.get(state.areaKey), a = state.a;
    if (!area || !a) return null;
    const d = area.impact;
    if (!d) {
      if (!area.impactLoading) {
        area.impactLoading = true;
        countImpact().then(() => { area.impactLoading = false; if (ctl.floodType.value !== 'river') runScenario(); });
      }
      return null;
    }
    if (d.error || !d.bx) return null;
    if (area.urban && area.urban.src === d) return area.urban.mask;
    const n = new Uint16Array(a.N);
    for (let i = 0; i < d.bx.length; i++) { const c = cellOf(d.by[i], d.bx[i]); if (c >= 0) n[c]++; }
    const r = Math.max(1, Math.round(60 / a.cell)), W = a.W, H = a.H;
    // box sums over (2r+1)² cells, rows then columns
    const rowS = new Uint16Array(a.N), mask = new Uint8Array(a.N);
    for (let y = 0; y < H; y++) { let acc = 0; for (let x = -r; x < W; x++) { if (x + r < W) acc += n[y * W + x + r]; if (x - r - 1 >= 0) acc -= n[y * W + x - r - 1]; if (x >= 0) rowS[y * W + x] = acc; } }
    for (let x = 0; x < W; x++) { let acc = 0; for (let y = -r; y < H; y++) { if (y + r < H) acc += rowS[(y + r) * W + x]; if (y - r - 1 >= 0) acc -= rowS[(y - r - 1) * W + x]; if (y >= 0 && acc >= 3) mask[y * W + x] = 1; } }
    area.urban = { src: d, mask };
    return mask;
  }
  const fmt = (v, d) => (Math.round(v * 10 ** d) / 10 ** d).toFixed(d);
  const streamFromSlider = (v) => 0.02 * Math.pow(10, (v / 100) * 3); // 0.02–20 km²
  const sliderFromStream = (km2) => Math.round((Math.log10(km2 / 0.02) / 3) * 100);

  function scenario() {
    const slr = parseFloat(ctl.slr.value);
    return {
      gauge: state.gauge,
      gaugeLevel: parseFloat(ctl.gaugeLevel.value) + parseFloat(ctl.extra.value),
      bayLevel: parseFloat(ctl.bayLevel.value) + slr,
      upstreamGradient: parseFloat(ctl.grad.value),
      backwater: !!($('backwater') && $('backwater').checked),
      controls: (state.controls || []).map((c) => ({ cell: c.cell, level: c.level })),
      gates: state.gateCells || [],
      levee: state.leveeMask || null,
    };
  }

  /* The river below the gauge. A river model used to draw the water surface
   * from the gauge to the sea (or the model's edge) as a straight line, which
   * left inland rivers dry below the gauge (the line ran down to sea level at
   * the edge, tens of metres under the bed) and floated metres above the bed
   * where it drops and flattens (Maitland: 29 km² of floodplain counted as
   * normal water). Now each cell of the river's path below the gauge gets
   *   bed + normal depth + rise,
   * (with the bay level in place of bed + depth where that's higher), where
   * the bed is smoothed (the lower quarter over ~300 m, so a road embankment
   * without its culvert or a deep hole in the data doesn't set the level)
   * and held at the highest bed further downstream (water pools behind a
   * riffle, so the surface never rises downstream); the rise is how far the
   * gauge is set above its normal level (its river surface + 0.3 m), tapering
   * to nothing at the sea when the path reaches it (estuaries fall to the
   * bay level) and carried on unchanged to the model's edge inland. Never
   * below the bay level, never above the gauge. Level points the user (or
   * other gauges) set further down take over from the first one on.
   *
   * Dam models (started from a dam report): the gauge is in the lake. The lake
   * stays level out to the wall (the flow path from the gauge to where the
   * ground drops DAM_DROP_M below the lake's surface) and the river profile
   * starts below the wall, the rise being what spills: the gauge level above
   * the lake's normal level. */
  const DAM_DROP_M = 4, DAM_SEARCH_M = 5000, RIVER_DEPTH_M = 0.3, BED_SMOOTH_M = 150, BED_PCT = 0.25;
  let rbMemo = null;
  const isDamModel = (meta) => !!meta && /^storage:/.test(String(meta.reportId || ''));
  function riverBelow(a, gauge, meta) {
    if (!a || gauge == null || gauge < 0 || !a.rec || !a.chain) return null;
    const dam0 = isDamModel(meta);
    if (rbMemo && rbMemo.a === a && rbMemo.g === gauge && rbMemo.dam === dam0) return rbMemo.v;
    let dam = null, start = a.rec[gauge];
    if (dam0) {
      const lake = a.dem[gauge];
      let prev = gauge;
      for (let c = a.rec[gauge]; c >= 0 && Math.abs(a.chain[gauge] - a.chain[c]) <= DAM_SEARCH_M; c = a.rec[c]) {
        if (a.valid[c] && a.dem[c] < lake - DAM_DROP_M) { dam = { crest: prev, below: c, lake }; start = c; break; }
        prev = c;
      }
    }
    const path = [];
    let end = 'edge';
    for (let c = start; c >= 0 && path.length < 20000; c = a.rec[c]) {
      if (a.ocean && a.ocean[c]) { end = 'sea'; break; }
      if (a.valid[c]) path.push(c);
    }
    const n = path.length, R = Math.max(2, Math.round(BED_SMOOTH_M / a.cell));
    const bed = path.map((c) => a.dem[c]);
    const env = new Float64Array(n), taper = new Float64Array(n);
    for (let k = n - 1, hi = -Infinity; k >= 0; k--) {
      // the lower quarter of the bed around here, not the middle: a flow
      // path that cuts across a meander neck or a bank for a couple of
      // hundred metres doesn't hold the river above it up (Maitland: 2.7 m
      // of "normal" water for 12 km behind 1 m of floodplain)
      const w = bed.slice(Math.max(0, k - R), k + R + 1).sort((x, y) => x - y);
      hi = Math.max(hi, w[Math.floor((w.length - 1) * BED_PCT)]);
      // the hold comes from downstream's lower quarter; here, the water is
      // still at least normal depth over this stretch's own middle bed, so
      // a rough bed doesn't leave the channel dry
      env[k] = Math.max(hi, w[w.length >> 1]);
    }
    // to the sea: the same fall as before (by flow distance to the outlet,
    // which runs on across the sea to the model edge), so coastal rivers keep
    // their levels; inland the rise carries on to the edge
    const c0 = a.chain[gauge];
    for (let k = 0; k < n; k++) taper[k] = end === 'sea' && c0 > 0 ? Math.max(0, Math.min(1, a.chain[path[k]] / c0)) : 1;
    const v = { dam, path, end, env, taper };
    rbMemo = { a, g: gauge, dam: dam0, v };
    return v;
  }
  function withRiverBelow(a, s, meta) {
    if (s.wse || s.gauge == null || s.gauge < 0) return s;
    const pr = riverBelow(a, s.gauge, meta);
    if (!pr || (!pr.path.length && !pr.dam)) return s;
    // the normal surface: the bed + depth, or the bay where that's higher
    // (estuaries); the rise over it tapers to the bay at the sea, so a coastal
    // river keeps the old straight fall from the gauge to the bay level
    const normal = Math.max(s.bayLevel, (pr.dam ? pr.dam.lake : a.dem[s.gauge]) + RIVER_DEPTH_M);
    const rise = pr.dam ? Math.max(0, s.gaugeLevel - normal) : s.gaugeLevel - normal;
    const own = new Set((s.controls || []).map((c) => c.cell));
    const ctrl = pr.dam ? [{ cell: pr.dam.crest, level: s.gaugeLevel }] : [];
    for (let k = 0; k < pr.path.length; k++) {
      const c = pr.path[k];
      if (own.has(c)) break;   // a level point set further down takes over from here
      ctrl.push({ cell: c, level: Math.min(s.gaugeLevel, Math.max(s.bayLevel, pr.env[k] + RIVER_DEPTH_M) + rise * pr.taper[k]) });
    }
    return Object.assign({}, s, { controls: (s.controls || []).concat(ctrl) });
  }
  window.__floodDam = () => {
    const pr = state.a && riverBelow(state.a, state.gauge, state.areaMeta), d = pr && pr.dam;
    return d ? { lake: d.lake, crest: cellLatLng(d.crest), below: cellLatLng(d.below), belowGround: state.a.dem[d.below], pathCells: pr.path.length } : null;
  };

  function syncOutputs() {
    $('gaugeLevelOut').textContent = fmt(ctl.gaugeLevel.value, 2) + ' m';
    $('bayLevelOut').textContent = fmt(ctl.bayLevel.value, 2) + ' m';
    $('extraOut').textContent = '+' + fmt(ctl.extra.value, 2) + ' m';
    $('gradOut').textContent = fmt(ctl.grad.value, 2) + ' m/km';
    $('streamAreaOut').textContent = fmt(streamFromSlider(ctl.streamArea.value), 2) + ' km²';
    const L = parseFloat(ctl.gaugeLevel.value);
    document.querySelectorAll('#events .chip').forEach((b) => {
      b.setAttribute('aria-pressed', String(Math.abs(parseFloat(b.dataset.level) - L) < 0.001));
    });
  }

  function renderEvents() {
    const box = $('events');
    box.innerHTML = '';
    state.events.forEach((e) => {
      const b = document.createElement('button');
      b.type = 'button'; b.className = 'chip'; b.dataset.level = e.level;
      b.innerHTML = `<b>${e.label}</b><span>${e.level.toFixed(2)} m</span>`;
      b.addEventListener('click', () => { ctl.gaugeLevel.value = e.level; syncOutputs(); schedule(); });
      box.appendChild(b);
    });
    $('eventsSet').hidden = !state.eventsApply;
    $('eventsNote').textContent = state.areaId === 'sample'
      ? 'Real Brisbane City gauge peaks, applied to illustrative terrain.'
      : 'Brisbane City gauge peaks (Bureau of Meteorology).';
  }

  let pending = 0;
  function schedule() {
    if (modelUnavailable) return;   // the wasm gate card explains why
    syncOutputs();
    if (pending) return;
    pending = requestAnimationFrame(() => { pending = 0; runScenario(); });
  }
  Object.values(ctl).forEach((el) => el.addEventListener('input', () => {
    if (el === ctl.streamArea) return;
    schedule();
  }));
  ctl.streamArea.addEventListener('change', () => {
    state.streamAreaKm2 = streamFromSlider(ctl.streamArea.value);
    reanalyse(false);
  });
  ctl.streamArea.addEventListener('input', syncOutputs);
  const bwEl = $('backwater'); if (bwEl) bwEl.addEventListener('change', () => schedule());

  /* ------------------------------------------------------------- loading */

  /* ---------- problems log
   * Errors and failures are kept in this browser (localStorage, last 100) and
   * listed under About > Problems log, with a badge on About for new ones,
   * so they can be copied and reported. Nothing is sent anywhere. Share
   * links carry places in the address (#s=…), so the address is kept
   * without it. */
  const APP_BUILD = (import.meta.env && import.meta.env.VITE_BUILD) || 'dev';
  const APP_BUILT_AT = (import.meta.env && import.meta.env.VITE_BUILT_AT) || '';
  let brokerInfo = null;   // the broker's /health answer (see checkBroker)
  // The live data broker (broker/, rust/flood-broker), and where readings
  // come from: "build" (the site build's copy, refreshed every 3 hours) or
  // "runtime" (the broker, refreshed every 15 minutes, with the build's copy
  // as the fallback). Set at build time (DATA_SOURCE); ?data=build|runtime
  // overrides it for one visit.
  const BROKER = String((import.meta.env && import.meta.env.VITE_BROKER) || '').replace(/\/+$/, '');
  const DATA_SOURCE = (() => {
    let v = '';
    try { v = new URLSearchParams(location.search).get('data') || ''; } catch (e) { /* no query */ }
    v = (v || (import.meta.env && import.meta.env.VITE_DATA_SOURCE) || 'build').toLowerCase();
    return v === 'runtime' && BROKER ? 'runtime' : 'build';
  })();
  const PROBLEMS_KEY = 'floodExplorer.problems.v1', PROBLEMS_SEEN_KEY = 'floodExplorer.problemsSeen', PROBLEMS_MAX = 100;
  const problems = (() => { try { const v = JSON.parse(localStorage.getItem(PROBLEMS_KEY) || '[]'); return Array.isArray(v) ? v : []; } catch (e) { return []; } })();
  let problemsSeen = (() => { try { return localStorage.getItem(PROBLEMS_SEEN_KEY) || ''; } catch (e) { return ''; } })();
  let logging = false;
  const clip = (v, n) => String(v == null ? '' : v).replace(/#s=[A-Za-z0-9_-]+/g, '#s=…').slice(0, n);
  function logProblem(kind, message, detail) {
    if (logging) return;   // never recurse through console.error
    logging = true;
    try {
      const msg = clip(message, 500), last = problems[problems.length - 1];
      if (last && last.msg === msg && last.kind === kind && Date.now() - Date.parse(last.t) < 10000) last.n = (last.n || 1) + 1;
      else {
        const area = typeof state !== 'undefined' && state.areaMeta ? state.areaMeta.name || state.areaMeta.id : null;
        let zoom = null;
        try { zoom = typeof state !== 'undefined' && state.lmap && !document.getElementById('lmap').hidden ? Math.round(state.lmap.getZoom() * 10) / 10 : null; } catch (e) { /* map not ready */ }
        problems.push({ t: new Date().toISOString(), kind, msg, detail: clip(detail, 1500), build: APP_BUILD, page: location.pathname, area, zoom, view3d: document.body.classList.contains('in3d') });
        while (problems.length > PROBLEMS_MAX) problems.shift();
      }
      try { localStorage.setItem(PROBLEMS_KEY, JSON.stringify(problems)); } catch (e) { /* storage full or blocked: this visit only */ }
      renderProblems();
    } catch (e) { /* logging must never break the app */ } finally { logging = false; }
  }
  const errText = (e) => (e && (e.stack || e.message)) || String(e);
  window.addEventListener('error', (e) => logProblem('error', e.message || 'Script error', [errText(e.error), e.filename ? `${e.filename}:${e.lineno}:${e.colno}` : ''].filter(Boolean).join('\n')));
  window.addEventListener('unhandledrejection', (e) => logProblem('unhandled', (e.reason && e.reason.message) || String(e.reason), errText(e.reason)));
  {
    const orig = console.error.bind(console);
    console.error = (...args) => { orig(...args); logProblem('console', args.map((x) => (x instanceof Error ? x.message : typeof x === 'object' ? (() => { try { return JSON.stringify(x); } catch (e) { return String(x); } })() : String(x))).join(' '), args.find((x) => x instanceof Error) ? errText(args.find((x) => x instanceof Error)) : ''); };
  }
  function renderProblems() {
    const list = document.getElementById('problemsList');
    if (!list) return;
    const unseen = problems.filter((p) => p.t > problemsSeen).length;
    const badge = document.getElementById('problemsBadge');
    if (badge) { badge.hidden = !unseen; badge.textContent = unseen > 99 ? '99+' : String(unseen); }
    document.getElementById('problemsCount').textContent = problems.length ? `(${problems.length})` : '(none)';
    list.innerHTML = problems.length ? problems.slice().reverse().map((p) => `<li><span class="problem-when">${escapeHtml(p.t.slice(0, 19).replace('T', ' '))} · ${escapeHtml(p.kind)}${p.n > 1 ? ` · ×${p.n}` : ''}</span>
        <span class="problem-msg">${escapeHtml(p.msg)}</span>${p.detail ? `<details><summary>Details</summary><pre>${escapeHtml(p.detail)}</pre></details>` : ''}</li>`).join('') : '<li class="hint">No problems logged.</li>';
  }
  function problemsReport() {
    const ua = navigator.userAgent;
    const b = brokerInfo;
    const brk = !BROKER ? 'no broker' : b && b.version ? `broker ${String(b.version).slice(0, 8)}${b.readings && b.readings.fetched ? `, readings ${b.readings.fetched}` : ''}${b.readings && b.readings.loadedFrom ? ` (${b.readings.loadedFrom})` : ''}` : `broker ${b && b.error ? `unreachable: ${b.error}` : 'not checked'}`;
    const head = `Flood Explorer problems log: build ${APP_BUILD}${APP_BUILT_AT ? ` (${APP_BUILT_AT.slice(0, 16).replace('T', ' ')} UTC)` : ''}, ${brk}, readings from ${typeof nat !== 'undefined' && nat.readingsSource || DATA_SOURCE}, ${ua}, copied ${new Date().toISOString().slice(0, 19).replace('T', ' ')} UTC`;
    return [head, ...problems.map((p, k) => `${k + 1}. ${p.t.slice(0, 19).replace('T', ' ')} UTC · ${p.kind}${p.n > 1 ? ` ×${p.n}` : ''} · build ${p.build}${p.area ? ` · place: ${p.area}` : ''}${p.zoom != null ? ` · zoom ${p.zoom}` : ''}${p.view3d ? ' · 3D' : ''}
   ${p.msg}${p.detail ? `\n   ${p.detail.split('\n').slice(0, 8).join('\n   ')}` : ''}`)].join('\n');
  }
  window.__floodProblems = () => problems.slice();
  // opening the log marks what's in it as seen
  document.getElementById('problemsBox').addEventListener('toggle', (e) => {
    if (!e.target.open || !problems.length) return;
    problemsSeen = problems[problems.length - 1].t;
    try { localStorage.setItem(PROBLEMS_SEEN_KEY, problemsSeen); } catch (err) { /* this visit only */ }
    renderProblems();
  });
  document.getElementById('problemsCopy').addEventListener('click', async (e) => {
    const text = problemsReport(), btn = e.currentTarget;
    let ok;
    try { await navigator.clipboard.writeText(text); ok = true; } catch (err) {
      const ta = document.createElement('textarea');   // older browsers / no clipboard permission
      ta.value = text; ta.style.position = 'fixed'; ta.style.opacity = '0'; document.body.appendChild(ta); ta.select();
      try { ok = document.execCommand('copy'); } catch (err2) { ok = false; }
      ta.remove();
    }
    btn.textContent = ok ? 'Copied' : 'Copy failed: select the list instead';
    setTimeout(() => { btn.textContent = 'Copy for reporting'; }, 2500);
  });
  document.getElementById('problemsClear').addEventListener('click', () => {
    problems.length = 0;
    try { localStorage.removeItem(PROBLEMS_KEY); } catch (err) { /* nothing stored */ }
    renderProblems();
  });
  renderProblems();
  window.__floodProblemsReport = problemsReport;

  // Settings (API keys): desktop (Tauri) persists to ~/.flood-explorer/settings.ini
  // via Tauri commands. Web feed credentials are configured by the host.
  const isTauri = () => !!(window.__TAURI__ && (window.__TAURI__.core || window.__TAURI__));
  const tauriInvoke = async (cmd, args) => {
    const t = window.__TAURI__;
    const inv = (t && t.core && t.core.invoke) || (t && t.invoke);
    if (!inv) throw new Error('Tauri invoke not available');
    return inv(cmd, args || {});
  };
  const settingsModal = document.getElementById('settingsModal');
  const openSettings = async () => {
    if (!settingsModal) return;
    settingsModal.hidden = false;
    const status = document.getElementById('settingsStatus');
    if (status) status.textContent = '';
    try {
      let qld = '', nsw = '';
      if (isTauri()) {
        const s = await tauriInvoke('load_settings', {});
        qld = (s && s.QLD_TRAFFIC_API_KEY) || '';
        nsw = (s && s.NSW_TRAFFIC_API_KEY) || '';
      }
      const qi = document.getElementById('setQldKey'); if (qi) qi.value = qld;
      const ni = document.getElementById('setNswKey'); if (ni) ni.value = nsw;
    } catch (e) { if (status) status.textContent = `Could not load settings: ${e && e.message || e}`; }
  };
  const closeSettings = () => { if (settingsModal) settingsModal.hidden = true; };
  const settingsBtn = document.getElementById('settingsBtn');
  if (settingsBtn) {
    settingsBtn.hidden = !isTauri();
    settingsBtn.addEventListener('click', openSettings);
  }
  desktopUpdates({ invoke: tauriInvoke, desktop: isTauri(), document, onAvailable: openSettings });
  const settingsClose = document.getElementById('settingsClose');
  if (settingsClose) settingsClose.addEventListener('click', closeSettings);
  const settingsSave = document.getElementById('settingsSave');
  if (settingsSave) settingsSave.addEventListener('click', async () => {
    const status = document.getElementById('settingsStatus');
    const qld = (document.getElementById('setQldKey') || {}).value || '';
    const nsw = (document.getElementById('setNswKey') || {}).value || '';
    try {
      if (isTauri()) {
        await tauriInvoke('save_settings', { qldKey: qld.trim() || null, nswKey: nsw.trim() || null });
      }
      if (status) status.textContent = 'Saved. The broker re-reads keys on its next refresh.';
      setTimeout(closeSettings, 1200);
    } catch (e) { if (status) status.textContent = `Save failed: ${e && e.message || e}`; }
  });

  /* A button whose work takes a moment (fetching or calculating): while it
   * runs the button shows a spinner and what it's doing, can't be pressed
   * twice, and keeps its width; it comes back when the work ends. */
  async function withBusy(btn, label, fn) {
    if (!btn) return fn();
    if (btn.getAttribute('aria-busy') === 'true') return undefined;
    const html = btn.innerHTML, minW = btn.style.minWidth;
    btn.style.minWidth = `${btn.offsetWidth}px`;
    btn.setAttribute('aria-busy', 'true'); btn.disabled = true; btn.classList.add('is-busy');
    btn.innerHTML = `<span class="btn-spin" aria-hidden="true"></span>${escapeHtml(label)}`;
    try { return await fn(); } finally {
      btn.innerHTML = html; btn.disabled = false; btn.removeAttribute('aria-busy'); btn.classList.remove('is-busy'); btn.style.minWidth = minW;
    }
  }
  const busyClick = (btn, label, fn) => btn && btn.addEventListener('click', (e) => withBusy(e.currentTarget, label, fn));

  function setBusy(on, text) {
    $('busy').hidden = !on;
    if (text) $('busy').textContent = text;
  }

  // One-tap places to model: a point on the river near the town's flood
  // gauge, or on the shore for coasts. The model snaps to the main channel.
  // Well-known flood sites and populated flood-prone places, by state.
  const PRESETS = [
    { id: 'ipswich', name: 'Ipswich, Bremer River (Qld)', state: 'Qld', lat: -27.6135, lon: 152.7625, kind: 'river' },
    { id: 'logan', name: 'Logan River, Waterford (Qld)', state: 'Qld', lat: -27.6960, lon: 153.1440, kind: 'river' },
    { id: 'grantham', name: 'Grantham, Lockyer Creek (Qld)', state: 'Qld', lat: -27.5790, lon: 152.2010, kind: 'river' },
    { id: 'gympie', name: 'Gympie, Mary River (Qld)', state: 'Qld', lat: -26.1835, lon: 152.6620, kind: 'river' },
    { id: 'maryborough', name: 'Maryborough, Mary River (Qld)', state: 'Qld', lat: -25.5340, lon: 152.7050, kind: 'river' },
    { id: 'bundaberg', name: 'Bundaberg, Burnett River (Qld)', state: 'Qld', lat: -24.8650, lon: 152.3480, kind: 'river' },
    { id: 'rockhampton', name: 'Rockhampton, Fitzroy River (Qld)', state: 'Qld', lat: -23.3765, lon: 150.5125, kind: 'river' },
    { id: 'emerald', name: 'Emerald, Nogoa River (Qld)', state: 'Qld', lat: -23.5240, lon: 148.1550, kind: 'river' },
    { id: 'mackay', name: 'Mackay, Pioneer River (Qld)', state: 'Qld', lat: -21.1410, lon: 149.1820, kind: 'river' },
    { id: 'townsville', name: 'Townsville, Ross River (Qld)', state: 'Qld', lat: -19.2880, lon: 146.7900, kind: 'river' },
    { id: 'ingham', name: 'Ingham, Herbert River (Qld)', state: 'Qld', lat: -18.6400, lon: 146.1600, kind: 'river' },
    { id: 'charleville', name: 'Charleville, Warrego River (Qld)', state: 'Qld', lat: -26.4020, lon: 146.2350, kind: 'river' },
    { id: 'stgeorge', name: 'St George, Balonne River (Qld)', state: 'Qld', lat: -28.0370, lon: 148.5820, kind: 'river' },
    { id: 'goondiwindi', name: 'Goondiwindi, Macintyre River (Qld)', state: 'Qld', lat: -28.5400, lon: 150.3100, kind: 'river' },
    { id: 'lismore', name: 'Lismore, Wilsons River (NSW)', state: 'NSW', lat: -28.8090, lon: 153.2765, kind: 'river' },
    { id: 'murwillumbah', name: 'Murwillumbah, Tweed River (NSW)', state: 'NSW', lat: -28.3270, lon: 153.3960, kind: 'river' },
    { id: 'grafton', name: 'Grafton, Clarence River (NSW)', state: 'NSW', lat: -29.6915, lon: 152.9355, kind: 'river' },
    { id: 'kempsey', name: 'Kempsey, Macleay River (NSW)', state: 'NSW', lat: -31.0800, lon: 152.8380, kind: 'river' },
    { id: 'portmacquarie', name: 'Port Macquarie, Hastings River (NSW)', state: 'NSW', lat: -31.4300, lon: 152.9050, kind: 'river' },
    { id: 'taree', name: 'Taree, Manning River (NSW)', state: 'NSW', lat: -31.9030, lon: 152.4620, kind: 'river' },
    { id: 'maitland', name: 'Maitland, Hunter River (NSW)', state: 'NSW', lat: -32.7280, lon: 151.5560, kind: 'river' },
    { id: 'windsor', name: 'Windsor, Hawkesbury River (NSW)', state: 'NSW', lat: -33.6045, lon: 150.8225, kind: 'river' },
    { id: 'liverpool', name: 'Liverpool, Georges River (NSW)', state: 'NSW', lat: -33.9250, lon: 150.9320, kind: 'river' },
    { id: 'moree', name: 'Moree, Mehi River (NSW)', state: 'NSW', lat: -29.4710, lon: 149.8450, kind: 'river' },
    { id: 'dubbo', name: 'Dubbo, Macquarie River (NSW)', state: 'NSW', lat: -32.2470, lon: 148.6000, kind: 'river' },
    { id: 'forbes', name: 'Forbes, Lachlan River (NSW)', state: 'NSW', lat: -33.3850, lon: 148.0100, kind: 'river' },
    { id: 'wagga', name: 'Wagga Wagga, Murrumbidgee River (NSW)', state: 'NSW', lat: -35.1030, lon: 147.3680, kind: 'river' },
    { id: 'gundagai', name: 'Gundagai, Murrumbidgee River (NSW)', state: 'NSW', lat: -35.0650, lon: 148.1050, kind: 'river' },
    { id: 'maribyrnong', name: 'Maribyrnong River, Melbourne (Vic)', state: 'Vic', lat: -37.7760, lon: 144.8890, kind: 'river' },
    { id: 'echuca', name: 'Echuca, Murray River (Vic)', state: 'Vic', lat: -36.1240, lon: 144.7520, kind: 'river' },
    { id: 'rochester', name: 'Rochester, Campaspe River (Vic)', state: 'Vic', lat: -36.3630, lon: 144.7050, kind: 'river' },
    { id: 'shepparton', name: 'Shepparton, Goulburn River (Vic)', state: 'Vic', lat: -36.3720, lon: 145.4070, kind: 'river' },
    { id: 'seymour', name: 'Seymour, Goulburn River (Vic)', state: 'Vic', lat: -37.0270, lon: 145.1460, kind: 'river' },
    { id: 'benalla', name: 'Benalla, Broken River (Vic)', state: 'Vic', lat: -36.5510, lon: 145.9830, kind: 'river' },
    { id: 'kerang', name: 'Kerang, Loddon River (Vic)', state: 'Vic', lat: -35.7320, lon: 143.9200, kind: 'river' },
    { id: 'traralgon', name: 'Traralgon, Traralgon Creek (Vic)', state: 'Vic', lat: -38.1950, lon: 146.5360, kind: 'river' },
    { id: 'bairnsdale', name: 'Bairnsdale, Mitchell River (Vic)', state: 'Vic', lat: -37.8320, lon: 147.6200, kind: 'river' },
    { id: 'murraybridge', name: 'Murray Bridge, Murray River (SA)', state: 'SA', lat: -35.1180, lon: 139.2750, kind: 'river' },
    { id: 'gawler', name: 'Gawler, Gawler River (SA)', state: 'SA', lat: -34.6010, lon: 138.7360, kind: 'river' },
    { id: 'guildford', name: 'Guildford, Swan River, Perth (WA)', state: 'WA', lat: -31.9000, lon: 115.9700, kind: 'river' },
    { id: 'carnarvon', name: 'Carnarvon, Gascoyne River (WA)', state: 'WA', lat: -24.8800, lon: 113.6650, kind: 'river' },
    { id: 'fitzroycrossing', name: 'Fitzroy Crossing, Fitzroy River (WA)', state: 'WA', lat: -18.1960, lon: 125.5780, kind: 'river' },
    { id: 'launceston', name: 'Launceston, Tamar River (Tas)', state: 'Tas', lat: -41.4330, lon: 147.1430, kind: 'river' },
    { id: 'latrobe', name: 'Latrobe, Mersey River (Tas)', state: 'Tas', lat: -41.2370, lon: 146.4140, kind: 'river' },
    { id: 'huonville', name: 'Huonville, Huon River (Tas)', state: 'Tas', lat: -43.0300, lon: 147.0480, kind: 'river' },
    { id: 'katherine', name: 'Katherine, Katherine River (NT)', state: 'NT', lat: -14.4660, lon: 132.2635, kind: 'river' },
    { id: 'cairns', name: 'Cairns waterfront (Qld)', state: 'Qld', lat: -16.9200, lon: 145.7800, kind: 'coast' },
    { id: 'herveybay', name: 'Hervey Bay (Qld)', state: 'Qld', lat: -25.2880, lon: 152.8400, kind: 'coast' },
    { id: 'maroochydore', name: 'Maroochydore, Sunshine Coast (Qld)', state: 'Qld', lat: -26.6530, lon: 153.0920, kind: 'coast' },
    { id: 'goldcoast', name: 'Gold Coast Broadwater (Qld)', state: 'Qld', lat: -27.9650, lon: 153.4100, kind: 'coast' },
    { id: 'ballina', name: 'Ballina, Richmond River mouth (NSW)', state: 'NSW', lat: -28.8700, lon: 153.5650, kind: 'coast' },
    { id: 'newcastle', name: 'Newcastle harbour (NSW)', state: 'NSW', lat: -32.9250, lon: 151.7800, kind: 'coast' },
    { id: 'elwood', name: 'Elwood, Port Phillip (Vic)', state: 'Vic', lat: -37.8830, lon: 144.9810, kind: 'coast' },
    { id: 'lakesentrance', name: 'Lakes Entrance (Vic)', state: 'Vic', lat: -37.8810, lon: 147.9810, kind: 'coast' },
    { id: 'portadelaide', name: 'Port Adelaide (SA)', state: 'SA', lat: -34.8460, lon: 138.5050, kind: 'coast' },
    { id: 'mandurah', name: 'Mandurah (WA)', state: 'WA', lat: -32.5300, lon: 115.7230, kind: 'coast' },
    { id: 'hobart', name: 'Hobart, Derwent estuary (Tas)', state: 'Tas', lat: -42.8820, lon: 147.3330, kind: 'coast' },
    { id: 'darwin', name: 'Darwin harbour (NT)', state: 'NT', lat: -12.4630, lon: 130.8420, kind: 'coast' },
  ];
  window.__floodPresets = PRESETS;

  function addGroup(sel, label, id) {
    const g = document.createElement('optgroup');
    g.label = label;
    if (id) g.id = id;
    sel.appendChild(g);
    return g;
  }
  function addOption(parent, value, text) {
    const op = document.createElement('option');
    op.value = value; op.textContent = text;
    parent.appendChild(op);
    return op;
  }

  async function listAreas() {
    const sel = $('area');
    sel.innerHTML = '';
    addOption(sel, 'australia', 'Australia: tap a river, dam or coast');
    addGroup(sel, 'Your modelled places', 'modelledGroup').hidden = true;
    const detailed = addGroup(sel, 'Detailed models');
    try {
      const r = await fetch('data/areas.json', { cache: 'no-cache' });
      if (r.ok) (await r.json()).forEach((x) => addOption(detailed, x.id, x.name.replace(/ \(Copernicus.*\)$/, '')));
    } catch (e) { /* no processed areas published yet */ }
    const groups = [
      ['Rivers: Queensland', (p) => p.kind === 'river' && p.state === 'Qld'],
      ['Rivers: New South Wales', (p) => p.kind === 'river' && p.state === 'NSW'],
      ['Rivers: Victoria', (p) => p.kind === 'river' && p.state === 'Vic'],
      ['Rivers: SA, WA, Tasmania, NT', (p) => p.kind === 'river' && !['Qld', 'NSW', 'Vic'].includes(p.state)],
      ['Coasts and estuaries', (p) => p.kind === 'coast'],
    ];
    for (const [label, test] of groups) {
      const g = addGroup(sel, label);
      PRESETS.filter(test).forEach((p) => addOption(g, `preset:${p.id}`, p.name));
    }
    return [{ id: 'australia' }];
  }

  // The illustrative sample terrain is only an offline fallback (when the
  // map library cannot load); it is not offered in the menu.
  function useSampleOption() {
    const sel = $('area');
    if (!sel.querySelector('option[value="sample"]')) addOption(sel, 'sample', 'Offline sample terrain (illustrative)');
    sel.value = 'sample';
  }

  function addModelledOption(key, name) {
    const g = $('modelledGroup');
    g.hidden = false;
    const op = addOption(g, key, name);
    return op;
  }

  // The Bureau gauge a river preset should be modelled from: one within
  // 8 km whose name or basin mentions the preset's river, else the nearest
  // forecast or information gauge within 3 km.
  function presetGauge(p) {
    if (!nat.data) return null;
    const river = (p.name.split(',')[1] || '').replace(/\(.*\)/, '').trim().toLowerCase();
    const token = river.replace(/\b(river|creek|r)\b/g, '').trim().split(/\s+/)[0] || '';
    const rank = { forecast: 0, information: 1, river: 2 };
    let best = null;
    for (const f of nat.data.gauges) {
      const q = f.properties;
      if (q.kind === 'tide') continue;
      const km = kmBetween([f.geometry.coordinates[1], f.geometry.coordinates[0]], [p.lat, p.lon]);
      if (km > 8) continue;
      const text = `${q.name || ''} ${q.basin || ''}`.toLowerCase();
      const named = token.length > 2 && text.includes(token);
      if (!named && (km > 3 || q.kind === 'river')) continue;
      const score = (named ? 0 : 100) + (rank[q.kind] ?? 3) * 3 + km;
      if (!best || score < best.score) best = { f, km, score, named };
    }
    return best;
  }

  async function loadArea(id, opts) {
    if (areaReg.has(id)) { activateArea(id, { fit: true }); return; }
    if (id.startsWith('preset:')) {
      const p = PRESETS.find((x) => `preset:${x.id}` === id);
      if (!p) return;
      const done = Array.from(areaReg.values()).find((a) => a.areaMeta && a.areaMeta.presetId === p.id);
      if (done) { activateArea(done.key, { fit: true }); openPanel('panel-scenario'); return; }
      if (!state.lmap || $('lmap').hidden) await enterNational({ fit: false });
      if (!nat.data) await loadNationalData();
      const name = p.name.replace(/ \((NSW|Qld|Vic|Tas|SA|NT|WA)\)$/, '');
      // anchor river presets to the real Bureau gauge on that river, so the
      // model starts on the channel and gets the gauge's report and levels
      await ensureRiverGauges();
      const g = p.kind === 'river' ? presetGauge(p) : null;
      status.presetAnchor = { id: p.id, gauge: g ? g.f.properties.name : null, km: g ? Math.round(g.km * 10) / 10 : null };
      let rep = null;
      if (g) rep = openReport(g.f, { select: false });
      await modelHere(g ? g.f.geometry.coordinates[1] : p.lat, g ? g.f.geometry.coordinates[0] : p.lon, {
        kind: p.kind, name, presetId: p.id, reportId: rep ? rep.id : null, center: [p.lat, p.lon],
      });
      return;
    }
    if (id === 'australia') {
      setBusy(true, 'Loading the Australia-wide map…');
      try { await enterNational(); } finally { setBusy(false); }
      return;
    }
    setBusy(true, 'Loading terrain…');
    await nextFrame();
    try {
      if (id === 'sample') {
        const g = F.syntheticTerrain();
        state.areaMeta = { id: 'sample', name: 'Sample terrain', synthetic: true, streamAreaKm2: 4 };
        await useGrid(g, 'sample', { events: true });
      } else {
        const meta = await (await fetch(`data/${id}/meta.json`, { cache: 'no-cache' })).json();
        if (opts && opts.keepN != null) meta.keepN = opts.keepN;
        if (opts && Number.isFinite(opts.streamAreaKm2) && opts.streamAreaKm2 > 0) meta.streamAreaKm2 = opts.streamAreaKm2;
        const [demBuf, d8Buf] = await Promise.all([
          fetch(`data/${id}/${meta.files.dem}`).then(okBuf),
          fetch(`data/${id}/${meta.files.d8}`).then(okBuf),
        ]);
        const dem = new Float32Array(demBuf);
        const d8 = new Uint8Array(d8Buf);
        const N = meta.W * meta.H;
        if (dem.length !== N || d8.length !== N) throw new Error('Area files do not match their metadata.');
        const valid = new Uint8Array(N);
        for (let i = 0; i < N; i++) valid[i] = Number.isFinite(dem[i]) && dem[i] !== meta.nodata && d8[i] !== 255 ? 1 : 0;
        state.areaMeta = meta;
        await useGrid({ W: meta.W, H: meta.H, cell: meta.cell, dem, valid, d8 }, id, { events: !!meta.brisbaneGauge });
      }
    } catch (err) {
      showError(`Could not load that terrain: ${err.message}`);
      if (id !== 'sample') { useSampleOption(); return loadArea('sample'); }
    } finally {
      setBusy(false);
    }
  }

  function okBuf(r) {
    if (!r.ok) throw new Error(`${r.url.split('/').pop()} returned ${r.status}`);
    return r.arrayBuffer();
  }

  const nextFrame = () => new Promise((r) => requestAnimationFrame(() => setTimeout(r, 0)));

  // The flow analysis is the slow step (seconds on big areas): run it in a
  // background worker, falling back to the page if workers are unavailable.
  let worker = null, workerGen = 0, workerSeq = 0;
  const workerJobs = new Map();
  function getWorker() {
    if (worker === false) return null;
    if (!worker) {
      try {
        workerGen++;           // resident-analysis keys belong to one worker instance
        worker = new Worker(new URL('./flood-worker.js', import.meta.url), { type: 'module' });
        worker.onmessage = (e) => {
          if (e.data && e.data.workerStatus) {
            // the worker reports whether its own wasm copy loaded; if not,
            // stop using it (the main thread runs the same model) rather
            // than leaving jobs waiting for replies that never come
            status.worker = e.data.workerStatus;
            if (e.data.workerStatus === 'error') { worker = false; logProblem('worker', `Model worker unavailable: ${e.data.error || 'unknown error'} (using the main thread)`); say(`Model worker unavailable (${e.data.error || 'unknown error'}) — using the main thread.`); }
            return;
          }
          const job = workerJobs.get(e.data.id);
          if (!job) return;
          workerJobs.delete(e.data.id);
          if (e.data.a && e.data.key != null) {   // worker-resident analysis: later timeline/calibrate runs reuse it
            e.data.a.analysisKey = e.data.key;
            e.data.a.keyGen = workerGen;
          }
          if (e.data.error) job.reject(new Error(e.data.error)); else job.resolve(e.data.a);
        };
        worker.onerror = (e) => {
          if (e && e.preventDefault) e.preventDefault();
          worker = false;           // e.g. opened from a file: do the work here
          workerJobs.forEach((job) => (job.fallback ? job.fallback() : job.reject(new Error('The model worker failed to start.'))));
          workerJobs.clear();
        };
      } catch (err) { worker = false; return null; }    }
    return worker;
  }
  function analyseAsync(grid, opts) {
    if (modelUnavailable) return Promise.reject(new Error('The flood model (WebAssembly) is unavailable in this browser.'));
    const onMainThread = () => {
      if (F.engine !== 'rust') return Promise.reject(new Error('The flood model (WebAssembly) is unavailable in this browser.'));
      return nextFrame().then(() => F.analyse(grid, opts));
    };
    const w = getWorker();
    if (!w) return onMainThread();
    return new Promise((resolve, reject) => {
      const id = ++workerSeq;
      let settled = false;
      const done = (fn, arg) => { if (!settled) { settled = true; clearTimeout(watchdog); workerJobs.delete(id); fn(arg); } };
      // a worker whose wasm never loads (or a lost reply) must not hang the
      // app: fall back to the main thread, surfacing the wait only after a
      // generous time (analyses of the biggest grids take tens of seconds)
      const watchdog = setTimeout(() => {
        if (settled) return;
        settled = true;
        workerJobs.delete(id);
        say('The model worker is slow to answer — running the model on the main thread instead.');
        onMainThread().then(resolve, reject);
      }, 120000);
      workerJobs.set(id, { resolve: (a) => done((x) => resolve(x), a), reject: (e) => done((x) => reject(x), e), fallback: onMainThread });
      w.postMessage({ id, grid, opts });
    });
  }

  async function useGrid(grid, id, opts) {
    resetInertial();
    // keep the area we're leaving on the map as it is
    const meta = state.areaMeta;
    const prev = state.areaKey && areaReg.get(state.areaKey);
    if (prev) { state.areaMeta = prev.areaMeta; saveActive(); state.areaMeta = meta; }
    state.areaKey = null;
    state.base = null; state.run = null;
    state.controls = [];
    state.leveeMask = null; state.gateCells = [];
    state.grid = grid;
    state.areaId = id;
    status.area = id;
    state.eventsApply = !!opts.events;
    const areaKm2 = (grid.W * grid.H * grid.cell * grid.cell) / 1e6;
    state.streamAreaKm2 = (state.areaMeta && state.areaMeta.streamAreaKm2)
      || Math.min(4, Math.max(0.05, areaKm2 * 0.01));
    ctl.streamArea.value = sliderFromStream(state.streamAreaKm2);
    renderEvents();
    await reanalyse(true);
    // default levels
    ctl.gaugeLevel.min = 0;
    $('levelHint').hidden = true;
    if (state.eventsApply) ctl.gaugeLevel.value = 4.46;
    else if (state.gauge >= 0) {
      const surface = state.a.dem[state.gauge], v = Math.round((surface + 3) * 20) / 20;
      // range first: a range input clamps its value to the current max, and
      // inland gauges (tens of metres up) were clamped below the river bed
      ctl.gaugeLevel.max = Math.max(10, Math.ceil(v + 8));
      ctl.gaugeLevel.min = Math.max(0, Math.floor(surface - 2));
      ctl.gaugeLevel.value = v;
      $('levelHint').hidden = false;
      $('levelHint').textContent = `Heights are metres above sea level. The river surface at the gauge is about ${surface.toFixed(1)} m in the elevation model; the default is 3 m above that.`;
    }
    ctl.gaugeLevel.max = Math.max(10, Math.ceil(parseFloat(ctl.gaugeLevel.value) + 8));
    showScenarioEmpty(false);
    syncOutputs();
    renderInfo();
    const bl = state.areaMeta && state.areaMeta.bounds_lonlat;
    if (bl) {
      const m = state.areaMeta;
      const key = m.areaKey || (m.areaKey = m.local ? `local-${++localCount}` : m.id);
      state.geo = { west: bl[0], south: bl[1], east: bl[2], north: bl[3] };
      state.pendingGeo = true;
      const token = ++geoToken;
      enterGeoMode(bl).then((ok) => {
        if (token !== geoToken) return;   // switched to another area meanwhile
        state.pendingGeo = false;
        if (!ok) { state.geo = null; drawMap(); return; }
        const area = ensureArea(key);
        state.areaKey = key;
        setActiveLayers(area);
        renderAreaList();
        drawMap();
      });
    } else {
      leaveGeoMode();
    }
    runScenario();
  }

  async function reanalyse(resetGauge) {
    resetInertial();
    const g = state.grid;
    const a = await analyseAsync(g, { streamAreaKm2: state.streamAreaKm2 });
    if (state.grid !== g) return;   // another area was opened meanwhile
    state.a = a;
    let gauge = a.defaultGauge;
    if (!resetGauge && state.gauge >= 0) {
      const x = state.gauge % a.W, y = Math.floor(state.gauge / a.W);
      const s = F.snapToStream(a, x, y, 12);
      if (s >= 0) gauge = s;
    } else if (resetGauge && state.areaMeta && state.areaMeta.gauge) {
      const { col, row } = state.areaMeta.gauge;
      // biggest channel within ~1 km, then the nearest cell at least 30% of it
      let big = 0;
      for (let dy = -33; dy <= 33; dy++) for (let dx = -33; dx <= 33; dx++) {
        const x = col + dx, y = row + dy;
        if (x < 0 || y < 0 || x >= a.W || y >= a.H) continue;
        const i = y * a.W + x;
        if (a.stream[i] && a.acc[i] > big) big = a.acc[i];
      }
      const s = F.snapToStream(a, col, row, 33, big * 0.3);
      if (s >= 0) gauge = s;
      status.snap = { big, acc: s >= 0 ? a.acc[s] : null };
    }
    state.gauge = gauge;
    state.base = null;
    state.terrain = terrainRGBA(a);
    // keep the registry entry in step: the 3D view reads entries directly
    // (areasFor3d), and saveActive frees them again when the area is left
    const ar = state.areaKey && areaReg.get(state.areaKey);
    if (ar) { ar.a = state.a; ar.terrain = state.terrain; }
    if (!resetGauge) runScenario();
  }

  /* ------------------------------------------------------------- uploads */

  $('files').addEventListener('change', async (ev) => {
    const files = Array.from(ev.target.files || []);
    if (!files.length) return;
    setBusy(true, 'Reading files…');
    await nextFrame();
    try {
      const grid = await readUserFiles(files);
      state.areaMeta = { id: 'upload', name: grid.name, upload: true, routedBy: grid.d8 ? 'pointers' : 'browser' };
      let op = $('area').querySelector('option[value="upload"]');
      if (!op) { op = document.createElement('option'); op.value = 'upload'; $('area').appendChild(op); }
      op.textContent = 'Your file: ' + grid.name;
      $('area').value = 'upload';
      await useGrid(grid, 'upload', { events: false });
    } catch (err) {
      showError(err.message);
    } finally {
      setBusy(false);
      ev.target.value = '';
    }
  });

  async function readUserFiles(files) {
    const isPtr = (f) => /(d8|pntr|pointer)/i.test(f.name);
    const demFile = files.find((f) => !isPtr(f)) || files[0];
    const ptrFile = files.find((f) => f !== demFile && isPtr(f));
    let grid = await readRaster(demFile);
    if (ptrFile) {
      const p = await readRaster(ptrFile, { raw: true });
      if (p.W !== grid.W || p.H !== grid.H) throw new Error(`${ptrFile.name} is ${p.W}×${p.H} cells but ${demFile.name} is ${grid.W}×${grid.H}. Use outputs from the same run.`);
      if (grid.W * grid.H > 2.5e6) throw new Error('That DEM is too large to use with its flow directions here. Re-run the pipeline at a coarser cell size.');
      const d8 = new Int16Array(grid.W * grid.H);
      for (let i = 0; i < d8.length; i++) {
        d8[i] = Math.round(p.dem[i]);
        if (!p.valid[i]) grid.valid[i] = 0;
      }
      grid.d8 = d8;
    } else {
      grid = F.downsample(grid, 700);
    }
    grid.name = demFile.name;
    return grid;
  }

  async function readRaster(file, opts) {
    const name = file.name.toLowerCase();
    if (name.endsWith('.asc') || name.endsWith('.txt')) {
      const g = F.parseAsciiGrid(await file.text());
      return F.cleanNodata(g);
    }
    if (!(name.endsWith('.tif') || name.endsWith('.tiff'))) throw new Error(`${file.name}: use a GeoTIFF (.tif) or an ASCII grid (.asc).`);
    await loadGeoTiffLib();
    const tiff = await window.GeoTIFF.fromArrayBuffer(await file.arrayBuffer());
    const img = await tiff.getImage();
    const W = img.getWidth(), H = img.getHeight();
    if (W * H > 40e6) throw new Error(`${file.name} has ${(W * H / 1e6).toFixed(0)} million cells. Clip or resample it below 40 million first.`);
    const ras = await img.readRasters({ samples: [0] });
    const data = ras[0];
    const nd = img.getGDALNoData();
    const [rx] = img.getResolution();
    let cell = Math.abs(rx);
    const geographic = (img.geoKeys && img.geoKeys.GTModelTypeGeoKey === 2) || cell < 0.01;
    if (geographic) {
      const bb = img.getBoundingBox();
      const lat = (bb[1] + bb[3]) / 2;
      cell = cell * 111320 * Math.cos((lat * Math.PI) / 180);
    }
    const dem = new Float32Array(W * H);
    const valid = new Uint8Array(W * H);
    for (let i = 0; i < W * H; i++) {
      const v = data[i];
      dem[i] = v;
      valid[i] = Number.isFinite(v) && v !== nd ? 1 : 0;
    }
    const g = { W, H, cell, dem, valid };
    return opts && opts.raw ? g : F.cleanNodata(g, nd);
  }

  let geotiffPromise = null;
  function loadGeoTiffLib() {
    if (window.GeoTIFF) return Promise.resolve();
    if (!geotiffPromise) {
      geotiffPromise = import('geotiff').then((lib) => { window.GeoTIFF = lib; }).catch((err) => {
        geotiffPromise = null;
        throw new Error('Could not load the GeoTIFF reader. Check your connection, or use an ASCII grid (.asc).', { cause: err });
      });
    }
    return geotiffPromise;
  }

  /* -------------------------------------------------------------- model */

  // Each 2D run owns its worker/WASM memory. Termination also cancels startup.
  let inertialWorker = null, inertialSequence = 0;
  const fastSets = ['floodTypeSet', 'riverSet', 'stormSet', 'eventsSet', 'defenceSet', 'timeSet', 'levelPointsSet'];
  function solverControls() {
    const selected = $('solver').value === 'inertial';
    $('inertialControls').hidden = !selected;
    for (const id of fastSets) $(id).disabled = selected;
    $('colorMode').querySelector('option[value="hazard"]').disabled = false;
    $('dlReport').disabled = !!state.inertial;
  }
  function stopInertial() {
    inertialSequence++;
    if (inertialWorker) inertialWorker.terminate();
    inertialWorker = null;
    $('inertialRun').disabled = false; $('inertialCancel').disabled = true;
  }
  function resetInertial() {
    stopInertial();
    state.inertial = null; status.inertial = null;
    $('solver').value = 'fast'; solverControls();
    $('inertialStatus').textContent = 'Fast terrain model.';
  }
  function startInertial() {
    if (!state.a) { $('inertialStatus').textContent = 'Load a terrain model first.'; return; }
    if (!F.inertialStart) { $('inertialStatus').textContent = 'The 2D model needs WebAssembly. It is unavailable in JavaScript-only mode.'; return; }
    const inputs = [...$('inertialControls').querySelectorAll('input')];
    if (inputs.some((input) => !input.reportValidity() || (input.type === 'number' && input.value.trim() === ''))) return;
    runScenario(); // discard a previous dynamic result and restore the fast preview
    $('solver').value = 'inertial'; solverControls();
    const seq = inertialSequence, a = state.a, key = state.areaKey;
    const number = (id) => Number($(id).value);
    try {
      const g = window.FloodInertialGrid.prepare(a, number('inertialResolution'));
      const stages = new Float64Array(g.W * g.H).fill(NaN);
      if ($('inertialBoundary').value === 'sea') {
        if (!g.ocean.some(Boolean)) throw new Error('No mapped sea cells at this resolution; choose closed edges or another area.');
        for (let i = 0; i < stages.length; i++) if (g.ocean[i]) stages[i] = number('inertialStage');
      }
      const opts = { seconds: number('inertialMinutes') * 60, rainMmH: number('inertialRain'),
        inflow: number('inertialInflow'), inflowCell: window.FloodInertialGrid.cell(g, a, state.gauge),
        initialDepth: number('inertialInitial'), roughness: number('inertialRoughness'), stages,
        inflowSeries: buildInflowSeries(number('inertialMinutes') * 60),
        rainSeries: buildRainSeries(number('inertialMinutes') * 60) };
      const w = new Worker(new URL('./inertial-worker.js', import.meta.url), { type: 'module' });
      inertialWorker = w;
      $('inertialRun').disabled = true; $('inertialCancel').disabled = false;
      $('inertialProgress').value = 0;
      $('inertialStatus').textContent = `Running 2D on ${g.W} × ${g.H} cells (${Math.round(g.cell)} m). Map still shows the fast preview.`;
      status.inertial = { running: true, cell: g.cell };
      const fail = (message) => {
        if (seq !== inertialSequence) return;
        stopInertial(); status.inertial = { error: message };
        $('inertialStatus').textContent = `2D stopped: ${message}. Map shows the fast model.`;
      };
      w.onerror = (e) => { e.preventDefault(); fail(e.message || 'Worker failed'); };
      w.onmessage = ({ data }) => {
        if (seq !== inertialSequence || a !== state.a || key !== state.areaKey) return;
        if (data.error) { fail(data.error); return; }
        if (data.progress != null) { $('inertialProgress').value = data.progress; return; }
        const r = data.result;
        if (!r) return;
        stopInertial();
        const { depth: _depth, ...metrics } = r;
        const { stages: _stages, ...settings } = opts;
        state.inertial = { ...metrics, cell: g.cell, W: g.W, H: g.H, settings, boundary: $('inertialBoundary').value };
        status.inertial = { ...state.inertial, running: false };
        state.run = window.FloodInertialGrid.expand(a, g, r);
        state.base = null; state.riverRun = null; state.flash = null; state.timeView = false;
        clearTimeout(impactT);
        $('colorMode').value = 'depth'; solverControls();
        $('inertialProgress').value = 1;
        const rainOnly = !settings.inflow && !settings.inflowSeries && settings.rainMmH > 0 && $('inertialBoundary').value !== 'sea';
        $('inertialStatus').textContent = `Local-inertial 2D: final depth at ${fmt(r.time / 60, 1)} min, ${Math.round(g.cell)} m cells. Stored ${fmt(r.volume, 1)} m³; added ${fmt(r.sourceVolume, 1)} m³; boundary exchange ${fmt(r.boundaryVolume, 1)} m³; balance error ${r.balanceError.toExponential(2)} m³. Partial edge blocks and blocks with missing terrain are excluded.` + (rainOnly
          ? ' Rain-only run with sealed edges: the rain (a few mm to cm) stays on every cell, so most of the map shows as under 0.5 m — set a gauge inflow or open the sea boundary for channel flooding.'
          : '');
        state.edges = floodEdges(a, state.run);
        const arInertial = state.areaKey && areaReg.get(state.areaKey);
        if (arInertial) arInertial.run = state.run;   // the 3D tiles follow too
        drawMap(); drawStats(scenario()); renderEdgeNote(); drawProfile(scenario());
        maybeRenderImpact(); renderRecorded();
        $('timeSet').hidden = true;
      };
      w.postMessage({ grid: { W: g.W, H: g.H, cell: g.cell, dem: g.dem, valid: g.valid }, opts });
    } catch (e) { stopInertial(); $('inertialStatus').textContent = `2D stopped: ${e.message}. Map shows the fast model.`; }
  }
  $('solver').addEventListener('change', () => {
    if ($('solver').value === 'fast') runScenario();
    else { solverControls(); $('inertialStatus').textContent = 'Configure inputs and run 2D. Map currently shows the fast model.'; }
  });
  $('inertialRun').addEventListener('click', startInertial);
  $('inertialCancel').addEventListener('click', () => { runScenario(); $('inertialStatus').textContent = '2D cancelled. Fast terrain model restored.'; });
  $('inertialControls').addEventListener('input', (e) => {
    if (e.target.tagName === 'PROGRESS') return;
    if (inertialWorker || state.inertial) {
      runScenario(); $('solver').value = 'inertial'; solverControls();
      $('inertialStatus').textContent = 'Inputs changed. Run 2D again; map shows the fast preview.';
    }
  });

  let impactT = 0, timelineSeq = 0;
  function runScenario() {
    if (typeof resetInertial === 'function') resetInertial();
    timelineSeq++; // discard timelines still computing for the previous scenario
    const a = state.a;
    if (!a) return;
    // a changed scenario makes the flood-over-time result stale
    const tArea = state.areaKey && areaReg.get(state.areaKey);
    if (tArea && tArea.timeline) { tArea.timeline = null; if (state.timePlay) { clearInterval(state.timePlay); state.timePlay = 0; } renderTimeline(); }
    state.timeView = false;
    const s = scenario();
    if (state.base && (state.baseMode === 'flash') !== (ctl.floodType.value === 'flash')) state.base = null;
    state.baseMode = ctl.floodType.value;
    if (!state.base && state.baseMode === 'flash') state.base = F.flashFlood(a, { rainMm: 0, slim: 1 });
    // the river profile needs the waterline (wse); other paths don't
    const wantWse = !$('panel-profile').hidden;
    if (!state.base || (wantWse && !state.base.wse)) {
      const base = state.eventsApply || state.gauge < 0
        ? BASELINE
        : { gaugeLevel: a.dem[state.gauge] + 0.3, bayLevel: 0 };
      state.base = F.inundate(a, withRiverBelow(a, Object.assign({}, s, base, { upstreamGradient: s.upstreamGradient }), state.areaMeta), { slim: !wantWse });
    }
    ensureSatWater(a, state.geo);
    if (state.baseMode !== 'flash') markLowGround(a, state.base);
    const mode = ctl.floodType.value;
    state.riverRun = mode === 'flash' ? null : dryLowGround(F.inundate(a, withRiverBelow(a, s, state.areaMeta), { slim: !wantWse }), state.base);
    if (mode === 'river') { state.run = state.riverRun; state.flash = null; } else {
      const fl = F.flashFlood(a, Object.assign(storm(), { slim: 1 }));
      state.flash = fl.summary;
      state.run = mode === 'both' ? F.mergeRuns(state.riverRun, fl) : fl;
    }
    renderStorm();
    state.edges = floodEdges(a, state.run);
    const ar = state.areaKey && areaReg.get(state.areaKey);
    if (ar) ar.run = state.run;   // the 3D tiles' water follows the scenario
    drawMap();
    drawStats(s);
    renderEdgeNote();
    renderLevelPoints();
    drawProfile(s);
    renderNotice();
    saveSessionSoon();
    clearTimeout(impactT);
    impactT = setTimeout(() => { maybeRenderImpact(); renderRecorded(); }, 250);
  }

  // Which sides of the model window the flood runs into (ignoring the sea
  // and the river channel itself, which always cross the edge).
  function floodEdges(a, run) {
    const { W, H } = a, hit = { north: 0, south: 0, west: 0, east: 0 };
    const land = (c) => run.wet[c] && !(a.ocean && a.ocean[c]) && !(a.stream && a.stream[c]);
    for (let x = 0; x < W; x++) { if (land(x)) hit.north++; if (land((H - 1) * W + x)) hit.south++; }
    for (let y = 0; y < H; y++) { if (land(y * W)) hit.west++; if (land(y * W + W - 1)) hit.east++; }
    const sides = Object.keys(hit).filter((k) => hit[k] >= 4);
    status.edges = sides;
    return sides;
  }

  // On the map, mark the sides of the model box the flood runs into: a thick
  // dashed orange line there (the rest of the box is drawn faint) and one
  // label saying the picture stops at that line.
  function updateEdgeCue(sides) {
    const L = window.L, area = state.areaKey && areaReg.get(state.areaKey);
    if (!L || !area || !area.edgeGroup) return;
    area.edgeGroup.clearLayers();
    if (!sides.length) return;
    const b = area.overlay.getBounds(), N = b.getNorth(), S = b.getSouth(), E = b.getEast(), W = b.getWest();
    const line = { north: [[N, W], [N, E]], south: [[S, W], [S, E]], west: [[N, W], [S, W]], east: [[N, E], [S, E]] };
    for (const k of sides) L.polyline(line[k], { color: AREA_COLOR, weight: 3.5, dashArray: '9 6', interactive: false }).addTo(area.edgeGroup);
    const k = sides[0], mid = [(line[k][0][0] + line[k][1][0]) / 2, (line[k][0][1] + line[k][1][1]) / 2];
    L.marker(mid, { interactive: false, keyboard: false, icon: L.divIcon({ className: 'edge-cue', html: `<span>Model edge: flood may continue</span>`, iconSize: [0, 0] }) }).addTo(area.edgeGroup);
  }

  const MODEL_SIZES = [[10, 30], [20, 30], [40, 60]];   // half-width km, cell m
  function renderEdgeNote() {
    const box = $('edgeNote');
    if (!box) return;
    const m = state.areaMeta || {}, sides = state.edges || [];
    const level = MODEL_SIZES.findIndex(([h]) => h === (m.halfKm || 10));
    const canGrow = m.local && level >= 0 && level < MODEL_SIZES.length - 1;
    box.hidden = scenarioEmpty || !m.local || !sides.length;
    updateEdgeCue(box.hidden ? [] : sides);
    if (box.hidden) return;
    const km = 2 * (m.halfKm || 10);
    const list = sides.length > 1 ? `${sides.slice(0, -1).join(', ')} and ${sides[sides.length - 1]}` : sides[0];
    box.innerHTML = `<p><strong>The flood reaches the ${list} edge${sides.length > 1 ? 's' : ''}</strong> of this ${km} km model, so it may go further than shown.</p>`
      + (canGrow ? `<button type="button" class="btn small" id="extendModel">Extend model area to ${2 * MODEL_SIZES[level + 1][0]} km</button>`
        : '<p class="hint">This is the largest model area. Model another place further along the river to see beyond it.</p>');
    const b = $('extendModel');
    busyClick(b, 'Extending the model…', () => extendModel());
  }

  // Rebuild the active on-demand model over a larger window, shifted toward
  // the edges the flood reaches; it keeps its number and scenario settings.
  async function extendModel() {
    const area = state.areaKey && areaReg.get(state.areaKey);
    const m = state.areaMeta || {};
    if (!area || !m.local || !m.gaugeLatLon) return false;
    const level = MODEL_SIZES.findIndex(([h]) => h === (m.halfKm || 10));
    if (level < 0 || level >= MODEL_SIZES.length - 1) return false;
    const [half, cell] = MODEL_SIZES[level + 1], grow = half - (m.halfKm || 10);
    const sides = state.edges || [];
    const [glat, glon] = m.gaugeLatLon, [clat, clon] = m.centerLatLon || m.gaugeLatLon;
    const dy = (sides.includes('north') ? 1 : 0) - (sides.includes('south') ? 1 : 0);
    const dx = (sides.includes('east') ? 1 : 0) - (sides.includes('west') ? 1 : 0);
    const center = [clat + (dy * grow * 1000) / 110574, clon + (dx * grow * 1000) / (111320 * Math.cos((clat * Math.PI) / 180))];
    const saved = {};
    CTL_KEYS.forEach((k) => { saved[k] = ctl[k].value; });
    const keep = { n: area.n, key: area.key, name: area.name };
    const points = modelPoints(state.grid, state.geo, state.gauge, state.controls);
    const streamAreaKm2 = state.streamAreaKm2;
    const oldDefences = area.defences;
    const ok = await modelHere(glat, glon, {
      kind: m.kind, name: area.name, reportId: m.reportId, presetId: m.presetId, pinN: m.pinN,
      halfKm: half, cellM: cell, center, keepN: area.n, streamAreaKm2, replaceKey: keep.key,
    });
    if (!ok) return false;
    CTL_KEYS.forEach((k) => { if (k !== 'streamArea') ctl[k].value = saved[k]; });
    for (let t = 0; t < 80 && !(state.areaKey && areaReg.get(state.areaKey)?.n === keep.n); t++) await new Promise((r) => setTimeout(r, 100));
    if (areaReg.get(state.areaKey)?.n !== keep.n) return false;
    if (oldDefences && (oldDefences.levees.length || oldDefences.gates.length)) {
      const na = state.areaKey && areaReg.get(state.areaKey);
      if (na) { na.defences = oldDefences; await applyDefences(); }
    }
    restoreModelPoints(points);
    state.base = null;
    syncOutputs();
    runScenario();
    say(`Extended ${keep.name} to ${2 * half} km across.`);
    return true;
  }
  window.__floodExtendModel = extendModel;

  /* ------------------------------------------------------------ drawing */

  const DEPTH_STOPS = [
    [0.5, [63, 154, 224]], [1, [43, 127, 208]], [2, [31, 103, 187]], [4, [23, 80, 156]], [Infinity, [12, 52, 112]],
  ];   // same colours as BANDS3D in terrain3d.js (the old palest band read as white paint over imagery)
  // opacity per band over imagery: shallow water stays slightly see-through
  const DEPTH_ALPHA = [178, 230, 230, 230, 230];
  const depthBand = (dep) => { for (let k = 0; k < DEPTH_STOPS.length; k++) if (dep < DEPTH_STOPS[k][0]) return k; return DEPTH_STOPS.length - 1; };
  const WATER = [109, 147, 173];
  // normal (river or lake) water over imagery: its own teal, clearly visible
  // but not a flood blue (WATER above stays the relief view's water colour)
  // What is normally water. The normal-level run wets everything below the
  // river's normal surface that connects to it, which on a terrain model
  // includes ground that levees, drains or terrain errors keep dry, and its
  // drainage lines run under streets. Digital Earth Australia's record of
  // how often satellites have seen water at each spot (Landsat, 1987 on)
  // says which is which: ground below the normal level that is almost never
  // seen wet is "low ground", dry until the water rises above its normal
  // level there; drainage lines never seen wet aren't tinted as water.
  const SAT_LOW = 0.05;      // seen wet in under 5% of clear looks: not normally water
  const SAT_CHANNEL = 0.02;  // a channel seen wet at least this often is drawn as water
  async function fetchSatFreq(a, g) {
    const W = Math.min(a.W, 1000), H = Math.round(W * a.H / a.W);
    const url = `${DEA_WCS}?service=WCS&version=1.0.0&request=GetCoverage&coverage=ga_ls_wo_fq_myear_3&measurements=frequency`
      + `&crs=EPSG:4326&bbox=${g.west},${g.south},${g.east},${g.north}&width=${W}&height=${H}&format=GeoTIFF`;
    const r = await fetch(url);
    if (!r.ok) throw new Error(`the satellite service returned ${r.status}`);
    const buf = await r.arrayBuffer();
    let freq, fw, fh;
    try { const t = F.parseSimpleTiff(buf); freq = t.data; fw = t.W; fh = t.H; } catch (err) {
      await loadGeoTiffLib();
      const img = await (await window.GeoTIFF.fromArrayBuffer(buf)).getImage();
      fw = img.getWidth(); fh = img.getHeight(); freq = (await img.readRasters({ samples: [0] }))[0];
    }
    // per model cell: the most water any satellite pixel in it saw (-1: no record)
    const best = new Float32Array(a.N).fill(-1);
    for (let y = 0; y < fh; y++) {
      const ym = Math.min(a.H - 1, Math.floor(((y + 0.5) / fh) * a.H));
      for (let x = 0; x < fw; x++) {
        const v = freq[y * fw + x], i = ym * a.W + Math.min(a.W - 1, Math.floor(((x + 0.5) / fw) * a.W));
        if (Number.isFinite(v) && v >= 0 && v <= 1 && v > best[i]) best[i] = v;
      }
    }
    return { best, size: [fw, fh] };
  }
  // Start fetching the satellite record for this area (once); when it
  // arrives, the normal water is worked out again.
  function ensureSatWater(a, g) {
    if (!a || !g || a.sat !== undefined) return;
    a.sat = null;
    fetchSatFreq(a, g).then((r) => {
      a.sat = r.best;
      status.normalWater = Object.assign({}, status.normalWater, { satellite: 'loaded' });
      if (state.a === a && state.base) { state.base = null; runScenario(); }
    }, (err) => {
      a.sat = false;   // keep the terrain-only normal water
      status.normalWater = { satellite: 'unavailable', error: String(err && err.message || err) };
    });
  }
  // Mark low ground on a fresh normal-level run: below the normal surface
  // but almost never seen wet. It leaves the normal water (base.wet) and is
  // kept with its normal depth, so later runs leave it dry until deeper.
  function markLowGround(a, base) {
    if (!a.sat || base.lowMarked) return;
    const idx = [], dep = [];
    const lowMask = new Uint8Array(a.N);
    for (let i = 0; i < a.N; i++) {
      if (!base.wet[i] || a.ocean[i]) continue;
      const f = a.sat[i];
      if (f < 0 || f >= SAT_LOW) continue;
      idx.push(i); dep.push(base.depth[i]); lowMask[i] = 1;
      base.wet[i] = 0;
    }
    base.lowMarked = true;
    base.low = { idx: Int32Array.from(idx), depth: Float32Array.from(dep), mask: lowMask };
    const km2 = (n) => +(n * a.cell * a.cell / 1e6).toFixed(2);
    status.normalWater = Object.assign({}, status.normalWater, { lowGroundKm2: km2(idx.length) });
  }
  // A river run: low ground stays dry until the water there is deeper than
  // at the normal level, and then its depth is counted from the normal
  // water surface: ground that is never wet can't really lie below the water
  // it connects to, so a terrain hole there isn't read as metres of flood.
  function dryLowGround(run, base) {
    const low = base && base.low;
    if (!run || !low) return run;
    for (let k = 0; k < low.idx.length; k++) {
      const i = low.idx[k];
      if (!run.wet[i]) continue;
      const above = run.depth[i] - low.depth[k];
      if (above <= 0.05) { run.wet[i] = 0; run.depth[i] = 0; if (run.level) run.level[i] = NaN; } else run.depth[i] = above;
    }
    return run;
  }

  const NORMAL_WATER = [38, 166, 154];
  const CHANNEL_ALPHA = 180;  // ~70 %
  const HYPSO = [
    [0, [226, 230, 214]], [0.12, [208, 218, 186]], [0.35, [186, 186, 146]], [0.65, [160, 142, 112]], [1, [128, 112, 100]],
  ];

  function lerpStops(stops, t) {
    for (let i = 1; i < stops.length; i++) {
      if (t <= stops[i][0]) {
        const [t0, c0] = stops[i - 1], [t1, c1] = stops[i];
        const f = (t - t0) / (t1 - t0);
        return [c0[0] + (c1[0] - c0[0]) * f, c0[1] + (c1[1] - c0[1]) * f, c0[2] + (c1[2] - c0[2]) * f];
      }
    }
    return stops[stops.length - 1][1];
  }

  function terrainRGBA(a) {
    const { W, H, dem, valid, cell } = a;
    const ocean = a.ocean || null;   // stream tiles have no ocean mask
    const land = [];
    for (let i = 0; i < a.N; i += 7) if (valid[i] && !(ocean && ocean[i])) land.push(dem[i]);
    land.sort((x, y) => x - y);
    const lo = land.length ? land[Math.floor(land.length * 0.02)] : 0;
    const hi = land.length ? land[Math.floor(land.length * 0.98)] : 1;
    const out = new Uint8ClampedArray(a.N * 4);
    const az = (315 * Math.PI) / 180, alt = (45 * Math.PI) / 180;
    const z = (x, y) => {
      x = Math.max(0, Math.min(W - 1, x)); y = Math.max(0, Math.min(H - 1, y));
      const i = y * W + x;
      return valid[i] ? dem[i] : NaN;
    };
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
      const i = y * W + x, o = i * 4;
      if (!valid[i]) { out[o + 3] = 0; continue; }
      const c = dem[i];
      if (c < -1) {   // sea: flat water colour, no hillshade (also what the
        out[o] = 0xc9; out[o + 1] = 0xe7; out[o + 2] = 0xf7;   // 2D relief
        out[o + 3] = 255;                                     // paints over)
        continue;
      }
      const zz = (xx, yy) => { const v = z(xx, yy); return Number.isNaN(v) ? c : v; };
      const gx = (zz(x + 1, y) - zz(x - 1, y)) / (2 * cell);
      const gy = (zz(x, y + 1) - zz(x, y - 1)) / (2 * cell);
      const slope = Math.atan(Math.hypot(gx, gy) * 1.6);
      const aspect = Math.atan2(gy, -gx);
      let hs = Math.cos(alt) * Math.cos(slope) + Math.sin(alt) * Math.sin(slope) * Math.cos(az - aspect - Math.PI / 2);
      hs = Math.max(0, Math.min(1, hs));
      const t = Math.max(0, Math.min(1, (c - lo) / (hi - lo || 1)));
      const col = lerpStops(HYPSO, t);
      const k = 0.55 + 0.5 * hs;
      out[o] = col[0] * k; out[o + 1] = col[1] * k; out[o + 2] = col[2] * k; out[o + 3] = 255;
    }
    return out;
  }

  // Pixels for the current scenario. withTerrain: shaded relief underneath
  // (static map); otherwise transparent except water (overlay on a basemap).
  function composeImage(withTerrain) {
    const a = state.a, run = state.run, base = state.base;
    const img = withTerrain
      ? new ImageData(new Uint8ClampedArray(state.terrain), a.W, a.H)
      : new ImageData(a.W, a.H);
    const d = img.data;
    const mode = colorMode(), hz = mode === 'hazard' ? hazardNow() : null, cmp = mode === 'compare' ? compareNow() : null;
    for (let i = 0; i < a.N; i++) {
      if (!a.valid[i]) continue;
      const o = i * 4;
      let col = null, alpha = 0.88;
      if (withTerrain && (a.ocean[i] || (base && base.wet[i] && run.wet[i] && !isFlood(i)))) col = WATER;
      if (cmp) {
        const k = cmp.diff[i];
        if (k === 2) col = COMPARE_COLORS.onlyNow;
        else if (k === 3) col = COMPARE_COLORS.onlyPinned;
        else if (k === 1 && isFlood(i)) col = COMPARE_COLORS.both;
      } else if (run.wet[i] && isFlood(i)) {
        if (hz && hz.cls[i]) col = HAZARD_COLORS[hz.cls[i] - 1];
        else {
          col = DEPTH_STOPS[depthBand(run.depth[i])][1];
        }
      }
      if (withTerrain && !col && a.stream[i] && a.acc[i] * (a.cell * a.cell) / 1e6 > state.streamAreaKm2 * 3) { col = WATER; alpha = 0.9; }
      if (!col) continue;
      if (withTerrain) {
        d[o] = d[o] * (1 - alpha) + col[0] * alpha;
        d[o + 1] = d[o + 1] * (1 - alpha) + col[1] * alpha;
        d[o + 2] = d[o + 2] * (1 - alpha) + col[2] * alpha;
      } else {
        d[o] = col[0]; d[o + 1] = col[1]; d[o + 2] = col[2]; d[o + 3] = 255;
      }
    }
    return img;
  }

  // Water raster for the map overlay (Leaflet imageOverlay): flooded cells
  // in depth/hazard/compare colours, plus — with terrain shading on — the
  // water that belongs to the picture (ocean, still base water, stream
  // lines) as semi-transparent pixels over the opaque relief overlay.
  // The relief overlay is pre-blended exactly as the previously fused
  // raster was: (0.88·water) over opaque terrain.
  let waterImg = null;
  // a wet cell with no wet neighbour among the 8 around it (display only;
  // the statistics still count it)
  function loneCell(wet, i, W, H) {
    const x = i % W, y = (i - x) / W;
    for (let dy = -1; dy <= 1; dy++) {
      const yy = y + dy;
      if (yy < 0 || yy >= H) continue;
      for (let dx = -1; dx <= 1; dx++) {
        const xx = x + dx;
        if ((dx || dy) && xx >= 0 && xx < W && wet[yy * W + xx]) return false;
      }
    }
    return true;
  }
  function composeWater() {
    const a = state.a, run = state.run, base = state.base;
    const relief = $('showRelief').checked;
    // --- WASM path (Rust colour mapping) with JS fallback ---
    const F = window.FloodCore;
    if (F && typeof F.composeWater === 'function') {
      try {
        const area = state.areaKey && areaReg.get(state.areaKey);
        const W = a.W, H = a.H, N = a.N;
        const modeStr = colorMode();
        const modeCode = modeStr === 'hazard' ? 1 : (modeStr === 'compare' ? 2 : 0);
        const hz = modeStr === 'hazard' ? hazardNow() : null;
        const cmp = modeStr === 'compare' ? compareNow() : null;
        const valid = a.valid instanceof Uint8Array ? a.valid : new Uint8Array(a.valid || []);
        const ocean = a.ocean instanceof Uint8Array ? a.ocean : new Uint8Array(a.ocean || []);
        const stream = a.stream instanceof Uint8Array ? a.stream : new Uint8Array(a.stream || []);
        const acc = a.acc instanceof Float32Array ? a.acc : new Float32Array(a.acc || []);
        const satRaw = a.sat || [];
        const sat = satRaw instanceof Float32Array ? satRaw : new Float32Array(satRaw.length ? satRaw : 0);
        const baseWet = (base && base.wet) ? (base.wet instanceof Uint8Array ? base.wet : new Uint8Array(base.wet)) : new Uint8Array(0);
        const runWet = run.wet instanceof Uint8Array ? run.wet : new Uint8Array(run.wet || []);
        const runDepth = run.depth instanceof Float32Array ? run.depth : new Float32Array(run.depth || []);
        const hzCls = (hz && hz.cls) ? (hz.cls instanceof Uint8Array ? hz.cls : new Uint8Array(hz.cls)) : new Uint8Array(0);
        const cmpArr = (cmp && cmp.diff) ? cmp.diff.map((v) => (v == null ? 0 : v)) : [];
        const cmpDiff = new Int32Array(cmpArr);
        // per-cell polygon mask
        let mask = null;
        if (area && area.polygon) {
          mask = new Uint8Array(N);
          for (let i = 0; i < N; i++) {
            const ll = cellLatLng(i);
            mask[i] = pointInPolygon(ll[0], ll[1], area.polygon) ? 1 : 0;
          }
        }
        const r = F.composeWater({
          w: W, h: H, relief: relief ? 1 : 0, mode: modeCode,
          floodA: relief ? 224 : 255, streamA: relief ? 230 : 0,
          cellKm2: (a.cell * a.cell) / 1e6, streamThr: state.streamAreaKm2 * 3,
          valid, ocean, stream, acc, sat, baseWet, runWet, runDepth, hzCls, cmpDiff, mask,
        });
        if (r && r.rgba && r.rgba.length === W * H * 4) {
          if (!waterImg || waterImg.width !== W || waterImg.height !== H) waterImg = new ImageData(W, H);
          waterImg.data.set(r.rgba);
          return { img: waterImg, count: r.count || 0 };
        }
      } catch (e) { /* fall through to JS */ }
    }
    if (!waterImg || waterImg.width !== a.W || waterImg.height !== a.H) waterImg = new ImageData(a.W, a.H);
    const d = waterImg.data;
    d.fill(0);
    const mode = colorMode(), hz = mode === 'hazard' ? hazardNow() : null, cmp = mode === 'compare' ? compareNow() : null;
    const floodA = relief ? 224 : 255;   // 0.88 blends over the relief base; full elsewhere
    const streamA = relief ? 230 : 0;    // stream lines only with terrain shading
    const cellKm2 = (a.cell * a.cell) / 1e6, streamThr = state.streamAreaKm2 * 3;
    let n = 0;
    for (let i = 0; i < a.N; i++) {
      if (!a.valid[i]) continue;
      const area = state.areaKey && areaReg.get(state.areaKey);
      if (area && area.polygon) {
        const ll = cellLatLng(i);
        if (!pointInPolygon(ll[0], ll[1], area.polygon)) continue;
      }
      let col = null, band = -1;
      if (relief && (a.ocean[i] || (base && base.wet[i] && run.wet[i] && !isFlood(i)))) col = WATER;
      if (cmp) {
        const k = cmp.diff[i];
        if (k === 2) col = COMPARE_COLORS.onlyNow;
        else if (k === 3) col = COMPARE_COLORS.onlyPinned;
        else if (k === 1 && isFlood(i)) col = COMPARE_COLORS.both;
      } else if (run.wet[i] && isFlood(i)) {
        if (hz && hz.cls[i]) col = HAZARD_COLORS[hz.cls[i] - 1];
        else if (!loneCell(run.wet, i, a.W, a.H)) {   // lone wet cells are speckle, not flood
          band = depthBand(run.depth[i]);
          col = DEPTH_STOPS[band][1];
        }
      }
      const o = i * 4;
      if (col) {
        d[o] = col[0]; d[o + 1] = col[1]; d[o + 2] = col[2];
        d[o + 3] = band === 0 && !(hz && hz.cls[i]) && !cmp ? Math.min(floodA, DEPTH_ALPHA[0]) : floodA;
        n++; continue;
      }
      const channel = a.stream[i] && a.acc[i] * cellKm2 > streamThr;
      if (streamA && channel) {
        d[o] = WATER[0]; d[o + 1] = WATER[1]; d[o + 2] = WATER[2]; d[o + 3] = streamA;
      } else if (!relief && !a.ocean[i] && ((channel && !(a.sat && a.sat[i] >= 0 && a.sat[i] < SAT_CHANNEL)) || (base && base.wet[i]))) {
        // river channel and normal-level water over imagery: a light neutral
        // tint (the imagery shows the real water), not a flood colour
        d[o] = NORMAL_WATER[0]; d[o + 1] = NORMAL_WATER[1]; d[o + 2] = NORMAL_WATER[2]; d[o + 3] = CHANNEL_ALPHA;
      }
    }
    return { img: waterImg, count: n };
  }

  /* ---- 5 m flood edges from LiDAR (display only) ----
   * Zoomed in (z15+) on a model with LiDAR, the flood in view is redrawn at
   * 5 m: the model's water level (ground + depth of the flooded cells
   * around each spot, distance-weighted) against GA's 5 m bare-earth LiDAR,
   * so edges follow banks, kerbs and house pads instead of 30 m squares.
   * Water only reaches spots next to a flooded model cell, and where there
   * is no LiDAR the model's own cells show as before. The coarse layer is
   * cut out (clip-path) under the 5 m patch. Statistics are unchanged. */
  const FINE_Z = 15, FINE_M = 5, FINE_MAX_PX = 1800, FINE_SNAP = 0.004;   // snap boxes to ~400 m so pans reuse fetches
  let fine = null, fineTimer = null, fineGen = 0;
  const fineCache = new Map();   // box key -> Promise<raster | null>
  function scheduleFine() { if (state.timePlay) clearFine(); clearTimeout(fineTimer); fineTimer = setTimeout(() => { updateFine().catch((err) => { status.fine = { error: String(err) }; clearFine(); }); }, 300); }
  function clearFine() {
    if (!fine) return;
    if (fine.ov) fine.ov.remove();
    if (fine.coarse && fine.coarse.getElement()) fine.coarse.getElement().style.clipPath = '';
    fine = null;
  }
  function fineLidar(box, W, H) {
    const key = `${box.map((v) => v.toFixed(5)).join(',')}:${W}x${H}`;
    if (!fineCache.has(key)) {
      // a failed fetch isn't kept, so a dropped request can be tried again
      fineCache.set(key, fetchLidarBox(box, W, H).catch(() => { fineCache.delete(key); return null; }));
      // a few recent views are enough for panning back (each can be ~7 MB);
      // older ones come back from the offline cache, not the network
      while (fineCache.size > 4) fineCache.delete(fineCache.keys().next().value);
    }
    return fineCache.get(key);
  }
  async function updateFine() {
    const m = state.lmap, a = state.a, run = state.run, g = state.geo, coarse = state.overlay;
    const meta = state.areaMeta;
    const mode = colorMode(), hz = mode === 'hazard' ? hazardNow() : null;
    // not while the timeline plays (each step would redraw it, a step
    // behind); not for a hidden or removed place
    const on = m && a && run && g && coarse && m.hasLayer(coarse) && !state.timePlay && useLidar() && m.getZoom() >= FINE_Z
      && (mode === 'depth' || (mode === 'hazard' && hz && hz.vel)) && !$('showRelief').checked && meta && meta.lidarShare > 0;
    if (!on) { clearFine(); status.fine = null; return; }
    const vb = m.getBounds().pad(0.15);
    const snapDn = (v) => Math.floor(v / FINE_SNAP) * FINE_SNAP, snapUp = (v) => Math.ceil(v / FINE_SNAP) * FINE_SNAP;
    const box = [Math.max(g.west, snapDn(vb.getWest())), Math.max(g.south, snapDn(vb.getSouth())), Math.min(g.east, snapUp(vb.getEast())), Math.min(g.north, snapUp(vb.getNorth()))];
    if (box[0] >= box[2] || box[1] >= box[3]) { clearFine(); return; }
    const midLat = (box[1] + box[3]) / 2;
    const W = Math.round(((box[2] - box[0]) * 111320 * Math.cos((midLat * Math.PI) / 180)) / FINE_M), H = Math.round(((box[3] - box[1]) * 110574) / FINE_M);
    if (W < 2 || H < 2 || W > FINE_MAX_PX || H > FINE_MAX_PX) { clearFine(); return; }
    const gen = ++fineGen, areaKey = state.areaKey, t0 = performance.now();
    const superseded = () => gen !== fineGen || areaKey !== state.areaKey || run !== state.run || mode !== colorMode() || state.timePlay;
    const r = await fineLidar(box, W, H);
    const tFetched = performance.now();
    if (superseded()) return;
    if (!r || r.iw !== W || r.ih !== H) { clearFine(); status.fine = { lidar: false }; return; }
    // only the model cells around the view go to the worker
    const base = state.base, win = fineWindow(box, g, a.W, a.H), crop = (arr, k) => cropGrid(arr, a.W, win, k);
    const p = {
      W, H, box, g: { west: g.west, east: g.east, north: g.north, south: g.south }, aW: a.W, aH: a.H, ...win,
      dem: crop(a.dem), valid: crop(a.valid), ocean: crop(a.ocean), wet: crop(run.wet), depth: crop(run.depth), level: run.level ? crop(run.level) : null,
      baseWet: base && base.wet ? crop(base.wet) : null, baseDepth: base && base.wet && base.depth ? crop(base.depth) : null,
      hzCls: hz ? crop(hz.cls) : null, hzVel: hz ? crop(hz.vel) : null,
      coarse: crop(composeWater().img.data, 4),   // the model's own picture: shown where there's no LiDAR
      lidar: r.data, nd: r.nd,
      depthStops: DEPTH_STOPS, depthAlpha0: DEPTH_ALPHA[0], water: NORMAL_WATER, channelAlpha: CHANNEL_ALPHA, hazardColors: HAZARD_COLORS, hazardLimits: HAZARD_LIMITS,
    };
    const tPrepped = performance.now();
    const res = await fineCompute(p);
    const tComputed = performance.now();
    if (superseded()) return;
    if (res.have < 0.02 * W * H) { clearFine(); status.fine = { lidar: false }; return; }
    const bounds = window.L.latLngBounds([box[1], box[0]], [box[3], box[2]]);
    if (fine && fine.coarse !== coarse) clearFine();
    if (!fine) fine = { coarse, ov: fineCanvasOverlay(bounds, { opacity: parseFloat($('floodOpacity').value) / 100, interactive: false, className: 'flood-layer flood-fine', zIndex: 6 }).addTo(m) };
    else fine.ov.setBounds(bounds);
    fine.ov.setPixels(res.rgba, W, H);
    const tDrawn = performance.now();
    // cut the coarse layer out under the 5 m patch (percentages of its box, in map projection)
    const gw = g.east - g.west;
    const merc = (lat) => Math.log(Math.tan(Math.PI / 4 + (lat * Math.PI) / 360));
    const yN = merc(g.north), yS = merc(g.south), pct = (v) => `${(v * 100).toFixed(4)}%`;
    const x0 = pct((box[0] - g.west) / gw), x1 = pct((box[2] - g.west) / gw);
    const y0 = pct((yN - merc(box[3])) / (yN - yS)), y1 = pct((yN - merc(box[1])) / (yN - yS));
    const el = coarse.getElement();
    if (el) el.style.clipPath = `polygon(evenodd, 0 0, 100% 0, 100% 100%, 0 100%, 0 0, ${x0} ${y0}, ${x1} ${y0}, ${x1} ${y1}, ${x0} ${y1}, ${x0} ${y0})`;
    // fetch: LiDAR; prep: main-thread slicing; compute: the worker (or here
    // if workers are unavailable); draw: onto the canvas
    status.fine = { W, H, lidar: +(res.have / (W * H)).toFixed(2), ms: Math.round(performance.now() - t0), worker: !!res.worker,
      fetchMs: Math.round(tFetched - t0), prepMs: Math.round(tPrepped - tFetched), computeMs: Math.round(tComputed - tPrepped), drawMs: Math.round(tDrawn - tComputed) };
  }
  // The 5 m picture is worked out in a worker; without one (or if it
  // fails), here.
  let fineWorker = null, fineWorkerOk = true, fineReq = 0;
  const fineWaiting = new Map();
  function fineCompute(p) {
    if (fineWorkerOk && typeof Worker !== 'undefined') {
      try {
        if (!fineWorker) {
          fineWorker = new Worker(new URL('./fine-worker.js', import.meta.url), { type: 'module' });
          fineWorker.onmessage = (e) => {
            const w = fineWaiting.get(e.data.id);
            if (!w) return;
            fineWaiting.delete(e.data.id);
            if (e.data.error) w.reject(new Error(e.data.error)); else w.resolve({ rgba: e.data.rgba, have: e.data.have, worker: true });
          };
          fineWorker.onerror = (ev) => {
            logProblem('worker', `5 m flood worker failed: ${(ev && ev.message) || 'unknown error'} (drawing on the main thread instead)`);
            fineWorkerOk = false; fineWorker = null;
            for (const w of fineWaiting.values()) w.reject(new Error('worker failed'));
            fineWaiting.clear();
          };
        }
        const id = ++fineReq;
        return new Promise((resolve, reject) => { fineWaiting.set(id, { resolve, reject }); fineWorker.postMessage({ id, p }); })
          .catch(() => fineRaster(p));
      } catch (err) { fineWorkerOk = false; }
    }
    return Promise.resolve(fineRaster(p));
  }

  // What the flood colours show: depth, hazard class, or the change from a
  // pinned scenario. Hazard colours run light to dark (viridis), the
  // comparison uses orange and purple, so both read without colour vision.
  const HAZARD_COLORS = [[253, 231, 37], [122, 209, 81], [34, 168, 132], [42, 120, 142], [65, 68, 135], [68, 1, 84]];
  const HAZARD_TEXT = ['generally safe', 'unsafe for small vehicles', 'unsafe for vehicles, children and the elderly', 'unsafe for vehicles and people', 'unsafe for people and vehicles; buildings need special design', 'unsafe for all; all buildings vulnerable'];
  const COMPARE_COLORS = { onlyNow: [230, 97, 1], onlyPinned: [94, 60, 153], both: [158, 202, 225] };
  const colorMode = () => { const v = $('colorMode') ? $('colorMode').value : 'depth'; return v === 'compare' && !(state.pinned && state.pinned.key === state.areaKey) ? 'depth' : v; };
  // AIDR 7-3 hazard limits [depth m, speed m/s, depth×speed]: the same as
  // flood-core's hazard_class (surface.rs HAZARD_LIMITS); the 5 m layer
  // classifies with them (fine-raster.js)
  const HAZARD_LIMITS = [[0.3, 2.0, 0.3], [0.5, 2.0, 0.6], [1.2, 2.0, 0.6], [2.0, 2.0, 1.0], [4.0, 4.0, 4.0]];
  function hazardNow() {
    if (!state.a || !state.run) return null;
    const vx = state.run.vx, vy = state.run.vy;
    if (!state.hazard || state.hazard.run !== state.run) state.hazard = Object.assign(F.hazard(state.a, state.run, vx, vy), { run: state.run });
    return state.hazard;
  }
  function compareNow() {
    const p = state.pinned;
    if (!p || p.key !== state.areaKey || !state.run) return null;
    if (!state.compare || state.compare.run !== state.run) state.compare = Object.assign(F.compareRuns(state.a, state.run, p.run), { run: state.run });
    return state.compare;
  }
  // The key card follows what is on the map: the Australia-wide view (no
  // flood model) explains the gauge and dam dots; a model shows the flood
  // colours. It collapses to a one-line chip.
  function syncKey() {
    const open = $('legendToggle').getAttribute('aria-expanded') === 'true', card = $('legendCard');
    card.classList.toggle('collapsed', !open);
    card.querySelector('.show-mode').hidden = scenarioEmpty;
    $('depthLegend').hidden = scenarioEmpty || !open || colorMode() !== 'depth';
    $('dotLegend').hidden = !scenarioEmpty || !open;
  }
  function renderModeLegend() {
    const box = $('modeLegend');
    if (!box) return;
    const mode = colorMode();
    const opt = $('colorMode') && $('colorMode').querySelector('option[value="compare"]');
    if (opt) opt.disabled = !(state.pinned && state.pinned.key === state.areaKey);
    syncKey();
    const sw = (c) => `<i style="background:rgb(${c.join(',')})"></i>`;
    if (mode === 'hazard') {
      const h = hazardNow();
      box.innerHTML = HAZARD_COLORS.map((c, k) => `<span title="${HAZARD_TEXT[k]}">${sw(c)}H${k + 1}${h ? ` ${fmt(h.km2[k], 1)}` : ''}</span>`).join('')
        + '<span class="hint">km² · depth × estimated speed (AIDR 7-3)</span>';
      status.hazard = h ? h.km2.map((v) => +v.toFixed(2)) : null;
    } else if (mode === 'compare') {
      const c = compareNow();
      box.innerHTML = `<span>${sw(COMPARE_COLORS.onlyNow)}only now${c ? ` ${fmt(c.km2.onlyNow, 1)} km²` : ''}</span><span>${sw(COMPARE_COLORS.onlyPinned)}only pinned${c ? ` ${fmt(c.km2.onlyPinned, 1)} km²` : ''}</span><span>${sw(COMPARE_COLORS.both)}both</span>`;
    } else box.innerHTML = '';
    box.hidden = mode === 'depth' || scenarioEmpty || $('legendToggle').getAttribute('aria-expanded') !== 'true';
  }

  // Pin the current scenario to compare later ones against it
  function scenarioLabel() {
    if (state.inertial) return `Local-inertial 2D, ${fmt(state.inertial.time / 60, 1)} min, ${Math.round(state.inertial.cell)} m grid`;
    const mode = ctl.floodType.value, parts = [];
    if (mode !== 'flash') parts.push(`gauge ${fmt(parseFloat(ctl.gaugeLevel.value), 2)} m`);
    if (mode !== 'river') parts.push(`${ctl.rainMm.value} mm in ${ctl.stormHours.selectedOptions[0].textContent}`);
    const area = state.areaKey && areaReg.get(state.areaKey), d = area && area.defences;
    if (d && d.levees.some((l) => l.failed || (l.breaches && l.breaches.length))) parts.push('levees failing');
    if (parseFloat(ctl.warming.value) > 0 && mode !== 'river') parts.push(`${ctl.warming.value} °C warmer`);
    return parts.join(', ');
  }
  function pinScenario() {
    if (!state.run || !state.areaKey) return null;
    state.pinned = {
      key: state.areaKey, label: scenarioLabel(),
      run: { wet: Uint8Array.from(state.run.wet), depth: Float32Array.from(state.run.depth) },
      impact: status.impact && !status.impact.loading && !status.impact.error ? Object.assign({}, status.impact) : null,
    };
    state.compare = null;
    $('clearPinned').hidden = false;
    $('colorMode').querySelector('option[value="compare"]').disabled = false;
    $('colorMode').value = 'compare';
    drawMap(); renderCompare();
    return state.pinned.label;
  }
  function clearPinned() {
    state.pinned = null; state.compare = null;
    $('clearPinned').hidden = true;
    if ($('colorMode').value === 'compare') $('colorMode').value = 'depth';
    drawMap(); renderCompare();
  }
  function renderCompare() {
    const box = $('compareBox');
    if (!box) return;
    const p = state.pinned;
    if (!p || p.key !== state.areaKey) {
      box.innerHTML = '<p class="hint">Pin a scenario, then change the level, storm, levees or anything else: the map can show what floods only now (orange), what no longer floods (purple), and the impact counts show the difference.</p>';
      $('clearPinned').hidden = !p;
      status.compare = null;
      return;
    }
    const c = compareNow();
    if (!c) return;
    const n = (v) => Math.round(v).toLocaleString('en-AU');
    const sign = (v) => (v > 0 ? `+${n(v)}` : v < 0 ? `−${n(-v)}` : '0');
    const im = status.impact && !status.impact.loading && !status.impact.error ? status.impact : null, pi = p.impact;
    const rows = im && pi ? [['Buildings flooded', im.bWet, pi.bWet], ['Water over floor', im.overFloor, pi.overFloor], ['People affected', im.people, pi.people], ['Cut off', im.isolated, pi.isolated], ['Roads cut (km)', im.cutKm, pi.cutKm]]
      .filter(([, a, b]) => a != null && b != null) : [];
    box.innerHTML = `<p><strong>Pinned:</strong> ${escapeHtml(p.label)}. <strong>Now:</strong> ${escapeHtml(scenarioLabel())}.</p>
      <p>${fmt(c.km2.onlyNow, 2)} km² floods only now, ${fmt(c.km2.onlyPinned, 2)} km² only in the pinned scenario; where both flood, ${fmt(c.deeperKm2, 2)} km² is deeper now and ${fmt(c.shallowerKm2, 2)} km² shallower.</p>`
      + (rows.length ? `<table class="cmp"><tr><th></th><th>Pinned</th><th>Now</th><th>Change</th></tr>${rows.map(([k, a, b]) => `<tr><td>${k}</td><td>${n(b)}</td><td>${n(a)}</td><td>${sign(a - b)}</td></tr>`).join('')}</table>`
        : '<p class="hint">Count what\'s affected (before and after pinning) to compare buildings, people and roads too.</p>');
    status.compare = { onlyNow: +c.km2.onlyNow.toFixed(3), onlyPinned: +c.km2.onlyPinned.toFixed(3), rows: rows.length };
  }
  $('pinScenario').addEventListener('click', () => pinScenario());
  $('clearPinned').addEventListener('click', () => clearPinned());
  $('colorMode').addEventListener('change', () => { drawMap(); status.colorMode = colorMode(); });

  /* ---------- experimental 3D view (docs/3d-view-design.md) ---------- */
  let view3d = null;
  async function open3d() {
    const mod = await import('./scene3d.js');
    if (view3d) return;
    // Terrain streams on demand as web-mercator tiles (v4); modelled places
    // contribute water surfaces.
    view3d = mod.openScene3d({
      getStep: () => state.timeStep || 0,
      // one flood opacity for the map and the 3D water
      getWaterOpacity: () => parseFloat($('floodOpacity').value) / 100,
      onWaterOpacity: (pct) => { $('floodOpacity').value = String(pct); $('floodOpacity').dispatchEvent(new Event('input')); },
      getViewBox: () => viewBounds3d(),
      getCentre: () => { const m = state.lmap; if (!m) return null; const c = m.getCenter(); return [c.lat, c.lng]; },
      getAreas: () => areasFor3d(),
      // the 2D map's active XYZ basemap, for per-tile imagery in 3D. WebGL
      // textures need CORS, so a basemap that isn't loaded crossOrigin
      // (WMS, state aerial) falls back to the default satellite layer.
      getBasemap: () => basemap3d(),
      // DEM-H for an exact lon/lat box: the terrain fallback when the tile
      // service can't be reached. n x n samples, sea as SEA_LEVEL (-1.5 m).
      fetchDemBox: async (box, n) => {
        const { iw, ih, data, nd } = await fetchRaster(DEMH_WCS, box, n, n);
        const out = new Float32Array(iw * ih);
        for (let i = 0; i < out.length; i++) {
          const v = data[i];
          out[i] = !Number.isFinite(v) || v === nd || v < -1000 || v > 9000 ? -1.5 : Math.max(-1.5, v);
        }
        return { data: out, n: iw };
      },
      onScrub: (k) => { scheduleTimeStep(k); },
      onUnsupported: (text) => say(text),
      onClose: () => { view3d = null; for (const ar of areaReg.values()) delete ar.__area3d; },
    });
  }
  // the active basemap as the 3D view drapes it; one that can't be used as a
  // WebGL texture (no CORS: WMS, state aerial) falls back to satellite
  function basemap3d() {
    let bm = BASEMAPS.find((b) => b.name === status.basemap);
    const fallback = !bm || bm.wms || !bm.opts.crossOrigin;
    if (fallback) bm = BASEMAPS[0];
    // the finest level the service has (maxNativeZoom), not how far the 2D map scales it
    return { name: bm.name, template: bm.url(), subdomains: bm.opts.subdomains || '', maxZoom: bm.opts.maxNativeZoom || bm.opts.maxZoom, attr: bm.opts.attribution, fallback };
  }
  // a basemap switch while 3D is open re-drapes it
  function basemapChanged() {
    if (!view3d || !view3d.setBasemap) return;
    const bm = basemap3d();
    view3d.setBasemap(bm);
    if (bm.fallback) say(`3D can't drape ${status.basemap || 'that layer'}, so it keeps showing ${bm.name}.`);
  }
  // the visible map box as [s, w, n, e]; null when the map isn't open
  function viewBounds3d() {
    const m = state.lmap;
    if (!m) return null;
    const b = m.getBounds();
    return [b.getSouth(), b.getWest(), b.getNorth(), b.getEast()];
  }
  // every modelled tile on the map, ready for a stitched 3D scene. The
  // active area is complete; inactive ones had their analysis freed when
  // they were left (saveActive) — rebuild it here (worker, fast) and hold
  // it only while the 3D view is open.
  function areasFor3d() {
    return Array.from(areaReg.values()).map((ar) => {
      const t = {
        key: ar.key, a: ar.a || null, run: ar.run || null, terrain: ar.terrain || null,
        bounds: (ar.areaMeta && ar.areaMeta.bounds_lonlat) || null,
        active: ar.key === state.areaKey,
      };
      if (!t.a && ar.grid && ar.areaMeta) {
        if (!ar.__area3d) {
          ar.__area3d = (async () => {
            const a = await analyseAsync(ar.grid, { streamAreaKm2: ar.streamAreaKm2 || 2 });
            const gauge = ar.gauge >= 0 ? ar.gauge : a.defaultGauge;
            const c = ar.ctl || {};
            const slr = parseFloat(c.slr) || 0;
            const s = {
              gauge,
              gaugeLevel: (parseFloat(c.gaugeLevel) || a.dem[gauge] + 0.3) + (parseFloat(c.extra) || 0),
              bayLevel: (parseFloat(c.bayLevel) || 0) + slr,
              upstreamGradient: parseFloat(c.grad) || 0,
              controls: ar.controls || [],
            };
            const run = ar.gauge >= 0 ? F.inundate(a, withRiverBelow(a, s, ar.areaMeta), { slim: 1 }) : null;
            const terrain = terrainRGBA(a);
            // the scene's poll/refresh look at the entry itself; saveActive
            // frees it again the next time the user leaves this place
            ar.a = a; ar.run = run; ar.terrain = terrain;
            return { a, run, terrain };
          })();
          ar.__area3d.catch((err) => say(`3D: couldn't rebuild ${ar.name || ar.key}: ${err.message || err}`, { error: true }));
        }
        t.ready = ar.__area3d;
      }
      return t;
    });
  }
  $('btn3d').addEventListener('click', () => { open3d(); });
  window.__floodOpen3D = () => open3d();
  window.__flood3DState = () => (view3d ? view3d.snapshot() : { open: false });
  window.__floodPin = () => pinScenario();
  // Diagnostic for the river below the gauge: follow the flow path to the
  // sea (or the model edge) and report how deep the normal-level run puts
  // water on that channel (it should be about the normal 0.3 m), and how
  // much land the normal-level run wets away from mapped channels.
  window.__floodDownstreamDiag = () => {
    const a = state.a, base = state.base, run = state.run, g = state.gauge;
    if (!a || !base || g < 0 || !base.level) return null;
    const depths = [], flood = [];
    let end = 'edge', c = a.rec[g];
    for (; c >= 0; c = a.rec[c]) {
      if (a.ocean[c]) { end = 'sea'; break; }
      if (!a.valid[c]) continue;
      const lv = base.level[c];
      depths.push(Number.isFinite(lv) ? lv - a.dem[c] : NaN);
      if (run && run.level) flood.push(Number.isFinite(run.level[c]) ? run.level[c] - a.dem[c] : NaN);
    }
    const km = (n) => +(n * a.cell / 1000).toFixed(1);
    const fin = depths.filter(Number.isFinite), sorted = [...fin].sort((x, y) => x - y);
    let offChannel = 0, channel = 0;
    for (let i = 0; i < a.N; i++) { if (!base.wet[i] || a.ocean[i]) continue; if (a.stream[i]) channel++; else offChannel++; }
    const cellKm2 = (a.cell * a.cell) / 1e6;
    const ground = [];
    for (let c2 = a.rec[g]; c2 >= 0 && !a.ocean[c2]; c2 = a.rec[c2]) if (a.valid[c2]) ground.push(a.dem[c2]);
    const rb = riverBelow(a, g, state.areaMeta);
    const held = rb && rb.path.length ? [...rb.path.keys()].map((k) => rb.env[k] - a.dem[rb.path[k]]).sort((x, y) => x - y) : [];
    return {
      lidarShare: state.areaMeta && state.areaMeta.lidarShare != null ? +(+state.areaMeta.lidarShare).toFixed(2) : null, lidarDropped: status.lidarDropped ?? null,
      pathGround: ground.length ? { min: +Math.min(...ground).toFixed(1), max: +Math.max(...ground).toFixed(1) } : null,
      bedHeldAbove: held.length ? { median: +held[held.length >> 1].toFixed(2), p90: +held[Math.floor(held.length * 0.9)].toFixed(2) } : null,
      gaugeGround: +a.dem[g].toFixed(1), cell: Math.round(a.cell), end, pathKm: km(depths.length),
      normalDepthOnChannel: sorted.length ? { median: +sorted[Math.floor(sorted.length / 2)].toFixed(2), p90: +sorted[Math.floor(sorted.length * 0.9)].toFixed(2), max: +sorted[sorted.length - 1].toFixed(2) } : null,
      kmDeeperThan2m: km(fin.filter((d) => d > 2).length), kmDeeperThan5m: km(fin.filter((d) => d > 5).length), kmDry: km(fin.filter((d) => d <= 0).length + depths.filter((d) => !Number.isFinite(d)).length),
      floodMaxOnChannel: flood.length ? +Math.max(...flood.filter(Number.isFinite)).toFixed(2) : null,
      normalWetKm2: { channel: +(channel * cellKm2).toFixed(2), offChannel: +(offChannel * cellKm2).toFixed(2) },
    };
  };
  // Normal water against the satellite record: of the land the normal-level
  // run wets (not sea), how much satellites see as water, and how often.
  window.__floodNormalCheck = async () => {
    const a = state.a, base = state.base, g = state.geo;
    if (!a || !base || !g) return null;
    const best = a.sat || (await fetchSatFreq(a, g)).best;
    const cellKm2 = (a.cell * a.cell) / 1e6, k = (n) => +(n * cellKm2).toFixed(2);
    const c = { channel: 0, seenOften: 0, seenSometimes: 0, rarely: 0, never: 0, noData: 0 };
    let deepLow = 0;
    for (let i = 0; i < a.N; i++) {
      if (!base.wet[i] || a.ocean[i]) continue;
      if (a.stream[i]) { c.channel++; continue; }
      const f = best[i];
      if (f < 0) c.noData++; else if (f >= 0.5) c.seenOften++; else if (f >= 0.2) c.seenSometimes++; else if (f >= 0.02) c.rarely++; else { c.never++; if (base.depth && base.depth[i] > 1) deepLow++; }
    }
    let tinted = 0, untinted = 0;
    const thr = parseFloat(ctl.streamArea && ctl.streamArea.value) || 0;
    for (let i = 0; i < a.N; i++) {
      if (!a.stream[i] || a.ocean[i] || base.wet[i]) continue;
      if (best[i] >= 0 && best[i] < SAT_CHANNEL) untinted++; else tinted++;
    }
    const lv = base.level && state.gauge >= 0 ? base.level[state.gauge] : null;
    return {
      cell: Math.round(a.cell), gauge: state.gauge >= 0 ? { ground: +a.dem[state.gauge].toFixed(2), normalLevel: lv != null ? +lv.toFixed(2) : null } : null,
      km2: Object.fromEntries(Object.entries(c).map(([n, v]) => [n, k(v)])), neverSeenDeeperThan1m: k(deepLow),
      lowGroundKm2: base.low ? k(base.low.idx.length) : null, satellite: a.sat ? 'used' : a.sat === false ? 'unavailable' : 'pending',
      drainageLinesKm: { drawn: +(tinted * a.cell / 1000).toFixed(1), notDrawn: +(untinted * a.cell / 1000).toFixed(1) }, streamThr: thr,
      bay: parseFloat(ctl.bayLevel.value),
    };
  };
  window.__floodOpenGaugeNamed = (re) => {
    const rx = new RegExp(re, 'i');
    const f = nat.data && [...nat.data.gauges, ...nat.data.storages].find((x) => rx.test(x.properties.name || ''));
    if (!f) return null;
    openReport(f);
    return f.properties;
  };
  window.__floodGaugeLatLng = () => (state.a && state.gauge >= 0 ? cellLatLng(state.gauge) : null);
  window.__floodSetLevel = (v) => { ctl.gaugeLevel.value = v; syncOutputs(); runScenario(); return parseFloat(ctl.gaugeLevel.value); };
  window.__floodRelease = (pct, start, hours) => { $('relUnit').value = 'pct'; $('relFlow').value = pct; $('relStart').value = start; $('relHours').value = hours; return releaseOpts(); };
  window.__floodWarming = (deg) => { ctl.warming.value = String(deg); runScenario(); return status.flash; };
  window.__floodColorMode = (m) => { $('colorMode').value = m; drawMap(); return { mode: colorMode(), hazard: status.hazard, compare: status.compare }; };

  let lastChromeKey = null;
  function scheduleMapChrome() {
    const key = `${colorMode()}|${state.pinned && state.pinned.key === state.areaKey ? state.pinned.run : 'none'}|${state.timeView ? state.timeStep : 'n/a'}|${state.areaKey || ''}`;
    if (key === lastChromeKey) return;
    lastChromeKey = key;
    renderModeLegend();
    renderCompare();
  }
  function drawMap() {
    if (state.pendingGeo) return;
    // coalesce legend/compare DOM work: drawMap is called per timeline
    // step and these writes were running unconditionally even when their
    // inputs hadn't changed
    scheduleMapChrome();
    if (view3d) view3d.refresh();
    if (state.geo && state.lmap && state.overlay) drawGeoMap();
    else if (!state.geo) drawStaticMap();
  }

  function drawStaticMap() {
    const a = state.a;
    const img = composeImage(true);
    const off = state.offscreen;
    off.width = a.W; off.height = a.H;
    off.getContext('2d').putImageData(img, 0, 0);

    const canvas = $('map');
    const stage = $('mapWrap');
    const cssW = Math.max(200, Math.min(stage.clientWidth, (stage.clientHeight * a.W) / a.H));
    canvas.style.width = cssW + 'px';
    canvas.style.height = (cssW * a.H / a.W) + 'px';
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const pw = Math.round(cssW * dpr), ph = Math.round((cssW * a.H / a.W) * dpr);
    if (canvas.width !== pw || canvas.height !== ph) { canvas.width = pw; canvas.height = ph; }
    const ctx = canvas.getContext('2d');
    ctx.imageSmoothingEnabled = a.W < pw;
    ctx.drawImage(off, 0, 0, pw, ph);

    const sx = pw / a.W, sy = ph / a.H;
    // gauge marker
    if (state.gauge >= 0) {
      const gx = ((state.gauge % a.W) + 0.5) * sx, gy = (Math.floor(state.gauge / a.W) + 0.5) * sy;
      ctx.beginPath(); ctx.arc(gx, gy, 6.5 * dpr, 0, Math.PI * 2);
      ctx.fillStyle = '#c66f1d'; ctx.fill();
      ctx.lineWidth = 2.2 * dpr; ctx.strokeStyle = '#ffffff'; ctx.stroke();
      ctx.font = `600 ${12 * dpr}px Archivo, sans-serif`;
      ctx.lineWidth = 3 * dpr; ctx.strokeStyle = 'rgba(255,255,255,0.9)';
      const label = state.eventsApply ? 'Brisbane City gauge' : 'Gauge';
      const lx = Math.min(gx + 10 * dpr, pw - ctx.measureText(label).width - 6 * dpr);
      ctx.strokeText(label, lx, gy - 9 * dpr);
      ctx.fillStyle = '#5a2f08'; ctx.fillText(label, lx, gy - 9 * dpr);
    }
    // scale bar
    const mPerPx = (a.W * a.cell) / pw;
    const target = 110 * dpr * mPerPx;
    const nice = [100, 200, 500, 1000, 2000, 5000, 10000, 20000].find((v) => v >= target * 0.6) || 20000;
    const len = nice / mPerPx;
    const bx = 12 * dpr, by = ph - 14 * dpr;
    ctx.fillStyle = 'rgba(255,255,255,0.85)';
    ctx.fillRect(bx - 6 * dpr, by - 18 * dpr, len + 12 * dpr, 26 * dpr);
    ctx.fillStyle = '#12202a';
    ctx.fillRect(bx, by - 3 * dpr, len, 3 * dpr);
    ctx.fillRect(bx, by - 7 * dpr, 1.5 * dpr, 7 * dpr);
    ctx.fillRect(bx + len - 1.5 * dpr, by - 7 * dpr, 1.5 * dpr, 7 * dpr);
    ctx.font = `500 ${11 * dpr}px "IBM Plex Mono", monospace`;
    ctx.fillText(nice >= 1000 ? `${nice / 1000} km` : `${nice} m`, bx + 4 * dpr, by - 7 * dpr);
  }


  /* ---------------------------------------------------- interactive map */
  // Areas with real coordinates (meta.bounds_lonlat) are shown on a pan-and-
  // zoom street map with the flood depths as an overlay. The grid is in
  // GDA2020 / MGA56, whose grid north is within 0.02° of true north at
  // Brisbane, so a lat/lon-aligned overlay lines up to a few metres.

  const TILES = {
    // Esri's grey canvas maps (no key; CARTO's now need one): a base and a
    // labels layer drawn over it
    light: 'https://server.arcgisonline.com/ArcGIS/rest/services/Canvas/World_Light_Gray_Base/MapServer/tile/{z}/{y}/{x}',
    dark: 'https://server.arcgisonline.com/ArcGIS/rest/services/Canvas/World_Dark_Gray_Base/MapServer/tile/{z}/{y}/{x}',
    lightLabels: 'https://server.arcgisonline.com/ArcGIS/rest/services/Canvas/World_Light_Gray_Reference/MapServer/tile/{z}/{y}/{x}',
    darkLabels: 'https://server.arcgisonline.com/ArcGIS/rest/services/Canvas/World_Dark_Gray_Reference/MapServer/tile/{z}/{y}/{x}',
  };
  const OSM_ATTR = '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors';
  const TILE_ATTR = 'Tiles &copy; Esri &mdash; Esri, TomTom, Garmin, ' + OSM_ATTR + ', and the GIS User Community';
  const QLD_ATTR = '&copy; State of Queensland (Department of Natural Resources and Mines, Manufacturing and Regional and Rural Development), <a href="https://creativecommons.org/licenses/by/4.0/">CC BY 4.0</a>';
  const QLD_GIS = 'https://spatial-gis.information.qld.gov.au/arcgis/rest/services/Basemaps/';
  // Digital Earth Australia (Geoscience Australia) map services, CC BY 4.0
  const DEA_OWS = 'https://ows.dea.ga.gov.au/';
  const DEA_ATTR = 'Satellite data &copy; <a href="https://www.dea.ga.gov.au/">Digital Earth Australia</a> (Geoscience Australia; Landsat, Copernicus Sentinel-2), CC BY 4.0';
  function deaWms(L, params, opts) {
    return L.tileLayer.wms(DEA_OWS, Object.assign({
      format: 'image/png', transparent: true, version: '1.3.0', tileSize: 512, zoomOffset: 0,
    }, params, opts));
  }

  // Basemaps offered in the layer switcher. The first is the default.
  const BASEMAPS = [
    { name: 'Satellite (Esri)', url: () => 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}',
      opts: { attribution: 'Imagery &copy; Esri, Maxar, Earthstar Geographics and the GIS User Community', maxZoom: 19, crossOrigin: true } },
    { name: 'Latest satellite, infrared (DEA)', wms: { layers: 's2_ls_combined', styles: 'false_colour' },
      opts: { attribution: DEA_ATTR, maxZoom: 19, maxNativeZoom: 16, minZoom: 7 } },
    { name: 'Latest satellite, true colour (DEA)', wms: { layers: 's2_ls_combined', styles: 'true_colour' },
      opts: { attribution: DEA_ATTR, maxZoom: 19, maxNativeZoom: 16, minZoom: 7 } },
    { name: 'Streets', url: () => (isDark() ? TILES.dark : TILES.light), labels: () => (isDark() ? TILES.darkLabels : TILES.lightLabels),
      opts: { attribution: TILE_ATTR, maxZoom: 19, maxNativeZoom: 16, crossOrigin: true } },
    { name: 'OpenStreetMap', url: () => 'https://tile.openstreetmap.org/{z}/{x}/{y}.png',
      opts: { attribution: OSM_ATTR, maxZoom: 19, crossOrigin: true } },
    { name: 'Queensland aerial imagery', url: () => 'https://spatial-img.information.qld.gov.au/arcgis/rest/services/Basemaps/LatestStateProgram_AllUsers/ImageServer/tile/{z}/{y}/{x}',
      opts: { attribution: 'Imagery &copy; Planet Labs Netherlands B.V. under licence from Planet and Geoplex; ' + QLD_ATTR, maxZoom: 20 } },
    { name: 'Queensland topographic', url: () => QLD_GIS + 'QldMap_Topo/MapServer/tile/{z}/{y}/{x}',
      opts: { attribution: QLD_ATTR, maxZoom: 20 } },
    { name: 'Topographic (OpenTopoMap)', url: () => 'https://{s}.tile.opentopomap.org/{z}/{x}/{y}.png',
      opts: { attribution: OSM_ATTR + ', SRTM | Style &copy; <a href="https://opentopomap.org">OpenTopoMap</a> (CC BY-SA)', subdomains: 'abc', maxZoom: 17, crossOrigin: true } },
  ];
  const BASEMAP_KEY = 'bfe.basemap.v2'; // v2: satellite became the default

  // Brisbane City Council Flood Awareness layers (CC BY 4.0), read live from
  // the council's ArcGIS services. Only offered for the Brisbane area.
  const BCC = 'https://services2.arcgis.com/dEKgZETqwmDAh1rP/ArcGIS/rest/services/';
  const BCC_ATTR = 'Flood awareness data &copy; <a href="https://data.brisbane.qld.gov.au/">Brisbane City Council</a>, <a href="https://creativecommons.org/licenses/by/4.0/">CC BY 4.0</a>';
  const LIKELIHOOD = { High: '#b3261e', Medium: '#e8710a', Low: '#f2c12e', 'Very Low': '#fff3a8' };
  const OVERLAYS = [
    { name: 'Creek flooding likelihood (council)', service: 'Flood_Awareness_Creek', kind: 'likelihood', minZoom: 13, image: 'creek' },
    { name: 'Overland flow likelihood (council)', service: 'Flood_Awareness_Overland_Flow', kind: 'likelihood', minZoom: 14, image: 'overland' },
    { name: 'Recorded flood: Feb 2022 (river + creek)', service: 'Flood_Awareness_Historic_Brisbane_River_and_Creek_Floods_Feb2022', kind: 'outline', color: '#ff3d9a' },
    { name: 'Recorded flood: Jan 2011 (river)', service: 'Flood_Awareness_Historic_Brisbane_River_Floods_Jan2011', kind: 'outline', color: '#ffd400' },
    { name: 'Recorded flood: Jan 1974 (river)', service: 'Flood_Awareness_Historic_Brisbane_River_Floods_Jan1974', kind: 'outline', color: '#ff7a00' },
  ];

  // Available on every real-place map, anywhere in Australia
  const NATIONAL_OVERLAYS = [
    { name: 'Water seen by satellite since 1987 (DEA)', layers: 'ga_ls_wo_fq_myear_3', styles: 'mysummary_wofs_frequency_3', mosaic: 'water_frequency',
      legend: 'How often satellites have seen water there: pale = rarely (floods), dark blue = usually (rivers, lakes)' },
  ];

  // State flood mapping, drawn as images by each state's map server (so no
  // cross-site data access is needed). Shown wherever the state has data.
  const STATE_OVERLAYS = [
    { name: 'Queensland floodplain assessment (state)', state: 'QLD',
      url: 'https://spatial-gis.information.qld.gov.au/arcgis/rest/services/Boundaries/AdminBoundariesFramework/MapServer',
      layers: [15], opacity: 0.45,
      attribution: 'Queensland Floodplain Assessment Overlay &copy; State of Queensland, CC BY 4.0',
      legend: 'Queensland floodplain assessment: land that may be on a floodplain (statewide, broad scale)', swatch: '#4a7fc1' },
    { name: 'NSW flood planning areas (state)', state: 'NSW',
      url: 'https://mapprod3.environment.nsw.gov.au/arcgis/rest/services/Planning/Hazard/MapServer',
      layers: [1], opacity: 0.6, minZoom: 14,
      // The service's 1:50,000 limit still applies to dynamic exports.
      // Offer a zoom hint instead of claiming an empty regional image is shown.
      attribution: 'Flood planning &copy; State of New South Wales (Department of Planning), from local environmental plans',
      legend: 'NSW flood planning areas from council planning schemes', swatch: '#3b6fb6' },
    { name: 'Queensland storm tide hazard areas (state)', state: 'QLD-TIDE',
      url: 'https://spatial-gis.information.qld.gov.au/arcgis/rest/services/PlanningCadastre/CoastalManagement/MapServer',
      layers: [11, 12], opacity: 0.45, minZoom: 6,
      dynamicLayers: [11, 12].map((id) => ({ id, source: { type: 'mapLayer', mapLayerId: id }, minScale: 0, maxScale: 0 })),
      attribution: 'Storm tide hazard &copy; State of Queensland',
      legend: 'Queensland storm tide hazard areas (high and medium), from the State Planning Policy mapping', swatch: '#00838f' },
    { name: 'Queensland recorded floods, 1974–2019 (state)', state: 'QLD-REC',
      url: 'https://spatial-gis.information.qld.gov.au/arcgis/rest/services/InlandWaters/FloodLines/MapServer',
      layers: [12, 13, 14, 15, 16, 17, 18, 19, 20], opacity: 0.45, minZoom: 6,
      dynamicLayers: [12, 13, 14, 15, 16, 17, 18, 19, 20].map((id) => ({ id, source: { type: 'mapLayer', mapLayerId: id }, minScale: 0, maxScale: 0 })),
      attribution: 'Recorded flood lines &copy; State of Queensland',
      legend: 'Queensland recorded flood extents (1974 Brisbane, 2010–13 Bundaberg, 2011 towns, 2017 Fitzroy and Logan, 2019 west)', swatch: '#d9480f' },
  ];

  // Hazard categories, light to dark (a single-hue sequence, so it reads
  // without colour vision too): the higher the hazard, the darker
  const HAZARD_RAMP = ['#c6dbef', '#9ecae1', '#6baed6', '#3182bd', '#08519c', '#08306b'];
  const hazardColor = (text) => {
    const t = String(text || '');
    const h = /\bH\s*([1-6])\b/i.exec(t);
    if (h) return HAZARD_RAMP[+h[1] - 1];
    if (/very high|extreme/i.test(t)) return HAZARD_RAMP[5];
    if (/high/i.test(t)) return HAZARD_RAMP[4];
    if (/medium|moderate/i.test(t)) return HAZARD_RAMP[3];
    if (/low/i.test(t)) return HAZARD_RAMP[2];
    return HAZARD_RAMP[0];   // extents, planning areas
  };
  // Council flood mapping published as open map services (shown when
  // zoomed in). Brisbane's are in the council layers above.
  const COUNCIL_OVERLAYS = [
    { name: 'Gold Coast flood risk, 2026 (council)', type: 'feature', minZoom: 12,
      url: 'https://services-ap1.arcgis.com/lnVW0dLI3fvST2hd/arcgis/rest/services/Flood_Risk_Overlay_2026/FeatureServer/0',
      colorBy: (p) => hazardColor(p.RISK),
      attribution: 'Flood risk overlay &copy; City of Gold Coast (City Plan)',
      legend: 'Gold Coast flood risk overlay (very high to low risk, and the maximum regional flood extent)', swatch: '#3182bd', test: [-28.01, 153.37] },
    { name: 'Moreton Bay flood hazard (council)', type: 'feature', minZoom: 12,
      url: 'https://services-ap1.arcgis.com/152ojN3Ts9H3cdtl/arcgis/rest/services/OM_Flood_Hazard_WebMercator_OpenData/FeatureServer/0',
      colorBy: (p) => hazardColor(p.OVL2_DESC),
      attribution: 'Flood hazard &copy; City of Moreton Bay (planning scheme overlay)',
      legend: 'Moreton Bay flood hazard overlay (high and medium risk areas, flood planning area)', swatch: '#3182bd', test: [-27.085, 152.95] },
    { name: 'Moreton Bay storm tide (council)', type: 'feature', minZoom: 12,
      url: 'https://services-ap1.arcgis.com/152ojN3Ts9H3cdtl/arcgis/rest/services/OM_Coastal_Hazard_Storm_Tide_WebMercator_OpenData/FeatureServer/0',
      attribution: 'Storm tide hazard &copy; City of Moreton Bay (planning scheme overlay)',
      legend: 'Moreton Bay coastal hazard: storm tide inundation (planning scheme)', swatch: '#00838f', test: [-27.185, 153.07] },
    { name: 'Rockhampton flood hazard, H1–H6 (council)', type: 'feature', minZoom: 12,
      url: 'https://services-ap1.arcgis.com/hx2J5p82likyGt5G/arcgis/rest/services/Fitzroy_River_Flood_Hazard_Minus_NRFMA/FeatureServer/0',
      colorBy: (p) => hazardColor([p.DESCRIPTION, p.LAYER, p.UserText_1, p.UserText_2].join(' ')),
      attribution: 'Flood hazard &copy; Rockhampton Regional Council (planning scheme; AECOM 2019 Fitzroy model)',
      legend: 'Rockhampton flood hazard from depth × velocity: H1 (generally safe) to H6 (unsafe for all buildings)', swatch: '#3182bd', test: [-23.37, 150.52] },
    { name: 'Logan flooding, 2015 (council)', type: 'tiles', minZoom: 11,
      url: 'https://services7.arcgis.com/si70weKpzPSa0BGV/arcgis/rest/services/LCC_Flooding_TLPI_2015/MapServer',
      attribution: 'Flooding (temporary local planning instrument, 2015) &copy; Logan City Council',
      legend: 'Logan flood mapping from the 2015 temporary local planning instrument', swatch: '#3b6fb6', test: [-27.70, 153.14] },
    { name: 'Livingstone flood hazard (council)', type: 'tiles', minZoom: 11,
      url: 'https://tiles.arcgis.com/tiles/0feS4n90HMqhF4HA/arcgis/rest/services/OM17_Flood_Hazard_Area/MapServer',
      attribution: 'Flood hazard area overlay &copy; Livingstone Shire Council (planning scheme 2018)',
      legend: 'Livingstone (Yeppoon, Emu Park) flood hazard area overlay (planning scheme)', swatch: '#3b6fb6', test: [-23.13, 150.74] },
    { name: 'Moreton Bay overland flow paths (council)', type: 'feature', minZoom: 12,
      url: 'https://services-ap1.arcgis.com/152ojN3Ts9H3cdtl/ArcGIS/rest/services/OM_Overland_Flow_Path_WebMercator_OpenData/FeatureServer/0',
      attribution: 'Overland flow paths &copy; City of Moreton Bay (planning scheme overlay)',
      legend: 'Moreton Bay overland flow paths (planning scheme)', swatch: '#7b4fc9', test: [-27.075, 152.965] },
    { name: 'Sunshine Coast overland flow, 1% chance (council)', type: 'map', minZoom: 12,
      url: 'https://geoimage.scc.qld.gov.au/arcgis/rest/services/Emergency/FloodMapping_IndividualStudies_OverlandFlowModel_scrc/MapServer',
      pick: (l) => l.id < 57 && !(l.subLayerIds && l.subLayerIds.length) && /(1\s*%|1 in 100)/i.test(l.name) && /current/i.test(l.name),
      attribution: 'Overland flow model &copy; Sunshine Coast Council',
      legend: 'Sunshine Coast overland flow model, 1% annual chance, current climate (study areas only)', swatch: '#7b4fc9', test: [-26.66, 153.06] },
  ];
  function makeCouncilOverlay(o) {
    const esri = window.L && window.L.esri;
    if (!esri) return null;
    const st = (status.overlays[o.name] = { features: 0, errors: 0 });
    let layer;
    if (o.type === 'feature') {
      // canvas rendering: council flood polygons are thousands of SVG paths
      // at z12+, which re-layouts on every pan; a canvas renderer keeps pan smooth
      layer = esri.featureLayer({
        url: o.url, minZoom: o.minZoom, simplifyFactor: 0.5, precision: 6, attribution: o.attribution,
        renderer: window.L.canvas({ padding: 0.5 }),
        style: (f) => { const c = o.colorBy ? o.colorBy((f && f.properties) || {}) : o.swatch; return { color: c, weight: 1, fillColor: c, fillOpacity: 0.4 }; },
      });
      layer.on('load', () => { let n = 0; layer.eachFeature(() => { n++; }); st.features = Math.max(st.features, n); });
      layer.on('createfeature', () => { st.drawn = (st.drawn || 0) + 1; if (st.drawn > st.features) st.features = st.drawn; });
      // esri-leaflet can try to add or remove features after the layer has
      // left the map (requests still in flight): ignore those
      ['addLayers', 'removeLayers'].forEach((fn) => {
        const orig = layer[fn];
        layer[fn] = function guarded(...args) { return this._map ? orig.apply(this, args) : undefined; };
      });
    } else if (o.type === 'tiles') {
      // a cached (tile-only) map service
      layer = esri.tiledMapLayer({ url: o.url, opacity: 0.65, attribution: o.attribution, minZoom: o.minZoom, maxZoom: 20, zIndex: 4 });
      layer.on('tileload', () => { st.features++; });
      layer.on('tileerror', () => { st.errors++; });
    } else {
      layer = esri.dynamicMapLayer({ url: o.url, opacity: 0.6, attribution: o.attribution, f: 'image', format: 'png32', transparent: true, minZoom: o.minZoom, zIndex: 4 });
      layer.on('load', () => { st.features++; });
      if (o.pick) {
        fetch(`${o.url}?f=json`).then((r) => r.json()).then((j) => {
          const ids = (j.layers || []).filter(o.pick).map((l) => l.id);
          st.picked = ids.length;
          if (ids.length) layer.setLayers(ids);
        }).catch(() => { st.errors++; });
      }
    }
    layer.on('requesterror', () => { st.errors++; });
    layer.zoomNote = { min: o.minZoom, text: 'council view' };
    o.layer = layer;
    o.kind = 'council';
    return layer;
  }

  function makeStateOverlay(o) {
    const esri = window.L && window.L.esri;
    if (!esri) return null;
    const st = (status.overlays[o.name] = { features: 0, errors: 0 });
    const layer = esri.dynamicMapLayer(Object.assign({
      url: o.url, layers: o.layers, opacity: o.opacity, attribution: o.attribution, f: 'image', format: 'png32',
      transparent: true, minZoom: o.minZoom || 0, zIndex: 4,
    }, o.dynamicLayers ? { dynamicLayers: JSON.stringify(o.dynamicLayers) } : {}));
    if (o.minZoom) layer.zoomNote = { min: o.minZoom, text: 'state-wide view' };
    layer.on('load', () => { st.features++; });
    layer.on('requesterror', () => { st.errors++; });
    o.layer = layer;
    o.kind = 'state';
    return layer;
  }

  // Australia-wide images of DEA layers, stitched by the build from tiles at
  // the coarsest zoom DEA will draw (flood dea, rust/flood-pipeline)
  let deaMosaic = null;
  async function loadDeaMosaic() {
    if (deaMosaic) return deaMosaic;
    try {
      const r = await fetch('data/dea/dea.json', { cache: 'no-cache' });
      deaMosaic = r.ok ? await r.json() : {};
    } catch (e) { deaMosaic = {}; }
    return deaMosaic;
  }

  function makeWmsOverlay(L, o) {
    const st = (status.overlays[o.name] = { features: 0, errors: 0 });
    // DEA's server only draws this from about zoom 7 (regional scale)
    const live = deaWms(L, { layers: o.layers, styles: o.styles }, { attribution: DEA_ATTR, opacity: 0.75, maxZoom: 19, maxNativeZoom: 16, minZoom: 7, zIndex: 5 });
    live.on('tileload', () => { st.features++; });
    live.on('tileerror', () => { st.errors++; });
    const img = deaMosaic && deaMosaic[o.mosaic];
    let layer = live;
    if (img) {
      // zoomed out: the stitched national image, scaled to fit
      const b = img.bounds;
      const pic = subpixelImageOverlay(`data/dea/${img.file}`, [[b[1], b[0]], [b[3], b[2]]], {
        opacity: 0.8, attribution: DEA_ATTR, zIndex: 5,
      });
      pic.on('load', () => { st.features++; st.image = true; });
      pic.on('error', () => { st.errors++; });
      layer = zoomSwitch(pic, live, 7, DEA_ATTR);
    } else {
      live.zoomNote = { min: 7, text: 'regional view' };
    }
    o.layer = layer;
    o.kind = 'wms';
    return layer;
  }

  // A layer that shows `low` below zoom `z` and `high` from zoom `z` up:
  // a pre-rendered image for the whole area, and live detail close in.
  function zoomSwitch(low, high, z, attribution) {
    const L = window.L;
    const Switch = L.Layer.extend({
      onAdd(map) { this._map = map; map.on('zoomend', this._update, this); this._update(); },
      onRemove(map) {
        map.off('zoomend', this._update, this);
        [low, high].forEach((l) => l && map.hasLayer(l) && map.removeLayer(l));
      },
      getAttribution() { return attribution; },
      _update() {
        const hi = this._map.getZoom() >= z || !low;
        const want = hi ? high : low, other = hi ? low : high;
        if (other && this._map.hasLayer(other)) this._map.removeLayer(other);
        if (want && !this._map.hasLayer(want)) want.addTo(this._map);
      },
    });
    return new Switch();
  }

  let councilImages = null;
  async function loadCouncilImages() {
    if (councilImages) return councilImages;
    try {
      const r = await fetch('data/council/council.json', { cache: 'no-cache' });
      councilImages = r.ok ? await r.json() : { layers: {} };
    } catch (e) { councilImages = { layers: {} }; }
    return councilImages;
  }

  function makeOverlay(o) {
    const esri = window.L && window.L.esri;
    if (!esri) return null;
    const st = (status.overlays[o.name] = { features: 0, errors: 0 });
    const style = o.kind === 'likelihood'
      ? (f) => ({ color: LIKELIHOOD[f.properties.FLOOD_RISK] || '#999', weight: 0.6,
          fillColor: LIKELIHOOD[f.properties.FLOOD_RISK] || '#999', fillOpacity: 0.45 })
      : () => ({ color: o.color, weight: 2.4, dashArray: '6 4', fill: false });
    const layer = esri.featureLayer({
      url: BCC + o.service + '/FeatureServer/0',
      style, minZoom: o.minZoom || 0, simplifyFactor: 0.5, precision: 6,
      attribution: BCC_ATTR,
    });
    layer.on('createfeature', () => { st.features++; });
    layer.on('requesterror', () => { st.errors++; });
    if (o.kind === 'likelihood') {
      layer.bindPopup((l) => escapeHtml(`${o.name.replace(' (council)', '')}: ${l.feature.properties.FLOOD_RISK || 'unknown'} likelihood`));
      const img = councilImages && councilImages.layers && councilImages.layers[o.image];
      if (img) {
        const b = img.bounds;
        const pic = subpixelImageOverlay(`data/council/${img.file}`, [[b[1], b[0]], [b[3], b[2]]], {
          opacity: 0.6, className: 'flood-layer', attribution: BCC_ATTR, zIndex: 3,
        });
        pic.on('load', () => { st.features++; st.image = true; });
        pic.on('error', () => { st.errors++; });
        o.layer = zoomSwitch(pic, layer, o.minZoom, BCC_ATTR);
        o.layer.zoomNote = null;
        return o.layer;
      }
      layer.zoomNote = { min: o.minZoom, text: 'detailed layer' };
    }
    o.layer = layer;
    return layer;
  }

  function renderOverlayLegend() {
    const box = $('overlayLegend');
    if (!box || !state.lmap) return;
    const on = OVERLAYS.filter((o) => o.layer && state.lmap.hasLayer(o.layer));
    const parts = [];
    if (on.some((o) => o.kind === 'likelihood')) {
      parts.push(...Object.entries(LIKELIHOOD).map(([k, c]) => `<span><i style="background:${c}"></i>${k} likelihood</span>`));
      const z = state.lmap.getZoom();
      const hidden = on.filter((o) => o.layer.zoomNote && z < o.layer.zoomNote.min);
      if (hidden.length) parts.push(`<span class="hint">Zoom in to see ${hidden.map((o) => o.name.split(' ')[0].toLowerCase()).join(' and ')} layers</span>`);
    }
    [...STATE_OVERLAYS, ...COUNCIL_OVERLAYS].filter((o) => o.layer && state.lmap.hasLayer(o.layer)).forEach((o) => {
      const z = state.lmap.getZoom();
      parts.push(`<span><i style="background:${o.swatch};opacity:.6"></i>${escapeHtml(o.legend)}${o.layer.zoomNote && z < o.layer.zoomNote.min ? ' <em>(zoom in)</em>' : ''}</span>`);
    });
    NATIONAL_OVERLAYS.filter((o) => o.layer && state.lmap.hasLayer(o.layer)).forEach((o) => {
      parts.push(`<span><i style="background:linear-gradient(90deg,#e6f3fb,#5aa9d6,#08306b)"></i>${escapeHtml(o.legend)}</span>`);
    });
    if (nat.roadClosuresLayer && state.lmap.hasLayer(nat.roadClosuresLayer)) {
      const n = (nat.readings && nat.readings.roads && nat.readings.roads.items || []).length;
      for (const st of Object.values(ROAD_LEVELS)) parts.push(`<span><i style="background:${st.color}"></i>${escapeHtml(st.label)}</span>`);
      const items = (nat.readings && nat.readings.roads && nat.readings.roads.items) || [];
      if (n) parts.push(`<span><i style="background:#c62828;height:4px;width:10px"></i>${n} official road event${n === 1 ? '' : 's'} on now (${[...new Set(items.map((x) => roadSource(x.state)))].join(', ')})</span>`);
    }
    on.filter((o) => o.kind === 'outline').forEach((o) => {
      parts.push(`<span><i style="background:transparent;border:2px dashed ${o.color};height:8px"></i>${o.name.replace('Recorded flood: ', 'Recorded ')}</span>`);
    });
    box.innerHTML = parts.join('');
    box.hidden = !parts.length || $('legendToggle').getAttribute('aria-expanded') === 'false';
  }
  const BLANK = 'data:image/gif;base64,R0lGODlhAQABAAAAACH5BAEKAAEALAAAAAABAAEAAAICTAEAOw==';
  const status = (window.__floodStatus = { mode: 'static', overlayUpdates: 0, tilesLoaded: 0, tileErrors: 0, floodPixels: 0, overlays: {} });
  status.engine = F.engine || 'loading';

  // The flood model only exists as WebAssembly. When it can't load (an old
  // browser, private-mode restrictions or a broken fetch) the app refuses
  // to run rather than silently degrading, because every number on screen
  // would otherwise come from a different model than the user expects.
  let modelUnavailable = false;
  function showModelGate(detail) {
    if (modelUnavailable) return;
    modelUnavailable = true;
    status.engine = F.engine = 'error';
    const card = document.createElement('div');
    card.id = 'wasmGate';
    card.setAttribute('role', 'alertdialog');
    card.setAttribute('aria-label', 'The flood model is unavailable');
    card.innerHTML = `<style>
      #wasmGate{position:fixed;inset:0;z-index:9999;background:rgba(8,24,38,.72);display:flex;align-items:center;justify-content:center;padding:24px}
      #wasmGate .card{max-width:34em;background:var(--paper,#fff);color:var(--ink,#123);border-radius:12px;padding:22px 26px;box-shadow:0 8px 40px rgba(0,0,0,.35)}
      #wasmGate h2{margin:.1em 0 .4em;font-size:1.15em}
      #wasmGate ul{margin:.3em 0 .8em;padding-left:1.2em}
      #wasmGate button{font:inherit;padding:.4em 1.1em;border-radius:8px;border:1px solid var(--line,#94a3b8);background:var(--accent,#20618d);color:#fff;cursor:pointer}
    </style><div class="card"><h2>This browser can't run the flood model</h2>
      <p>The flood model is written in Rust and runs as WebAssembly. It didn't load, so flood maps, statistics and timeline playback can't be calculated.</p>
      <p>This usually means:</p>
      <ul><li>an old browser without WebAssembly — try the current Firefox, Chrome, Edge or Safari</li>
      <li>a browser extension or private-browsing setting blocking WebAssembly or the model download</li>
      <li>an interrupted download — a reload often fixes it</li></ul>
      <p class="hint">${escapeHtml(detail || '')}</p>
      <button type="button" onclick="location.reload()">Reload the app</button></div>`;
    document.body.appendChild(card);
  }
  window.addEventListener('flood:wasm-error', (e) => showModelGate(e.detail && e.detail.error));
  if (window.FloodCoreReady) window.FloodCoreReady.then(() => { status.engine = F.engine; if (F.engine !== 'rust') showModelGate('The model could not be loaded in this browser session.'); });

  // Offline use: a service worker keeps the app, the national data, map
  // tiles and model terrain that have been used, so the site still opens
  // and saved places still rebuild when the signal drops.
  status.offline = { supported: 'serviceWorker' in navigator, registered: false, online: navigator.onLine };
  if (import.meta.env.PROD && 'serviceWorker' in navigator && window.isSecureContext) {
    window.addEventListener('load', () => {
      navigator.serviceWorker.register(new URL('sw.js', document.baseURI).href).then(() => { status.offline.registered = true; }).catch((err) => { status.offline.error = String(err); });
    });
  }
  function showConnection() {
    const on = navigator.onLine;
    status.offline.online = on;
    const pill = document.getElementById('offlinePill');
    if (pill) pill.hidden = on;
  }
  window.addEventListener('online', () => { showConnection(); if (typeof say === 'function') say('Back online.'); });
  window.addEventListener('offline', () => { showConnection(); if (typeof say === 'function') say('Offline: showing saved data. New places need a connection.'); });
  showConnection();
  status.worker = () => (worker ? 'worker' : worker === false ? 'page' : 'unused');

  let leafletPromise = null;
  function loadLeaflet() {
    if (window.L && window.L.map) return Promise.resolve();
    if (!leafletPromise) {
      leafletPromise = import('./map-libs.js').catch((err) => {
        leafletPromise = null;
        throw new Error('The street map could not load.', { cause: err });
      });
    }
    return leafletPromise;
  }

  function isDark() {
    const t = document.documentElement.getAttribute('data-theme');
    if (t) return t === 'dark';
    try { return window.matchMedia('(prefers-color-scheme: dark)').matches; } catch (e) { return false; }
  }

  async function enterGeoMode(b, opts) {
    const fit = !opts || opts.fit !== false;
    try {
      await loadLeaflet();
    } catch (err) {
      leaveGeoMode();
      say(`${err.message} Showing the terrain picture instead.`, { error: true });
      return false;
    }
    const L = window.L;
    $('map').hidden = true;
    $('lmap').hidden = false;
    $('geoControls').hidden = false;
    $('layersStaticNote').hidden = true;
    const bounds = L.latLngBounds([b[1], b[0]], [b[3], b[2]]);
    if (!state.lmap) await loadDeaMosaic();
    if (!state.lmap) {
      // the wheel is handled by smoothWheelZoom below (continuous zoom)
      const m = L.map('lmap', { minZoom: 4, zoomSnap: 0, zoomDelta: 0.5, scrollWheelZoom: false, zoomControl: false, preferCanvas: false });
      enableSmoothWheelZoom(L, m);
      window.__floodMap = m;   // test hook (same family as __floodRunTimeline)
      if (!finePointer()) { /* pinch to zoom on touch screens */ } else L.control.zoom({ position: 'bottomright' }).addTo(m);
      const layers = {};
      status.basemaps = {};
      for (const bm of BASEMAPS) {
        // DEA draws imagery from about zoom 6; at zoom 5 fetch zoom-6 tiles
        // and scale them down to fit (minNativeZoom)
        const own = bm.wms ? deaWms(L, bm.wms, Object.assign({}, bm.opts, { minZoom: 5, minNativeZoom: 6 })) : L.tileLayer(bm.url(), bm.opts);
        const st = (status.basemaps[bm.name] = { loaded: 0, errors: 0 });
        own.on('tileload', () => { st.loaded++; st.streak = 0; status.tilesLoaded++; });
        own.on('tileerror', () => {
          st.errors++; status.tileErrors++;
          // imagery services throttle under load; say something instead of
          // leaving a silently dark map ("satellite island")
          st.streak = (st.streak || 0) + 1;
          if (st.streak === 8 && status.basemap === bm.name) {
            say('Basemap tiles are failing to load (the imagery service may be busy). Pan slightly, reload, or pick another basemap in Layers.', { error: true });
            probeBasemapFailover(bm.name);
          }
        });
        // below zoom 5 (whole-country view), Esri imagery underneath shows
        let layer = bm.wms
          ? L.featureGroup([L.tileLayer(BASEMAPS[0].url(), Object.assign({}, BASEMAPS[0].opts, { zIndex: 0 })), own])
          : own;
        if (bm.labels) {   // place and street names in their own layer over the base
          bm.labelLayer = L.tileLayer(bm.labels(), Object.assign({}, bm.opts, { attribution: '', zIndex: 2 }));
          layer = L.featureGroup([own, bm.labelLayer]);
          bm.baseLayer = own;
        }
        layers[bm.name] = layer;
        bm.layer = layer;
      }
      let saved = null;
      try { saved = localStorage.getItem(BASEMAP_KEY); } catch (e) { /* storage blocked */ }
      const first = layers[saved] ? saved : BASEMAPS[0].name;
      layers[first].addTo(m);
      // the one that follows light/dark mode (base + labels)
      const streets = BASEMAPS.find((b) => b.name === 'Streets');
      state.tiles = streets && streets.baseLayer; state.tileLabels = streets && streets.labelLayer;
      status.basemap = first;
      status.overlays = {};
      const overlays = {};
      for (const o of NATIONAL_OVERLAYS) overlays[o.name] = makeWmsOverlay(L, o);
      for (const o of STATE_OVERLAYS) { const l = makeStateOverlay(o); if (l) overlays[o.name] = l; }
      for (const o of COUNCIL_OVERLAYS) { const l = makeCouncilOverlay(o); if (l) overlays[o.name] = l; }
      await loadCouncilImages();
      for (const o of OVERLAYS) { const layer = makeOverlay(o); if (layer) overlays[o.name] = layer; }
      overlays['Victorian recorded floods (state)'] = L.tileLayer.wms('https://opendata.maps.vic.gov.au/geoserver/wms', {
        layers: VIC_LAYER, format: 'image/png', transparent: true, opacity: 0.55, zIndex: 4,
        attribution: 'Victorian flood history &copy; State of Victoria (DEECA), CC BY 4.0',
      });
      const fhLayers = floodHubOverlays(L);
      Object.assign(overlays, fhLayers);
      const fh = state.floodhub;
      const alerting = fh && fh.configured && (((fh.flashFloodEvents || []).length > 0)
        || (fh.gauges || []).some((g) => g.status && sev(g.status.severity).rank >= 2));
      if (alerting) Object.values(fhLayers).forEach((l) => l.addTo(m));
      // Road impact lines are a view toggle, not a scenario input: whatever
      // scenario is active redraws them (renderImpact), and the layer stays
      // on across scenario changes like any other overlay. Off by default so
      // a freshly loaded map isn't covered in red/orange lines before the
      // user asks for them.
      roadsLayer = L.layerGroup();
      overlays['Flooded (red) and cut-off (orange) roads'] = roadsLayer;
      buildLayerLists(m, layers, overlays, first);
      m.on('overlayadd overlayremove zoomend', renderOverlayLegend);
      // the Layers checkboxes add layers directly (layeradd, not overlayadd)
      m.on('layeradd', (e) => { if (e.layer === roadsLayer) roadsLayerOn(); });
      m.on('zoomend', syncLayerLists);
      // smooth raster scaling while any zoom motion runs (wheel gesture or
      // animated zoom), crisp pixelated cells at rest — see styles.css
      m.on('zoomstart', () => m.getContainer().classList.add('flood-zooming'));
      m.on('zoomend', () => m.getContainer().classList.remove('flood-zooming'));
      // from street level (z15+) a 30 m cell is a big square: scale the
      // rasters smoothly there so the shoreline is soft; crisp cells below
      const syncSmooth = () => m.getContainer().classList.toggle('flood-smooth', m.getZoom() >= 15);
      m.on('zoomend', syncSmooth); syncSmooth();
      m.on('moveend', () => scheduleFine());
      m.on('zoomend', declutterPins);
      m.on('layeradd layerremove', syncLayerLists);
      window.__floodTestZoom = (lat, lng, z) => { m.setView([lat, lng], z, { animate: false }); };   // returns nothing: a Leaflet map can't be serialised by the test driver
      // simulate a tap on the map (not on a marker) at a place, for tests
      window.__floodTapAt = (lat, lng) => m.fire('click', { latlng: L.latLng(lat, lng) });
      window.__floodZoom = () => m.getZoom();
      window.__floodSetOverlay = (name, on) => {
        const l = layerRegistry.overlays[name];
        if (!l) return false;
        if (on) l.addTo(m); else m.removeLayer(l);
        renderOverlayLegend();
        return true;
      };
      m.on('baselayerchange', (e) => {
        status.basemap = e.name;
        try { localStorage.setItem(BASEMAP_KEY, e.name); } catch (err) { /* storage blocked */ }
        basemapChanged();
      });
      // for the automated browser check
      window.__floodSetBasemap = (name) => setBasemap(m, layers, name);
      L.control.scale({ imperial: false }).addTo(m);
      // phones: the credit line folds into an (i) button so it doesn't run under the key
      if (window.matchMedia('(max-width: 760px)').matches && m.attributionControl) {
        const ac = m.attributionControl.getContainer();
        ac.classList.add('attr-fold');
        ac.addEventListener('click', () => ac.classList.toggle('open'));
      }
      m.on('click', onGeoClick);
      // keyboard: with the map focused, Enter does what a click at the
      // centre of the map would (look at that spot, or pick that place),
      // and while choosing an area, Enter studies the area in view
      const box = m.getContainer();
      box.setAttribute('aria-label', 'Map. Arrow keys move, plus and minus zoom, Enter looks at the spot in the middle of the map.');
      box.setAttribute('aria-describedby', 'mapKeysHint');
      box.addEventListener('keydown', (e) => {
        if (e.target !== box || (e.key !== 'Enter' && e.key !== ' ')) return;
        e.preventDefault();
        if (studyDrag.on) {
          const b = m.getBounds().pad(-0.1);
          setStudyMode(false);
          studyArea(b);
          return;
        }
        onGeoClick({ latlng: m.getCenter(), containerPoint: m.getSize().divideBy(2) });
      });
      m.on('moveend', () => saveSessionSoon());
      wireStudy();
      m.on('mousemove', onGeoMove);
      m.on('locationfound', onLocated);
      m.on('locationerror', (e) => { say(`Couldn’t get your location: ${e.message}`, { error: true }); });
      state.lmap = m;
    }
    if (state.areaMeta && !state.areaMeta.national && nat.data) addNationalLayers(state.lmap);
    state.lmap.invalidateSize();
    if (fit) state.lmap.fitBounds(bounds);
    status.mode = 'map';
    return true;
  }


  // Fluid wheel / trackpad zoom. Leaflet's own wheel zoom jumps in animated
  // steps; this eases the zoom toward a target every frame, keeping the
  // point under the cursor still (the approach of Leaflet.SmoothWheelZoom).
  // Leaflet positions image overlays on rounded pixel coordinates (and the
  // smooth wheel zoom below renders the ground at sub-pixel positions), so
  // rasters snapped around by up to a pixel on every wheel frame — visible
  // as a wobble of the flood cells against the basemap. Derive the image
  // geometry the way the tile pane does: projected corner minus pixel
  // origin, unrounded; mirror the unrounded math in the zoom-animation
  // path so controlled zooms (buttons, double-tap, flyTo) track too.
  let subpixelImageOverlayClass = null;
  function subpixelImageOverlay(...args) {
    const L = window.L;
    if (!subpixelImageOverlayClass) {
      subpixelImageOverlayClass = L.ImageOverlay.extend({
        _reset() {
          const map = this._map, image = this._image;
          if (!map || !image) return;
          const origin = map.getPixelOrigin();
          const nw = map.project(this._bounds.getNorthWest())._subtract(origin);
          const se = map.project(this._bounds.getSouthEast())._subtract(origin);
          L.DomUtil.setPosition(image, nw);
          image.style.width = `${se.x - nw.x}px`;
          image.style.height = `${se.y - nw.y}px`;
        },
        _animateZoom(e) {
          const map = this._map;
          const topLeft = map.project(e.center, e.zoom)
            ._subtract(map.getSize()._divideBy(2))
            ._add(map._getMapPanePos());
          L.DomUtil.setTransform(this._image,
            map.project(this._bounds.getNorthWest(), e.zoom)._subtract(topLeft),
            map.getZoomScale(e.zoom));
        },
      });
    }
    return new subpixelImageOverlayClass(...args);
  }

  // An image overlay whose element is a canvas: pixels are put straight on
  // it (no PNG encode and decode), positioned like subpixelImageOverlay.
  let fineCanvasOverlayClass = null;
  // Allocate through the canvas so WebKit receives its own pixel storage,
  // including when input comes from a worker or WebAssembly memory.
  function canvasPixels(ctx, rgba, w, h) {
    if (!Number.isSafeInteger(w) || !Number.isSafeInteger(h) || w <= 0 || h <= 0) {
      throw new RangeError('Raster dimensions must be positive integers');
    }
    const src = rgba && rgba.data ? rgba.data : rgba;
    if (!src || src.length !== w * h * 4) {
      throw new RangeError(`Raster needs ${w * h * 4} RGBA values; received ${src && src.length}`);
    }
    const img = ctx.createImageData(w, h);
    img.data.set(src);
    return img;
  }

  function fineCanvasOverlay(bounds, options) {
    const L = window.L;
    if (!fineCanvasOverlayClass) {
      subpixelImageOverlay(BLANK, bounds);   // makes the base class
      fineCanvasOverlayClass = subpixelImageOverlayClass.extend({
        _initImage() {
          const c = this._image = L.DomUtil.create('canvas', `leaflet-image-layer ${this._zoomAnimated ? 'leaflet-zoom-animated' : ''} ${this.options.className || ''}`);
          c.onselectstart = L.Util.falseFn; c.onmousemove = L.Util.falseFn;
          if (this.options.zIndex != null) this._updateZIndex();
        },
        setUrl() { return this; },
        setPixels(rgba, w, h) {
          if (!this._image) this._initImage();
          const c = this._image;
          if (c.width !== w || c.height !== h) { c.width = w; c.height = h; }
          const ctx = c.getContext('2d');
          ctx.putImageData(canvasPixels(ctx, rgba, w, h), 0, 0);
          this[PIXELS_DRAWN] = true;
          return this;
        },
      });
    }
    return new fineCanvasOverlayClass(BLANK, bounds, options);
  }

  function enableSmoothWheelZoom(L, map) {
    const el = map.getContainer();
    let goal = null, raf = 0, endT = 0, mouse = null, anchor = null, moved = false;
    const PX_PER_LEVEL = 260;   // wheel pixels for one zoom level
    // Leaflet rounds the pixel origin to whole pixels (_getNewPixelOrigin
    // ends in _round), which quantises the camera while we drive _move every
    // frame at fractional zooms — the whole map jitters by a pixel. Lift the
    // rounding for the gesture, during zoom animations, and for the tile
    // pane's own translate (GridLayer._setZoomTransform also ends in
    // .round(), which made tiles snap a pixel against the sub-pixel camera —
    // the basemap wobbled just like the raster overlays did). At rest every
    // value comes out whole anyway, so resting maps stay pixel-crisp.
    const mapProto = Object.getPrototypeOf(map);
    const stockOrigin = mapProto._getNewPixelOrigin;
    let subpixel = false;
    map._getNewPixelOrigin = function (center, zoom) {
      if (!(subpixel || this._animatingZoom)) return stockOrigin.call(this, center, zoom);
      const viewHalf = this.getSize()._divideBy(2);
      return this.project(center, zoom)._subtract(viewHalf)._add(this._getMapPanePos());
    };
    function subpixelOrigin(on) {
      subpixel = on;
    }
    if (!L.GridLayer.prototype.__subpixelTransform) {
      L.GridLayer.prototype.__subpixelTransform = true;
      L.GridLayer.prototype._setZoomTransform = function (level, center, zoom) {
        const map = this._map;
        const scale = map.getZoomScale(zoom, level.zoom);
        const translate = level.origin.multiplyBy(scale)
          .subtract(map._getNewPixelOrigin(center, zoom));
        if (L.Browser.any3d) L.DomUtil.setTransform(level.el, translate, scale);
        else L.DomUtil.setPosition(level.el, translate);
      };
    }
    // Numbered pins wobbled too: Marker.update() derives its position from
    // latLngToLayerPoint, which rounds the projected point to whole pixels,
    // and it runs on every 'zoom' tick of the gesture — the pins snapped
    // around a pixel while the ground moved smoothly underneath. Keep the
    // icon transform unrounded (z-index must stay an integer, though).
    if (!L.Marker.prototype.__subpixelPos) {
      L.Marker.prototype.__subpixelPos = true;
      const setMarkerPos = (marker, pos) => {
        if (marker._icon) L.DomUtil.setPosition(marker._icon, pos);
        if (marker._shadow) L.DomUtil.setPosition(marker._shadow, pos);
        marker._zIndex = Math.round(pos.y + (marker.options.zIndexOffset || 0));
        marker._resetZIndex();
      };
      L.Marker.prototype.update = function () {
        if (this._icon && this._map) {
          const map = this._map;
          setMarkerPos(this, map.project(map.wrapLatLng(this._latlng))._subtract(map.getPixelOrigin()));
        }
        return this;
      };
      L.Marker.prototype._animateZoom = function (opt) {
        if (this._icon && this._map) {
          setMarkerPos(this, this._map._latLngToNewLayerPoint(this._latlng, opt.zoom, opt.center));
        }
      };
    }
    function frame() {
      const z = map.getZoom();
      let next = z + (goal - z) * 0.28;
      if (Math.abs(goal - next) < 0.002) next = goal;
      const delta = mouse.subtract(map.getSize().divideBy(2));
      const center = map.unproject(map.project(anchor, next).subtract(delta), next);
      if (!moved) { map._moveStart(true, false); moved = true; }
      map._move(center, next);
      if (next !== goal) raf = requestAnimationFrame(frame);
      else raf = 0;
    }
    function finish() {
      if (raf) { endT = setTimeout(finish, 60); return; }
      goal = null;
      if (moved) map._moveEnd(true);
      subpixelOrigin(false);
      moved = false;
    }
    L.DomEvent.on(el, 'wheel', (e) => {
      L.DomEvent.preventDefault(e);
      L.DomEvent.stopPropagation(e);
      if (map._animatingZoom) return;
      const px = e.deltaMode === 1 ? e.deltaY * 40 : e.deltaMode === 2 ? e.deltaY * 800 : e.deltaY;
      const pinch = e.ctrlKey;           // trackpad pinch arrives as ctrl+wheel
      if (goal == null) {
        map.stop();
        subpixelOrigin(true);
        goal = map.getZoom();
      }
      mouse = map.mouseEventToContainerPoint(e);
      anchor = map.containerPointToLatLng(mouse);
      goal = Math.max(map.getMinZoom(), Math.min(Math.min(map.getMaxZoom(), 20), goal - px / (pinch ? 100 : PX_PER_LEVEL)));
      if (!raf) raf = requestAnimationFrame(frame);
      clearTimeout(endT);
      endT = setTimeout(finish, 180);
    });
    status.smoothWheel = true;
  }

  function finePointer() {
    try { return window.matchMedia('(pointer: fine)').matches; } catch (e) { return true; }
  }

  // Basemap radios and overlay checkboxes in the Layers panel
  let layerRegistry = null;
  function setBasemap(m, layers, name) {
    if (!layers[name]) return;
    Object.values(layers).forEach((l) => m.hasLayer(l) && m.removeLayer(l));
    layers[name].addTo(m);
    // only the base goes to the back: a labels layer stays over it
    const back = (BASEMAPS.find((b) => b.name === name) || {}).baseLayer || layers[name];
    if (back.bringToBack) back.bringToBack();
    status.basemap = name;
    try { localStorage.setItem(BASEMAP_KEY, name); } catch (err) { /* storage blocked */ }
    syncLayerLists();
    basemapChanged();
  }

  function probeBasemapFailover(fromName) {
    const reg = layerRegistry;
    if (!reg) return;
    const notice = document.getElementById('basemapNotice');
    if (!notice) return;
    notice.hidden = true;
    const candidates = Object.keys(reg.layers).filter((n) => n !== fromName);
    // try to fetch a cheap low-zoom tile from each alternative
    (async () => {
      let best = null;
      for (const name of candidates) {
        const bm = BASEMAPS.find((b) => b.name === name);
        if (!bm || bm.wms) { best = name; break; } // wms/DEA usually reachable
        try {
          const url = bm.url().replace('{z}', '3').replace('{y}', '4').replace('{x}', '5');
          const r = await fetch(url, { method: 'HEAD', cache: 'no-store', signal: AbortSignal.timeout(4000) });
          if (r.ok) { best = name; break; }
        } catch (e) { /* try next */ }
      }
      if (!best) return;
      notice.innerHTML = `Tiles are failing on <strong>${escapeHtml(fromName)}</strong>. <button type="button" class="btn small" id="bmFailoverBtn">Switch to ${escapeHtml(best)}</button>`;
      notice.hidden = false;
      const btn = document.getElementById('bmFailoverBtn');
      if (btn) btn.addEventListener('click', () => {
        setBasemap(reg.m, reg.layers, best);
        notice.hidden = true;
        say(`Switched to ${best}.`);
      }, { once: true });
    })();
  }
  function layerSection(name) {
    if (name === 'Flooded (red) and cut-off (orange) roads') return 'model';
    if ([...OVERLAYS, ...COUNCIL_OVERLAYS].some((o) => o.name === name)) return 'council';
    if ([...NATIONAL_OVERLAYS, ...STATE_OVERLAYS].some((o) => o.name === name) || name === 'Victorian recorded floods (state)') return 'mapping';
    return 'live';
  }

  function updateLayerGroupCounts() {
    document.querySelectorAll('#overlayList .layer-group').forEach((group) => {
      const inputs = [...group.querySelectorAll('input[data-layer]')];
      const enabled = inputs.filter((input) => input.checked).length;
      group.querySelector('.layer-group-count').textContent = `${enabled} of ${inputs.length} on`;
    });
  }

  function buildLayerLists(m, layers, overlays, first) {
    layerRegistry = { m, layers, overlays };
    const bl = $('basemapList');
    bl.innerHTML = '';
    Object.keys(layers).forEach((name, i) => {
      const id = 'bm-' + i;
      const lab = document.createElement('label');
      lab.className = 'check';
      lab.innerHTML = `<input type="radio" name="basemap" id="${id}"> ${escapeHtml(name)}`;
      const input = lab.querySelector('input');
      input.checked = name === first;
      input.addEventListener('change', () => input.checked && setBasemap(m, layers, name));
      bl.appendChild(lab);
    });
    const ol = $('overlayList');
    const expanded = new Map([...ol.querySelectorAll('.layer-group')].map((group) => [group.dataset.group, group.open]));
    ol.innerHTML = '';
    const sections = new Map();
    for (const [id, title] of [['live', 'Live conditions'], ['mapping', 'National and state mapping'], ['council', 'Council mapping'], ['model', 'Your flood model']]) {
      if (!Object.keys(overlays).some((name) => layerSection(name) === id)) continue;
      const group = document.createElement('details');
      group.className = 'layer-group'; group.dataset.group = id;
      group.open = expanded.has(id) ? expanded.get(id) : id !== 'council';
      const summary = document.createElement('summary');
      summary.innerHTML = `<span>${title}</span><span class="layer-group-count"></span>`;
      const body = document.createElement('div'); body.className = 'layer-group-body';
      group.append(summary, body); ol.appendChild(group); sections.set(id, body);
    }
    const names = Object.keys(overlays);
    $('overlaySet').hidden = !names.length;
    names.forEach((name, i) => {
      const id = 'ov-' + i;
      const lab = document.createElement('label');
      lab.className = 'check';
      const sourceNote = OVERLAYS.some((o) => o.name === name) ? '<small class="layer-source">Brisbane City Council</small>' : '';
      lab.innerHTML = `<input type="checkbox" id="${id}"> <span class="layer-name">${escapeHtml(name)}${sourceNote}</span>`;
      const input = lab.querySelector('input');
      input.dataset.layer = name;
      const zn = overlays[name].zoomNote;
      let hint = null;
      if (zn) {
        hint = document.createElement('button');
        hint.type = 'button'; hint.className = 'zoom-hint'; hint.hidden = true;
        hint.dataset.min = zn.min; hint.dataset.for = name;
        hint.textContent = `Zoom in to see this layer (${zn.text})`;
        hint.addEventListener('click', () => m.setZoom(zn.min));
      }
      input.checked = m.hasLayer(overlays[name]);
      const stEl = document.createElement('span');
      stEl.className = 'layer-state'; stEl.dataset.for = name;
      lab.appendChild(stEl);
      trackLayer(name, overlays[name]);
      input.addEventListener('change', () => {
        overlays[name].userOn = input.checked;
        if (input.checked) overlays[name].addTo(m); else if (overlays[name] && m.hasLayer(overlays[name])) m.removeLayer(overlays[name]);
        renderOverlayLegend();
        syncLayerLists();
      });
      const body = sections.get(layerSection(name));
      body.appendChild(lab);
      if (hint) body.appendChild(hint);
    });
    updateLayerGroupCounts();
  }

  /* Per-layer feedback in the Layers list: loading, shown, nothing in view,
   * or couldn't load — from the layer's own events (tiles, esri image and
   * feature layers); layers drawn at once just show as on. */
  const layerState = {};
  function setLayerState(name, kind, text) {
    if (kind) layerState[name] = { kind, text }; else delete layerState[name];
    status.layerState = layerState;
    renderLayerStates();
  }
  function renderLayerStates() {
    document.querySelectorAll('#overlayList .layer-state').forEach((el) => {
      const st = layerState[el.dataset.for];
      const l = layerRegistry && layerRegistry.overlays[el.dataset.for];
      const on = l && layerRegistry.m.hasLayer(l);
      el.hidden = !(st && on);
      if (st) { el.textContent = st.text; el.dataset.kind = st.kind; }
    });
  }
  function trackLayer(name, layer) {
    if (!layer || layer._fbWired) return;
    layer._fbWired = true;
    const L = window.L;
    const async = (L.GridLayer && layer instanceof L.GridLayer) || typeof layer.setLayers === 'function' || typeof layer.query === 'function'
      || (layer.getLayers && layer.getLayers().some((c) => L.GridLayer && c instanceof L.GridLayer));
    let ok = 0, bad = 0, slowT = 0;
    const loading = () => {
      ok = 0; bad = 0;
      setLayerState(name, 'loading', 'Loading…');
      clearTimeout(slowT);
      slowT = setTimeout(() => { if ((layerState[name] || {}).kind === 'loading') setLayerState(name, 'loading', 'Still loading (the service is slow)…'); }, 15000);
    };
    const done = () => {
      clearTimeout(slowT);
      const m = layerRegistry && layerRegistry.m;
      if (m && layer.options && layer.options.minZoom && m.getZoom() < layer.options.minZoom) { setLayerState(name, null); return; }   // the zoom hint says it
      if (bad && !ok) { setLayerState(name, 'error', "Couldn't load: the service may be down. Try again later."); return; }
      if (typeof layer.eachFeature === 'function') {
        let n = 0; layer.eachFeature(() => { n++; });
        if (!n) { setLayerState(name, 'empty', 'Nothing mapped in this view'); return; }
      }
      setLayerState(name, 'done', bad ? 'Shown (some parts failed to load)' : 'Shown');
    };
    layer.on('loading', loading);
    layer.on('load', done);
    layer.on('tileload', () => { ok++; });
    layer.on('tileerror requesterror', () => { bad++; });
    layer.on('add', () => {
      if (layer === roadsLayer) return;   // roadsLayerOn reports
      if (async) loading();   // layers drawn at once need no note
    });
    layer.on('remove', () => { clearTimeout(slowT); setLayerState(name, null); });
  }

  // The flooded-roads lines need the impact count (buildings, roads, sites)
  // for the active model: switching the layer on starts it, and the list says
  // what it's doing and what it found.
  const ROADS_NAME = 'Flooded (red) and cut-off (orange) roads';
  function roadsLayerOn() {
    const area = state.areaKey && areaReg.get(state.areaKey);
    if (!area || !state.a) { setLayerState(ROADS_NAME, 'note', 'Needs a flood model: pick a river town or tap the map to model a place first.'); return; }
    if (!area.impact) {
      if (area.impactLoading) return;
      area.impactLoading = true;
      setLayerState(ROADS_NAME, 'loading', 'Fetching roads and buildings for this model…');
      countImpact().finally(() => { area.impactLoading = false; roadsReport(); });
      return;
    }
    renderImpact();
    roadsReport();
  }
  function roadsReport() {
    if (!roadsLayer || !state.lmap || !state.lmap.hasLayer(roadsLayer)) return;
    const s = status.impact;
    if (!s) { setLayerState(ROADS_NAME, 'note', 'Needs a flood model: pick a river town or tap the map to model a place first.'); return; }
    if (s.loading) return;
    if (s.error) { setLayerState(ROADS_NAME, 'error', `Couldn't fetch roads: ${s.error}`); return; }
    const km = (v) => (v < 1 ? `${Math.round(v * 1000)} m` : `${v.toFixed(1)} km`);
    setLayerState(ROADS_NAME, 'done', s.cutKm > 0 ? `${km(s.cutKm)} of road under water (red)${s.isolated ? `; ${s.isolated.toLocaleString('en-AU')} dry buildings cut off (orange)` : ''}` : 'No roads under water at this level');
  }

  function registerOverlay(name, layer) {
    if (!layerRegistry || layerRegistry.overlays[name] === layer) return;
    layerRegistry.overlays[name] = layer;
    buildLayerLists(layerRegistry.m, layerRegistry.layers, layerRegistry.overlays, status.basemap);
  }

  function syncLayerLists() {
    if (!layerRegistry) return;
    const { m, overlays } = layerRegistry;
    const z = m.getZoom();
    document.querySelectorAll('#overlayList input').forEach((inp) => {
      const l = overlays[inp.dataset.layer];
      if (l) inp.checked = m.hasLayer(l);
    });
    document.querySelectorAll('#overlayList .zoom-hint').forEach((hint) => {
      const l = overlays[hint.dataset.for];
      hint.hidden = !(l && m.hasLayer(l) && z < +hint.dataset.min);
    });
    document.querySelectorAll('#basemapList input').forEach((inp, i) => {
      inp.checked = Object.keys(layerRegistry.layers)[i] === status.basemap;
    });
    updateLayerGroupCounts();
    renderLayerStates();
  }

  function leaveGeoMode() {
    state.geo = null;
    state.areaKey = null;
    if (areaReg.size) setActiveLayers(null);
    status.mode = 'static';
    $('map').hidden = false;
    $('lmap').hidden = true;
    $('geoControls').hidden = true;
    $('layersStaticNote').hidden = false;
  }


  /* ---------------------------------------------------- modelled areas */
  // Every place modelled on the street map stays there with its own terrain,
  // scenario, flood layer and gauge. One is active at a time: the Scenario
  // panel, profile and stats show that one; tapping inside another makes it
  // active.
  const areaReg = new Map();
  let localCount = 0;
  let geoToken = 0;   // bumped whenever the active area changes
  const CTL_KEYS = ['gaugeLevel', 'bayLevel', 'slr', 'extra', 'grad', 'streamArea', 'floodType', 'rainMm', 'stormHours', 'ground', 'pipes', 'warming'];

  function areaFields() {
    return {
      grid: state.grid, areaId: state.areaId, areaMeta: state.areaMeta, eventsApply: state.eventsApply,
      streamAreaKm2: state.streamAreaKm2, a: state.a, gauge: state.gauge, base: state.base, run: state.run,
      terrain: state.terrain, geo: state.geo, controls: state.controls || [], leveeMask: state.leveeMask || null, gateCells: state.gateCells || [],
      ctl: Object.fromEntries(CTL_KEYS.map((k) => [k, ctl[k].value])),
      gmin: ctl.gaugeLevel.min, gmax: ctl.gaugeLevel.max,
      levelHint: $('levelHint').hidden ? null : $('levelHint').textContent,
    };
  }

  // Saving happens as an area is left. An inactive area keeps only its
  // terrain, settings and the flood picture on the map; the flow analysis
  // and flood grids (most of the memory) are rebuilt when it is reopened,
  // so any number of areas can stay on the map.
  function saveActive() {
    const area = state.areaKey && areaReg.get(state.areaKey);
    if (area) Object.assign(area, areaFields(), { a: null, base: null, run: null, terrain: null });
  }

  function ensureArea(key) {
    const L = window.L, m = state.lmap;
    let area = areaReg.get(key);
    const b = state.areaMeta.bounds_lonlat;
    const bounds = L.latLngBounds([b[1], b[0]], [b[3], b[2]]);
    if (!area) {
      const fromReport = state.areaMeta.reportId && reports.find((r) => r.id === state.areaMeta.reportId);
      const fromPin = state.areaMeta.pinN != null && pins.find((x) => x.n === state.areaMeta.pinN);
      area = { key, name: state.areaMeta.name || key, n: state.areaMeta.keepN != null ? state.areaMeta.keepN : fromReport ? fromReport.n : fromPin ? fromPin.n : nextNumber(), reportId: state.areaMeta.reportId || null };
      area.overlay = fineCanvasOverlay(bounds, {
        opacity: parseFloat($('floodOpacity').value) / 100, className: 'flood-layer', zIndex: 6,
      }).addTo(m);
      // static terrain shading under the flood raster (never re-encoded per
      // run or timeline step); blank until the first shaded render
      area.relief = subpixelImageOverlay(BLANK, bounds, {
        opacity: parseFloat($('floodOpacity').value) / 100, interactive: false, className: 'flood-layer', zIndex: 5,
      }).addTo(m);
      area.reliefShade = null;
      area.reliefWas = false;
      area.outline = L.rectangle(bounds, { color: '#c66f1d', weight: 1.5, dashArray: '5 5', fill: false, interactive: false }).addTo(m);
      area.edgeGroup = L.layerGroup().addTo(m);   // the sides the flood runs into (updateEdgeCue)
      area.marker = L.marker(bounds.getCenter(), { icon: numIcon(area.n, AREA_COLOR, true), keyboard: true, title: `${area.n}. ${area.name}: flood model`, alt: `${area.n}. ${area.name}`, zIndexOffset: 900 }).addTo(m);
      area.marker.bindTooltip(`${area.n}. ${area.name}: flood model gauge`, { direction: 'top', offset: [0, -12] });
      area.marker.on('click', () => selectPlace(area.n));
      areaReg.set(key, area);
      selectedNum = area.n;
      if (hiddenNums.has(area.n)) setPlaceHidden(area.n, false);
    } else {
      area.overlay.setBounds(bounds);
      area.relief.setBounds(bounds);
    }
    Object.assign(area, areaFields());
    return area;
  }

  const AREA_COLOR = '#c66f1d';
  function setActiveLayers(area) {
    state.overlay = area ? area.overlay : null;
    state.gaugeMarker = area ? area.marker : null;
    for (const a of areaReg.values()) {
      const on = a === area;
      a.outline.setStyle({ color: on ? AREA_COLOR : '#8a6a4a', weight: 1, opacity: on ? 0.55 : 0.45, dashArray: '5 5' });
      if (!on && a.edgeGroup) a.edgeGroup.clearLayers();
      a.marker.setIcon(numIcon(a.n, on ? AREA_COLOR : '#8a6a4a', on));
      if (!on) { a.reliefShade = null; }   // freed; re-encoded on activation
    }
    reports.forEach(refreshReportLink);
    renderPlaces();
  }

  function areaByNumber(n) { return Array.from(areaReg.values()).find((a) => a.n === n) || null; }
  function areaForReport(r) { return Array.from(areaReg.values()).find((a) => a.reportId === r.id) || null; }

  // Show or hide everything with this number: the area's flood layer, outline
  // and gauge, and the report's pin. Hidden areas keep their scenario.
  function setPlaceHidden(n, hidden) {
    const m = state.lmap;
    if (!m) return;
    if (hidden) hiddenNums.add(n); else hiddenNums.delete(n);
    const area = areaByNumber(n);
    if (area) [area.overlay, area.outline, area.edgeGroup, area.marker].forEach((l) => l && m && (hidden ? m.removeLayer(l) : l.addTo(m)));
    reports.filter((r) => r.n === n && r.pin).forEach((r) => (hidden ? (r.pin && m.removeLayer(r.pin)) : (r.pin && r.pin.addTo(m))));
    pins.filter((p) => p.n === n && p.marker).forEach((p) => (hidden ? (p.marker && m.removeLayer(p.marker)) : (p.marker && p.marker.addTo(m))));
    if (hidden && area && area.key === state.areaKey) say(`${n}. ${area.name} is hidden. Its scenario is kept; show it again from Places.`);
    scheduleFine();   // the 5 m patch follows its place's flood layer
    reports.forEach(refreshReportLink);
    renderPlaces();
  }
  window.__floodSetPlaceHidden = setPlaceHidden;

  function refreshReportLink(r) {
    const box = r.el.querySelector('.js-link');
    if (!box) return;
    const area = areaForReport(r);
    const btn = r.el.querySelector('.js-model');
    if (btn) btn.textContent = area ? 'Open its flood scenario' : (r.kind === 'tide' ? 'Model coastal flooding here' : 'Model flooding here');
    if (!area) { box.innerHTML = ''; return; }
    const hidden = hiddenNums.has(r.n);
    box.innerHTML = `<div class="link-row"><span class="pin-num" style="background:${AREA_COLOR}">${r.n}</span>
      <span>Flood model ${hidden ? '(hidden)' : 'on the map'}</span></div>`;
  }

  function activateArea(key, opts) {
    resetInertial();
    const area = areaReg.get(key);
    if (!area) return false;
    geoToken++;          // abandon any area still opening
    if (state.areaKey !== key) saveActive();
    if (hiddenNums.has(area.n)) setPlaceHidden(area.n, false);
    Object.assign(state, {
      grid: area.grid, areaId: area.areaId, areaMeta: area.areaMeta, eventsApply: area.eventsApply,
      streamAreaKm2: area.streamAreaKm2, a: area.a, gauge: area.gauge, base: area.base, run: area.run,
      terrain: area.terrain, geo: area.geo, areaKey: key, pendingGeo: false, controls: area.controls || [], leveeMask: area.leveeMask || null, gateCells: area.gateCells || [],
    });
    status.area = area.areaId === 'local' ? key : area.areaId;
    CTL_KEYS.forEach((k) => { ctl[k].value = area.ctl[k]; });
    ctl.gaugeLevel.min = area.gmin; ctl.gaugeLevel.max = area.gmax;
    ctl.gaugeLevel.value = area.ctl.gaugeLevel;
    $('levelHint').hidden = !area.levelHint;
    if (area.levelHint) $('levelHint').textContent = area.levelHint;
    setActiveLayers(area);
    if (!state.lmap || $('lmap').hidden) {
      const b = area.areaMeta.bounds_lonlat;
      enterGeoMode(b, { fit: !!(opts && opts.fit) });
    } else if (opts && opts.fit) {
      const b = area.areaMeta.bounds_lonlat;
      state.lmap.fitBounds([[b[1], b[0]], [b[3], b[2]]]);
    }
    $('area').value = key;
    renderEvents();
    showScenarioEmpty(false);
    syncOutputs();
    renderInfo();
    renderNotice();
    if (!state.a && state.grid) {
      // reopened: rebuild the flow analysis (in the background) and rerun
      // its scenario; the flood picture stays on the map meanwhile
      const grid = state.grid;
      setBusy(true, 'Reopening this model…');
      state.ready = analyseAsync(grid, { streamAreaKm2: state.streamAreaKm2 }).then((a) => {
        if (state.areaKey !== key || state.grid !== grid) return;
        state.a = a;
        state.terrain = terrainRGBA(a);
        const ar = areaReg.get(key);   // the 3D view reads entries directly
        if (ar) { ar.a = a; ar.terrain = state.terrain; }
        state.base = null;
        runScenario();
        state.edges = floodEdges(a, state.run);
        renderEdgeNote();
      }).finally(() => setBusy(false));
    } else {
      state.ready = Promise.resolve();
      if (state.run) { drawStats(scenario()); drawProfile(scenario()); }
    }
    state.edges = state.run && state.a ? floodEdges(state.a, state.run) : [];
    renderEdgeNote();
    renderAreaList();
    return true;
  }

  function deactivate() {
    resetInertial();
    geoToken++;
    state.pendingGeo = false;
    saveActive();
    state.areaKey = null;
    setActiveLayers(null);
    renderAreaList();
  }

  function removeArea(key, opts) {
    const area = areaReg.get(key);
    if (!area) return;
    const m = state.lmap;
    [area.overlay, area.outline, area.edgeGroup, area.marker].forEach((l) => l && m && m.removeLayer(l));
    if (fine && fine.coarse === area.overlay) clearFine();   // its 5 m patch goes with it
    if (area.overlay && area.overlay._floodUrl) URL.revokeObjectURL(area.overlay._floodUrl);
    areaReg.delete(key);
    if (!reports.some((r) => r.n === area.n)) hiddenNums.delete(area.n);
    reports.forEach(refreshReportLink);
    const op = $('area').querySelector(`option[value="${CSS.escape(key)}"]`);
    if (op && area.areaMeta && area.areaMeta.local) op.remove();
    if ($('modelledGroup') && !$('modelledGroup').children.length) $('modelledGroup').hidden = true;
    if (state.areaKey === key) {
      state.areaKey = null;
      if (!(opts && opts.quiet)) { $('area').value = 'australia'; enterNational({ fit: false }); }
    }
    renderAreaList();
  }

  function areaAt(latlng) {
    const inside = (a) => !hiddenNums.has(a.n) && a.geo && latlng.lat <= a.geo.north && latlng.lat >= a.geo.south
      && latlng.lng >= a.geo.west && latlng.lng <= a.geo.east;
    const active = state.areaKey && areaReg.get(state.areaKey);
    if (active && inside(active)) return active;
    return Array.from(areaReg.values()).reverse().find(inside) || null;
  }

  function renderAreaList() { renderPlaces(); }

  // One row per number: its report, its flood model, a pinned spot, or a mix.
  // Choosing a row does exactly what tapping that number on the map does
  // (selectPlace); the icons open its report and zoom to it.
  let selectedNum = null;
  let scenarioEmpty = false;   // the Scenario panel has no flood model to show
  function placeLatLon(n) {
    const a = areaByNumber(n), r = reports.find((x) => x.n === n), pin = pins.find((x) => x.n === n);
    if (r) return [r.lat, r.lon];
    if (pin) return [pin.lat, pin.lon];
    if (a) { const b = a.areaMeta.bounds_lonlat; return [(b[1] + b[3]) / 2, (b[0] + b[2]) / 2]; }
    return null;
  }

  // The one way a numbered place is chosen, from its map pin or its row:
  // its flood scenario becomes active and its report shows (on a phone,
  // the scenario wins); a bare pin just becomes the selected row.
  function selectPlace(n, opts) {
    const a = areaByNumber(n), r = reports.find((x) => x.n === n);
    const fromList = !!(opts && opts.fromList);
    selectedNum = n;
    if (hiddenNums.has(n)) setPlaceHidden(n, false);
    if (r && !(a && isPhone())) showReport(r);
    if (a) { activateArea(a.key, { fit: fromList }); openPanel('panel-scenario'); }
    else {
      // not modelled yet: the Scenario panel offers to model it
      if (state.areaKey) deactivate();
      showScenarioEmpty(true);
      if (!isPhone()) setScenarioCollapsed(false);
      else if (!r) openPanel('panel-scenario');
    }
    if (fromList && !a && state.lmap) {
      const ll = placeLatLon(n);
      if (ll && !state.lmap.getBounds().pad(-0.1).contains(ll)) state.lmap.panTo(ll);
    }
    setPlacesCollapsed(false);
    renderPlaces();
  }
  window.__floodSelectPlace = (n) => selectPlace(n, { fromList: true });

  const ICON_REPORT = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M7 3h7l5 5v13H7z"/><path d="M14 3v5h5M10 13h6M10 17h6"/></svg>';
  const ICON_ZOOM = '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="11" cy="11" r="6"/><path d="m20 20-4.5-4.5M11 8v6M8 11h6"/></svg>';

  function renderPlaces() {
    const box = $('areaList');
    if (!box) return;
    const nums = Array.from(new Set([...reports.map((r) => r.n), ...Array.from(areaReg.values()).map((a) => a.n), ...pins.map((p) => p.n)])).sort((a, b) => a - b);
    status.areas = Array.from(areaReg.keys());
    $('placesCount').hidden = !nums.length;
    $('placesCount').textContent = String(nums.length);
    $('placesHeadCount').hidden = !nums.length;
    $('placesHeadCount').textContent = String(nums.length);
    const act = state.areaKey && areaReg.get(state.areaKey);
    $('placesNow').textContent = act ? `Scenario: ${act.n}. ${act.name}` : (activeReport ? `Report: ${activeReport.n}. ${activeReport.name || ''}` : '');
    renderScenarioTitle();
    if (!nums.length) {
      box.innerHTML = `<div class="places-empty"><p><strong>No places yet.</strong></p>
        <p class="hint">Tap a flood gauge, tide gauge or dam on the map for a report, or tap anywhere to add a place or model flooding there. Each place gets a number that matches its pin on the map.</p></div>${propertyChecksHtml()}${studiesHtml()}`;
      wireCheckControls(box);
      wireStudyRows(box);
      return;
    }
    if (!nums.includes(selectedNum)) selectedNum = act ? act.n : null;
    status.selectedPlace = selectedNum;
    // places a study area brought in are listed under it, not here
    const inStudy = new Set(studies.flatMap((st) => st.nums || []));
    const rows = nums.filter((n) => !inStudy.has(n)).map(placeRowHtml).join('');
    // the how-it-works text is shown the first time places appear, then
    // folds behind a "?" (remembered in this browser)
    if (!placesHelpSeen) { placesHelpOpen = true; placesHelpSeen = true; try { localStorage.setItem(HELP_KEY, '1'); } catch (e) { /* storage blocked */ } }
    box.innerHTML = `${rows ? `<ul class="places">${rows}</ul>` : ''}
      ${placesHelpOpen ? '<p class="hint">Choosing a place here works like tapping its number on the map. Your places are kept in this browser for next time.</p>' : ''}
      <p class="hint places-foot"><button type="button" class="link-btn" id="placesHelp" aria-expanded="${placesHelpOpen}" aria-label="How places work">? How places work</button> · <button type="button" class="link-btn" id="clearPlaces">Clear all places</button></p>${propertyChecksHtml()}${studiesHtml()}`;
    $('placesHelp').addEventListener('click', () => { placesHelpOpen = !placesHelpOpen; renderPlaces(); });
    wireCheckControls(box);
    wireStudyRows(box);
    $('clearPlaces').addEventListener('click', () => { if (window.confirm('Remove all places, reports and flood models from the map?')) clearAllPlaces(); });
    saveSessionSoon();
    box.querySelectorAll('[data-num]').forEach((b) => b.addEventListener('click', () => selectPlace(+b.dataset.num, { fromList: true })));
    box.querySelectorAll('[data-act]').forEach((b) => b.addEventListener('click', () => placeAction(b.dataset.act, +b.dataset.n)));
    box.querySelectorAll('[data-drop]').forEach((b) => b.addEventListener('click', () => { dropPlace(+b.dataset.drop); renderPlaces(); }));
  }
  // one numbered place (report, pinned place and/or flood model) as a list row
  function placeRowHtml(n) {
    const r = reports.find((x) => x.n === n), a = areaByNumber(n), pin = pins.find((x) => x.n === n);
    const hidden = hiddenNums.has(n), isActive = a && a.key === state.areaKey, sel = selectedNum === n;
    const name = (r && r.name) || (pin && pin.name) || (a && a.name) || `Place ${n}`;
    const tags = [r ? (r.kind === 'storage' ? 'dam report' : r.kind === 'tide' ? 'tide report' : 'gauge report') : null, pin ? 'pinned place' : null, a ? 'flood model' : null].filter(Boolean).join(' + ');
    const color = a ? (isActive ? AREA_COLOR : '#8a6a4a') : r ? (GAUGE_STYLE[r.kind] || GAUGE_STYLE.river).color : PIN_COLOR;
    const repLabel = r ? `Open the report for ${name}` : `Report on the gauge or dam nearest ${name}`;
    return `<li class="place${sel ? ' on' : ''}${hidden ? ' off' : ''}">
        <button type="button" class="place-main" data-num="${n}" aria-pressed="${sel}" title="Select ${escapeHtml(name)}">
          <span class="pin-num" style="background:${color}">${n}</span>
          <span class="place-text"><span class="place-name">${escapeHtml(name)}</span><span class="place-tags">${tags}</span></span>
        </button>
        <button type="button" class="icon-btn" data-act="${r ? 'report' : 'nearest'}" data-n="${n}" aria-label="${escapeHtml(repLabel)}" title="${r ? 'Report' : 'Report on nearest gauge'}">${ICON_REPORT}</button>
        <button type="button" class="icon-btn" data-act="zoom" data-n="${n}" aria-label="Zoom to ${escapeHtml(name)}" title="Zoom to">${ICON_ZOOM}</button>
        <button type="button" class="icon-btn" data-drop="${n}" aria-label="Remove ${escapeHtml(name)}" title="Remove">×</button>
      </li>`;
  }
  // remove a numbered place: its report, flood model and pin
  function dropPlace(n) {
    const a = areaByNumber(n);
    reports.filter((r) => r.n === n).forEach(closeReport);
    if (a) removeArea(a.key);
    for (let i = pins.length - 1; i >= 0; i--) if (pins[i].n === n) {
      if (pins[i].marker && state.lmap) state.lmap.removeLayer(pins[i].marker);
      pins.splice(i, 1);
    }
    hiddenNums.delete(n);
    if (selectedNum === n) selectedNum = null;
    for (const st of studies) if (st.nums && st.nums.includes(n)) { st.nums = st.nums.filter((x) => x !== n); saveStudies(); }
  }

  const ICON_RENAME = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 20h4l10-10-4-4L4 16z"/><path d="M13 7l4 4"/></svg>';
  function propertyChecksHtml() {
    if (!propertyChecks.length) return '';
    const rows = propertyChecks.map((c) => `<li class="place">
      <button type="button" class="place-main" data-chk="open" data-id="${escapeHtml(String(c.id))}" title="Re-open the check for ${escapeHtml(c.name)}">
        <span class="pin-num" style="background:${PIN_COLOR}">&#8242;</span>
        <span class="place-text"><span class="place-name">${escapeHtml(c.name)}</span><span class="place-tags">checked ${escapeHtml(c.when)} · ${escapeHtml(c.headline)}${c.snapshot && c.snapshot.arrival && !c.headline.includes(c.snapshot.arrival) ? ` · ${escapeHtml(c.snapshot.arrival)}` : ''}</span></span>
      </button>
      <button type="button" class="icon-btn" data-chk="place" data-id="${escapeHtml(String(c.id))}" aria-label="Add ${escapeHtml(c.name)} as a numbered place" title="Add as a place">${ICON_REPORT}</button>
      <button type="button" class="icon-btn" data-chk="rename" data-id="${escapeHtml(String(c.id))}" aria-label="Rename ${escapeHtml(c.name)}" title="Rename">${ICON_RENAME}</button>
      <button type="button" class="icon-btn" data-chk="drop" data-id="${escapeHtml(String(c.id))}" aria-label="Forget ${escapeHtml(c.name)}" title="Forget">×</button>
    </li>`).join('');
    return `<h3 class="label">Reported properties</h3><ul class="places">${rows}</ul>
      <p class="hint">Properties you have run "Check this property" on, with the last result for the visible scenario. Re-opening re-runs the check.</p>`;
  }
  function wireCheckControls(box) {
    if (!propertyChecks.length) return;
    box.querySelectorAll('[data-chk]').forEach((b) => b.addEventListener('click', () => {
      const c = propertyChecks.find((x) => String(x.id) === b.dataset.id);
      if (!c) return;
      if (b.dataset.chk === 'open') {
        if (state.lmap) state.lmap.setView([c.lat, c.lon], Math.max(state.lmap.getZoom(), 15));
        checkProperty(c.lat, c.lon, c.name);
      } else if (b.dataset.chk === 'place') {
        addPin(c.lat, c.lon, { name: c.name });
      } else if (b.dataset.chk === 'rename') {
        const name = window.prompt('Name this property:', c.name);
        if (name && name.trim()) { c.name = name.trim(); renderPlaces(); saveSessionSoon(); }
      } else if (b.dataset.chk === 'drop') {
        const i = propertyChecks.indexOf(c);
        if (i >= 0) propertyChecks.splice(i, 1);
        renderPlaces();
        saveSessionSoon();
      }
    }));
  }
  function setPlacesCollapsed(collapsed) {
    $('placesCard').classList.toggle('collapsed', collapsed);
    $('placesToggle').setAttribute('aria-expanded', String(!collapsed));
    document.querySelectorAll('[data-places-toggle]').forEach((b) => b.setAttribute('aria-pressed', String(!collapsed)));
    status.placesOpen = !collapsed;
  }
  $('placesToggle').addEventListener('click', () => setPlacesCollapsed(!$('placesCard').classList.contains('collapsed')));
  document.querySelectorAll('[data-places-toggle]').forEach((b) => b.addEventListener('click', () => {
    const collapsed = !$('placesCard').classList.contains('collapsed');
    setPlacesCollapsed(collapsed);
    if (!collapsed && isPhone()) document.querySelectorAll('[data-panel]').forEach((p) => { if (p.dataset.side === 'left') p.hidden = true; });
    syncPanels();
  }));
  document.querySelectorAll('[data-places-open]').forEach((b) => b.addEventListener('click', () => {
    setPlacesCollapsed(false);
    if (isPhone()) document.querySelectorAll('[data-panel]').forEach((p) => { p.hidden = true; });
    syncPanels();
  }));
  window.__floodSetPlacesCollapsed = setPlacesCollapsed;

  function placeAction(act, n) {
    const a = areaByNumber(n), r = reports.find((x) => x.n === n), pin = pins.find((x) => x.n === n);
    if (pin && !r && (act === 'model' || act === 'modelcoast')) {
      selectedNum = n;
      modelHere(pin.lat, pin.lon, { kind: act === 'modelcoast' ? 'coast' : 'river', name: pin.name, pinN: n });
      return;
    }
    if (act === 'nearest') {
      const ll = placeLatLon(n);
      const near = ll && nearestNamed(ll[0], ll[1], 100);
      if (near) { openReport(near.f); if (state.lmap) state.lmap.setView([near.f.geometry.coordinates[1], near.f.geometry.coordinates[0]], Math.max(state.lmap.getZoom(), 11)); }
      else say('No Bureau of Meteorology gauge or dam within 100 km of this place.');
      return;
    }
    if (act === 'report' && r) {
      selectedNum = n;
      showReport(r);
      renderPlaces();
    } else if ((act === 'scenario' || act === 'select') && (a || r || pin)) {
      selectPlace(n, { fromList: true });
    } else if ((act === 'model' || act === 'modelcoast') && r && !a) {
      selectedNum = n;
      const kind = act === 'modelcoast' || (act === 'model' && r.kind === 'tide') ? 'coast' : 'river';
      modelHere(r.lat, r.lon, { kind, name: r.name, reportId: r.id });
    } else if (act === 'zoom' && state.lmap) {
      if (a) { const b = a.areaMeta.bounds_lonlat; state.lmap.fitBounds([[b[1], b[0]], [b[3], b[2]]]); }
      else if (r) state.lmap.setView([r.lat, r.lon], Math.max(state.lmap.getZoom(), 12));
      else if (pin) state.lmap.setView([pin.lat, pin.lon], Math.max(state.lmap.getZoom(), 12));
    }
  }
  window.__floodPlaceAction = placeAction;

  // The Scenario panel follows the selected place: its flood scenario when it
  // has one, otherwise the options to model it.
  function unmodelledSelection() {
    if (selectedNum == null || state.areaKey || areaByNumber(selectedNum)) return null;
    const r = reports.find((x) => x.n === selectedNum), pin = pins.find((x) => x.n === selectedNum);
    return r || pin ? { n: selectedNum, r, pin, name: (r && r.name) || pin.name } : null;
  }

  function renderScenarioTitle() {
    const el = $('scenarioPlace');
    if (!el) return;
    const a = state.areaKey && areaReg.get(state.areaKey), u = unmodelledSelection();
    el.textContent = a ? `${a.n}. ${a.name}` : u ? `${u.n}. ${u.name}: not modelled yet` : '';
    const many = areaReg.size > (a ? 1 : 0);
    $('scenarioPrev').hidden = $('scenarioNext').hidden = !many;
    renderScenarioModel(u);
  }

  function renderScenarioModel(u) {
    const box = $('scenarioModel');
    if (!box) return;
    const show = scenarioEmpty && !!u;
    box.hidden = !show;
    $('scenarioEmpty').hidden = !scenarioEmpty || show;
    status.modelOptions = show ? u.n : null;
    if (!show) { box.innerHTML = ''; return; }
    const coastFirst = u.r && u.r.kind === 'tide';
    const color = u.r ? (GAUGE_STYLE[u.r.kind] || GAUGE_STYLE.river).color : PIN_COLOR;
    const river = `<button type="button" class="btn${coastFirst ? '' : ' primary'}" data-model="model">Model river flooding</button>`;
    const coast = `<button type="button" class="btn${coastFirst ? ' primary' : ''}" data-model="modelcoast">Model coastal flooding</button>`;
    box.innerHTML = `<div class="place-row"><span class="pin-num" style="background:${color}">${u.n}</span><span>${escapeHtml(u.name)}</span></div>
      <p class="hint">Model flooding around this ${u.r ? (u.r.kind === 'storage' ? 'dam' : 'gauge') : 'place'} from Geoscience Australia's elevation data. It keeps number ${u.n}.</p>
      <div class="btns">${coastFirst ? coast + river : river + coast}</div>
      <label class="check"><input type="checkbox" id="lidarPref"${useLidar() ? ' checked' : ''}> Use 5 m LiDAR elevation where it exists (bare earth; slower)</label>`;
    $('lidarPref').addEventListener('change', (e) => { try { localStorage.setItem(LIDAR_PREF, e.target.checked ? 'on' : 'off'); } catch (err) { /* per visit only */ } });
    box.querySelectorAll('[data-model]').forEach((b) => b.addEventListener('click', () => placeAction(b.dataset.model, u.n)));
  }

  window.__floodPlaces = () => Array.from(new Set([...reports.map((r) => r.n), ...Array.from(areaReg.values()).map((a) => a.n), ...pins.map((p) => p.n)])).sort((a, b) => a - b).map((n) => {
    const a = areaByNumber(n), r = reports.find((x) => x.n === n), pin = pins.find((x) => x.n === n);
    return { n, report: !!r, area: !!a, pin: !!pin, hidden: hiddenNums.has(n), onMap: !!(a && state.lmap && state.lmap.hasLayer(a.overlay)), reportName: r && r.name, areaName: a && a.name, pinName: pin && pin.name };
  });

  window.__floodActivateArea = (key) => activateArea(key, { fit: true });
  window.__floodAreaInfo = () => Array.from(areaReg.values()).map((a) => ({
    key: a.key, name: a.name, drawn: overlayDrawn(a.overlay), active: a.key === state.areaKey,
  }));

  function cellLatLng(i) {
    const a = state.a, g = state.geo;
    const x = (i % a.W) + 0.5, y = Math.floor(i / a.W) + 0.5;
    return [g.north - (y / a.H) * (g.north - g.south), g.west + (x / a.W) * (g.east - g.west)];
  }
  function pointInPolygon(lat, lon, rings) {
    if (!Array.isArray(rings) || !rings.length) return true;
    let inside = false;
    for (let r = 0; r < rings.length; r++) {
      const ring = rings[r];
      if (!Array.isArray(ring) || ring.length < 3) continue;
      let c = false;
      for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
        const yi = ring[i][0], xi = ring[i][1];
        const yj = ring[j][0], xj = ring[j][1];
        if (((yi > lat) !== (yj > lat)) && (lon < (xj - xi) * (lat - yi) / (yj - yi) + xi)) c = !c;
      }
      if (r === 0) inside = c; else if (c) inside = false;
    }
    return inside;
  }

  function latLngCell(ll) {
    const a = state.a, g = state.geo;
    const x = Math.floor(((ll.lng - g.west) / (g.east - g.west)) * a.W);
    const y = Math.floor(((g.north - ll.lat) / (g.north - g.south)) * a.H);
    if (x < 0 || y < 0 || x >= a.W || y >= a.H) return null;
    return { x, y, i: y * a.W + x };
  }

  let overlayGen = 0, reliefGen = 0;
  function drawGeoMap() {
    const a = state.a;
    const relief = $('showRelief').checked;
    const area = state.areaKey && areaReg.get(state.areaKey);
    // static relief base, encoded once per analysis and only while active
    if (area && area.relief) {
      const ro = area.relief;
      if (relief && state.terrain) {
        if (area.reliefShade !== state.terrain) {
          area.reliefShade = state.terrain;
          area.reliefWas = true;
          const offR = state.offscreenRelief = state.offscreenRelief || document.createElement('canvas');
          if (offR.width !== a.W || offR.height !== a.H) { offR.width = a.W; offR.height = a.H; }
          offR.getContext('2d').putImageData(new ImageData(new Uint8ClampedArray(state.terrain), a.W, a.H), 0, 0);
          const gen = ++reliefGen;
          offR.toBlob((blob) => {
            if (!blob || gen !== reliefGen) return;
            const url = URL.createObjectURL(blob);
            const old = ro._floodUrl;
            ro._floodUrl = url;
            ro.setUrl(url);
            if (old) setTimeout(() => URL.revokeObjectURL(old), 2000);
          }, 'image/png');
        }
      } else if (area.reliefWas) {
        area.reliefWas = false;
        ro.setUrl(BLANK);
      }
    }
    // dynamic water raster (mostly transparent during timeline playback, so
    // its PNG encodes in a few ms instead of a full opaque grid)
    const { img, count } = composeWater();
    status.floodPixels = relief ? -1 : count;
    const off = state.offscreen;
    off.width = a.W; off.height = a.H;
    off.getContext('2d').putImageData(img, 0, 0);
    const gen = ++overlayGen;
    const ov = state.overlay;
    if (ov && typeof ov.setPixels === 'function') {
      try {
        ov.setPixels(img.data, a.W, a.H);
        status.overlayUpdates++;
      } catch (e) {
        // canvas upload failed (e.g. bad buffer); fall back to PNG encode
        off.toBlob((blob) => {
          if (!blob || gen !== overlayGen) return;
          const url = URL.createObjectURL(blob);
          const old = ov._floodUrl;
          ov._floodUrl = url;
          ov.setUrl(url);
          status.overlayUpdates++;
          if (old) setTimeout(() => URL.revokeObjectURL(old), 2000);
        }, 'image/png');
      }
    } else {
      off.toBlob((blob) => {
        if (!blob || gen !== overlayGen) return;
        const url = URL.createObjectURL(blob);
        const old = ov._floodUrl;
        ov._floodUrl = url;
        ov.setUrl(url);
        status.overlayUpdates++;
        if (old) setTimeout(() => URL.revokeObjectURL(old), 2000);
      }, 'image/png');
    }
    scheduleFine();
    if (state.gauge >= 0) {
      state.gaugeMarker.setLatLng(cellLatLng(state.gauge));
      declutterPins();
      state.gaugeMarker.setTooltipContent(state.eventsApply ? 'Brisbane City gauge' : `Gauge: ${(state.areaMeta && state.areaMeta.name) || 'modelled area'}`);
    }
  }

  function onGeoClick(e) {
    if (Date.now() < suppressClickUntil) return;   // the end of a box drag
    if (state.pendingGeo) { say('Still loading this area…'); return; }
    const hit = areaAt(e.latlng);
    if (!hit) { onNationalClick(e); return; }
    if (hit.key !== state.areaKey) {
      activateArea(hit.key);
      say(`Switched to ${hit.name}.`);
    }
    if (!state.a) return;   // still reopening
    if (state.addingPoint) { addLevelPointAt(e.latlng); return; }
    if (defenceTap(e.latlng)) return;
    const c = latLngCell(e.latlng);
    if (!c) return;
    const s = $('moveGauge').checked ? F.snapToStream(state.a, c.x, c.y, 6, gaugeFloor()) : -1;
    let text;
    if (s >= 0 && s !== state.gauge) {
      state.gauge = s;
      state.base = null;
      runScenario();
      text = `Gauge moved here. ${describe(s)}`;
    } else {
      text = describe(c.i);
    }
    say(text);
    const div = document.createElement('div');
    div.innerHTML = `<div>${escapeHtml(text)}</div><button type="button" class="btn small" style="margin-top:6px">Check this property</button>`;
    div.querySelector('button').addEventListener('click', () => { state.lmap.closePopup(); checkProperty(e.latlng.lat, e.latlng.lng); });
    window.L.popup({ closeButton: false, autoPanPadding: [24, 24] })
      .setLatLng(e.latlng).setContent(div).openOn(state.lmap);
  }

  function onGeoMove(e) {
    if (state.pendingGeo || !state.a || !state.geo || !state.areaKey) return;
    const c = latLngCell(e.latlng);
    if (c) describeOncePerFrame(c.i);
  }

  function onLocated(e) {
    const L = window.L;
    if (state.youMarker) state.youMarker.remove();
    state.youMarker = L.circleMarker(e.latlng, {
      radius: 7, color: '#ffffff', weight: 2, fillColor: '#1a73e8', fillOpacity: 1,
    }).addTo(state.lmap);
    const hit = state.pendingGeo ? null : areaAt(e.latlng);
    if (hit && hit.key !== state.areaKey) activateArea(hit.key);
    const c = hit && state.a ? latLngCell(e.latlng) : null;
    say(c
      ? `Your location: ${describe(c.i)}`
      : 'Your location is outside the modelled areas. Tap the map near you to model flooding there.');
  }

  $('floodOpacity').addEventListener('input', (e) => {
    for (const a of areaReg.values()) {
      a.overlay.setOpacity(parseFloat(e.target.value) / 100);
      if (a.relief) a.relief.setOpacity(parseFloat(e.target.value) / 100);
    }
    if (fine && fine.ov) fine.ov.setOpacity(parseFloat(e.target.value) / 100);
    if (view3d && view3d.setWaterOpacity) view3d.setWaterOpacity(parseFloat(e.target.value) / 100);
    $('floodOpacityOut').textContent = e.target.value + '%';
  });
  $('showRelief').addEventListener('change', () => { if (state.geo) drawGeoMap(); });
  $('locate').addEventListener('click', () => {
    if (!state.lmap || $('lmap').hidden) { say('Your location can be shown on the street map. Pick Australia or a modelled area from the menu.'); return; }
    say('Finding your location…');
    state.lmap.locate({ setView: true, maxZoom: 15 });
  });

  // Only sizeable rivers can carry the gauge: at least 5% of the main
  // river's flow accumulation where it leaves the grid.
  function gaugeFloor() {
    const a = state.a;
    return a.mainOutlet >= 0 ? a.acc[a.mainOutlet] * 0.05 : 0;
  }

  function isFlood(i) { return !(state.base && state.base.wet[i]) && !state.a.ocean[i]; }

  function drawStats(s) {
    if (state.inertial) {
      const r = state.inertial, st = F.stats(state.a, state.run, null);
      $('summaryLine').textContent = `Local-inertial 2D · final depth at ${fmt(r.time / 60, 1)} min · ${Math.round(r.cell)} m grid`;
      $('stats').innerHTML = [['Wet land', fmt(st.wetLandKm2, 2), 'km²'], ['Deeper than 1 m', fmt(st.deepKm2, 2), 'km²'], ['Deepest water', fmt(st.maxDepth, 2), 'm'], ['Simulated time', fmt(r.time / 60, 1), 'min']].map(([k,v,u]) => `<div class="stat"><div class="label">${k}</div><div class="v">${v}<small>${u}</small></div></div>`).join('');
      if ($('btn3d')) $('btn3d').classList.toggle('dim', !(state.a && state.run));
      return;
    }
    const st = F.stats(state.a, state.run, state.base);
    const flashOnly = ctl.floodType.value === 'flash';
    const cells = [
      ['Land newly flooded', fmt(st.floodedKm2, 1), 'km²'],
      ['Deeper than 1 m', fmt(st.deepKm2, 1), 'km²'],
      ['Deepest water', fmt(st.maxDepth, 1), 'm'],
      flashOnly ? ['Creeks rise up to', fmt((state.flash && state.flash.maxCreekRise) || 0, 1), 'm'] : ['Level at gauge', fmt(s.gaugeLevel, 2), 'm'],
    ];
    $('eventsSet').hidden = scenarioEmpty || !state.eventsApply || flashOnly;
    const ev = state.eventsApply && state.events.find((e) => Math.abs(e.level - parseFloat(ctl.gaugeLevel.value)) < 0.001);
    const stormTxt = ctl.floodType.value !== 'river' ? `<b>Storm</b> ${ctl.rainMm.value} mm in ${ctl.stormHours.selectedOptions[0].textContent}` : '';
    $('summaryLine').innerHTML = (flashOnly ? stormTxt : `<b>${ev ? ev.label + ' peak' : 'Gauge'}</b> ${fmt(s.gaugeLevel, 2)} m` + (stormTxt ? ` + ${stormTxt}` : '')) + ' · '
      + `${fmt(st.floodedKm2, 1)} km² newly flooded` + (parseFloat(ctl.slr.value) && !flashOnly ? ` · +${ctl.slr.value} m sea level` : '');
    $('stats').innerHTML = cells.map(([k, v, u]) =>
      `<div class="stat"><div class="label">${k}</div><div class="v">${v}<small>${u}</small></div></div>`).join('');
    if ($('btn3d')) $('btn3d').classList.toggle('dim', !(state.a && state.run));
  }

  function cssVar(name) { return getComputedStyle(document.documentElement).getPropertyValue(name).trim(); }

  function profilePath() {
    const a = state.a;
    if (state.gauge < 0) return [];
    const up = [];
    let c = state.gauge;
    for (;;) {
      const W = a.W, cx = c % W, cy = Math.floor(c / W);
      let best = -1, bAcc = -1;
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
        if (!dx && !dy) continue;
        const nx = cx + dx, ny = cy + dy;
        if (nx < 0 || ny < 0 || nx >= W || ny >= a.H) continue;
        const n = ny * W + nx;
        if (a.rec[n] === c && a.stream[n] && a.acc[n] > bAcc) { bAcc = a.acc[n]; best = n; }
      }
      if (best < 0) break;
      up.push(best); c = best;
    }
    const down = [];
    c = state.gauge;
    while (c >= 0) { down.push(c); c = a.rec[c]; }
    return up.reverse().concat(down);
  }

  function drawProfile(s) {
    const a = state.a, run = state.riverRun || state.run;
    const base = state.baseMode === 'flash' ? null : state.base;
    const canvas = $('profile');
    if ($('panel-profile').hidden) return;
    if (!state.riverRun || !base) {
      const c2 = canvas.getContext('2d');
      c2.clearRect(0, 0, canvas.width, canvas.height);
      c2.fillStyle = cssVar('--muted'); c2.font = '13px Archivo, sans-serif';
      c2.fillText('The river profile applies to river flooding. Set Flood type to River or Both.', 8, 24);
      $('profileNote').textContent = '';
      return;
    }
    if (!run.wse || !base.wse) { schedule(); return; }   // rebuilt with the waterline
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const cw = canvas.clientWidth, ch = canvas.clientHeight;
    canvas.width = Math.round(cw * dpr); canvas.height = Math.round(ch * dpr);
    const ctx = canvas.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, cw, ch);
    const path = profilePath();
    const ink = cssVar('--ink'), muted = cssVar('--muted'), line = cssVar('--line'), accent = cssVar('--accent'), gaugeC = cssVar('--gauge');
    if (path.length < 2) {
      ctx.fillStyle = muted; ctx.font = '13px Archivo, sans-serif';
      ctx.fillText('No river found. Tap a channel on the map to place the gauge.', 8, 24);
      $('profileNote').textContent = '';
      return;
    }
    const chainKm = path.map((c) => a.chain[c] / 1000);
    const bed = path.map((c) => a.dem[c]);
    const wse = path.map((c) => run.wse[c]);
    const norm = path.map((c) => base.wse[c]);
    const xMax = chainKm[0], xMin = chainKm[chainKm.length - 1];
    let yMin = Infinity, yMax = -Infinity;
    for (let i = 0; i < path.length; i++) {
      yMin = Math.min(yMin, bed[i]); yMax = Math.max(yMax, wse[i], bed[i] > 40 ? 0 : bed[i]);
    }
    yMax = Math.min(Math.max(yMax, s.gaugeLevel + 1), Math.max(s.gaugeLevel + 4, 12));
    yMin = Math.max(Math.floor(yMin), -15);
    const L = { l: 40, r: 12, t: 10, b: 26 };
    const X = (km) => L.l + ((xMax - km) / (xMax - xMin || 1)) * (cw - L.l - L.r);
    const Y = (z) => ch - L.b - ((z - yMin) / (yMax - yMin || 1)) * (ch - L.t - L.b);

    // grid + y ticks
    ctx.font = '11px "IBM Plex Mono", monospace';
    ctx.strokeStyle = line; ctx.fillStyle = muted; ctx.lineWidth = 1;
    const step = niceStep((yMax - yMin) / 4);
    for (let v = Math.ceil(yMin / step) * step; v <= yMax; v += step) {
      ctx.beginPath(); ctx.moveTo(L.l, Y(v)); ctx.lineTo(cw - L.r, Y(v)); ctx.stroke();
      ctx.fillText(`${+v.toFixed(1)}`, 4, Y(v) + 4);
    }
    const xs = niceStep((xMax - xMin) / 5);
    for (let v = Math.ceil(xMin / xs) * xs; v <= xMax; v += xs) {
      ctx.fillText(`${+v.toFixed(1)}`, X(v) - 8, ch - 8);
    }
    ctx.fillText('m', 4, L.t + 2);

    // bed
    ctx.beginPath();
    ctx.moveTo(X(chainKm[0]), Y(Math.max(yMin, Math.min(yMax, bed[0]))));
    for (let i = 1; i < path.length; i++) ctx.lineTo(X(chainKm[i]), Y(Math.max(yMin, Math.min(yMax, bed[i]))));
    ctx.lineTo(X(chainKm[path.length - 1]), ch - L.b); ctx.lineTo(X(chainKm[0]), ch - L.b); ctx.closePath();
    ctx.fillStyle = 'rgba(150,128,104,0.55)'; ctx.fill();

    // normal water (dashed) and flood surface
    const lineOf = (arr, color, width, dash) => {
      ctx.beginPath();
      for (let i = 0; i < path.length; i++) {
        const v = Math.max(yMin, Math.min(yMax, arr[i]));
        if (i) ctx.lineTo(X(chainKm[i]), Y(v)); else ctx.moveTo(X(chainKm[i]), Y(v));
      }
      ctx.setLineDash(dash || []); ctx.strokeStyle = color; ctx.lineWidth = width; ctx.stroke(); ctx.setLineDash([]);
    };
    lineOf(norm, muted, 1.2, [4, 4]);
    lineOf(wse, accent, 2.4);

    // gauge
    const gk = a.chain[state.gauge] / 1000;
    ctx.strokeStyle = gaugeC; ctx.lineWidth = 1.5;
    ctx.beginPath(); ctx.moveTo(X(gk), L.t); ctx.lineTo(X(gk), ch - L.b); ctx.stroke();
    ctx.fillStyle = gaugeC; ctx.font = '600 11px Archivo, sans-serif';
    ctx.fillText('gauge', Math.min(X(gk) + 4, cw - 40), L.t + 10);
    ctx.fillStyle = ink;
    $('profileNote').textContent = 'Blue: flood level · dashed: normal level · brown: riverbed · x: km to the mouth';
  }

  function niceStep(raw) {
    const p = Math.pow(10, Math.floor(Math.log10(raw || 1)));
    const m = raw / p;
    return (m < 1.5 ? 1 : m < 3.5 ? 2 : m < 7.5 ? 5 : 10) * p;
  }


  /* ------------------------------------------------- Google Flood Hub */
  // Forecasts are fetched by the GitHub build (flood floodhub)
  // and published as data/floodhub.json and data/floodhub.geojson, so no API
  // key is exposed in the page.

  const SEVERITY = {
    EXTREME: { label: 'Extreme', color: '#6a1b9a', rank: 4 },
    SEVERE: { label: 'Severe', color: '#c62828', rank: 3 },
    ABOVE_NORMAL: { label: 'Above normal', color: '#e65100', rank: 2 },
    NO_FLOODING: { label: 'No flooding', color: '#80cbc4', rank: 1 },   // light, so it differs from red by lightness too
    UNKNOWN: { label: 'Unknown', color: '#607d8b', rank: 0 },
  };
  const sev = (k) => SEVERITY[k] || SEVERITY.UNKNOWN;
  const FH_ATTR = 'Forecasts &copy; <a href="https://sites.research.google/floods/">Google Flood Hub</a>, CC BY 4.0';

  async function loadFloodHub() {
    status.floodhub = { loaded: false };
    try {
      const r = await fetch('data/floodhub.json', { cache: 'no-cache' });
      if (!r.ok) throw new Error(String(r.status));
      state.floodhub = await r.json();
      if (state.floodhub.configured) {
        const g = await fetch('data/floodhub.geojson', { cache: 'no-cache' });
        state.floodhubAreas = g.ok ? await g.json() : null;
      }
    } catch (e) {
      state.floodhub = null;
    }
    const fh = state.floodhub;
    status.floodhub = { loaded: !!fh, configured: !!(fh && fh.configured), gauges: fh && fh.gauges ? fh.gauges.length : 0 };
    renderFloodHub();
  }

  // "6 min ago (2:41 pm)": relative and the clock time (with the day when
  // it isn't today), so a screenshot still says when
  function when(iso) {
    const t = Date.parse(iso);
    if (!Number.isFinite(t)) return '';
    const d = new Date(t), today = new Date().toDateString() === d.toDateString();
    const clock = d.toLocaleTimeString('en-AU', { hour: 'numeric', minute: '2-digit' });
    return `${ago(iso)} (${today ? clock : `${d.toLocaleDateString('en-AU', { weekday: 'short', day: 'numeric', month: 'short' })}, ${clock}`})`;
  }
  function ago(iso) {
    const t = Date.parse(iso);
    if (!Number.isFinite(t)) return '';
    const h = (Date.now() - t) / 3.6e6;
    if (h < 1) return `${Math.max(1, Math.round(h * 60))} min ago`;
    if (h < 48) return `${Math.round(h)} h ago`;
    return `${Math.round(h / 24)} days ago`;
  }

  function unitOf(g) {
    const u = g.model && g.model.gaugeValueUnit;
    return u === 'METERS' ? 'm' : u === 'CUBIC_METERS_PER_SECOND' ? 'm³/s' : '';
  }

  function gaugeLine(g) {
    const st = g.status || {};
    const parts = [];
    const trend = { RISE: 'rising', FALL: 'falling', NO_CHANGE: 'steady' }[st.forecastTrend];
    if (trend) parts.push(trend);
    if (g.forecast && g.forecast.values.length) {
      const peak = Math.max(...g.forecast.values.map((v) => v[1]).filter(Number.isFinite));
      if (Number.isFinite(peak)) parts.push(`forecast peak ${peak.toFixed(peak < 10 ? 2 : 0)} ${unitOf(g)}`);
    }
    const th = g.model && g.model.thresholds;
    if (th && th.warningLevel != null) parts.push(`warning ${th.warningLevel} ${unitOf(g)}`);
    if (g.status && g.status.qualityVerified === false) parts.push('unverified model');
    return parts.join(' · ');
  }

  function renderFloodHub() {
    const box = $('floodhubBody');
    const fh = state.floodhub;
    if (!fh) {
      box.innerHTML = '<p class="hint">Forecast data isn’t available right now.</p>';
      return;
    }
    if (!fh.configured) {
      box.innerHTML = '<p class="hint">Live Google river and flash flood forecasts aren’t switched on for this site yet. See the project README to connect them.</p>';
      return;
    }
    const gauges = (fh.gauges || []).filter((g) => g.status);
    gauges.sort((a, b) => sev(b.status.severity).rank - sev(a.status.severity).rank);
    const flooding = gauges.filter((g) => sev(g.status.severity).rank >= 2);
    const flash = (fh.flashFloodEvents || []).length;
    $('forecastBadge').hidden = !(flooding.length || flash || nat.warningCount || (nat.readingsSource === 'runtime' && nat.readings && nat.readings.watch && nat.readings.watch.length));
    let html = '';
    if (!flooding.length && !flash) {
      html += `<p>No flooding forecast at ${gauges.length} Flood Hub gauge${gauges.length === 1 ? '' : 's'} in Australia.</p>`;
    } else {
      const bits = [];
      if (flooding.length) bits.push(`${flooding.length} gauge${flooding.length === 1 ? '' : 's'} forecast above normal`);
      if (flash) bits.push(`${flash} flash flood forecast${flash === 1 ? '' : 's'} nearby`);
      html += `<p><strong>${escapeHtml(bits.join(' and '))}.</strong> Their locations are shown on the Brisbane street map.</p>`;
    }
    const show = gauges.slice(0, 6);
    if (show.length) {
      html += '<ul class="fh-list">' + show.map((g) => {
        const s = sev(g.status.severity);
        const name = [g.siteName, g.river].filter(Boolean).join(', ') || `Gauge ${g.gaugeId}`;
        return `<li><span class="sev" style="background:${s.color}">${s.label}</span>` +
          `<span class="where">${escapeHtml(name)}</span><span class="detail">${escapeHtml(gaugeLine(g))}</span></li>`;
      }).join('') + '</ul>';
    }
    html += `<p class="fh-meta">Updated ${escapeHtml(ago(fh.fetched))} from Google Flood Hub (CC BY 4.0). Google’s forecasts are experimental; follow <a href="https://www.bom.gov.au/qld/warnings/" target="_blank" rel="noopener">Bureau of Meteorology warnings</a>.</p>`;
    if (fh.errors && fh.errors.length) html += `<p class="fh-meta">Some forecast data could not be fetched on the last update.</p>`;
    box.innerHTML = html;
  }

  // Map layers for Flood Hub gauges and forecast / flash-flood areas
  function floodHubOverlays(L) {
    const fh = state.floodhub;
    const out = {};
    if (!fh || !fh.configured) return out;
    const gauges = (fh.gauges || []).filter((g) => g.location);
    if (gauges.length) {
      const grp = L.layerGroup();
      gauges.forEach((g) => {
        const s = sev(g.status && g.status.severity);
        const name = [g.siteName, g.river].filter(Boolean).join(', ') || `Gauge ${g.gaugeId}`;
        L.circleMarker([g.location.latitude, g.location.longitude], {
          radius: 7, color: '#ffffff', weight: 2, fillColor: g.status ? s.color : '#90a4ae', fillOpacity: 1,
          attribution: FH_ATTR,
        }).bindPopup(`<strong>${escapeHtml(name)}</strong><br>${g.status ? escapeHtml(s.label) : 'No forecast'}` +
          `${gaugeLine(g) ? '<br>' + escapeHtml(gaugeLine(g)) : ''}<br><small>Google Flood Hub</small>`).addTo(grp);
      });
      grp.getAttribution = () => FH_ATTR;
      out['Google Flood Hub gauges'] = grp;
    }
    const areas = state.floodhubAreas && state.floodhubAreas.features;
    if (areas && areas.length) {
      const lvl = { HIGH: 0.55, HIGHLY_LIKELY: 0.55, MEDIUM: 0.4, LOW: 0.25, LIKELY: 0.3 };
      out['Google Flood Hub flood areas'] = L.geoJSON(state.floodhubAreas, {
        attribution: FH_ATTR,
        style: (f) => {
          const flash = f.properties.kind === 'flash-flood';
          const c = flash ? '#d81b60' : '#1565c0';
          return { color: c, weight: 1.5, fillColor: c, fillOpacity: lvl[f.properties.level] || 0.3 };
        },
        onEachFeature: (f, layer) => {
          const p = f.properties;
          const what = p.kind === 'flash-flood'
            ? `Flash flood forecast (${(p.level || '').replace('_', ' ').toLowerCase()})${p.hours ? `, next ${p.hours} h` : ''}`
            : `River flood forecast area, ${String(p.level || '').toLowerCase()} ${p.mapType === 'DEPTH' ? 'depth' : 'likelihood'}`;
          layer.bindPopup(escapeHtml(what) + '<br><small>Google Flood Hub</small>');
        },
      });
    }
    return out;
  }

  /* -------------------------------------------------------- interaction */

  function cellAt(ev) {
    const canvas = $('map'), r = canvas.getBoundingClientRect(), a = state.a;
    const x = Math.floor(((ev.clientX - r.left) / r.width) * a.W);
    const y = Math.floor(((ev.clientY - r.top) / r.height) * a.H);
    if (x < 0 || y < 0 || x >= a.W || y >= a.H) return null;
    return { x, y, i: y * a.W + x };
  }

  function describe(i) {
    const a = state.a, run = state.run;
    if (!a.valid[i]) return 'No data here.';
    const parts = [`Ground ${fmt(a.dem[i], 1)} m`];
    if (a.ocean[i]) parts.push('sea');
    else if (run.wet[i] && state.base && state.base.wet[i]) parts.push(`normal water ${fmt(run.depth[i], 2)} m deep (river or lake, not flood)`, `level ${fmt(run.level[i], 2)} m`);
    else if (run.wet[i]) parts.push(`flood water ${fmt(run.depth[i], 2)} m deep${state.base && state.base.low && state.base.low.mask[i] ? ' (low ground: counted from the river\'s normal level, which satellites show it is above)' : ''}`, `level ${fmt(run.level[i], 2)} m`);
    else if (state.base && state.base.low && state.base.low.mask[i]) parts.push('dry: low ground, below the river\'s normal level but almost never seen wet by satellite (levees, drains or a terrain error); it floods once the water rises above its normal level, counted from there');
    else parts.push('dry');
    return parts.join(' · ');
  }

  // mousemove fires per event, far faster than the text is readable: update
  // the hover description at most once per frame
  let sayCellPending = -1, sayRaf = 0;
  function describeOncePerFrame(i) {
    sayCellPending = i;
    if (sayRaf) return;
    sayRaf = requestAnimationFrame(() => { sayRaf = 0; if (sayCellPending >= 0) say(describe(sayCellPending)); });
  }
  $('map').addEventListener('mousemove', (ev) => {
    if (!state.a) return;
    const c = cellAt(ev);
    if (c) describeOncePerFrame(c.i);
  });
  $('map').addEventListener('click', (ev) => {
    if (!state.a) return;
    const c = cellAt(ev);
    if (!c) return;
    const s = F.snapToStream(state.a, c.x, c.y, 8, gaugeFloor());
    if (s >= 0 && s !== state.gauge) {
      state.gauge = s;
      state.base = null;
      runScenario();
      say(`Gauge moved. ${describe(s)}`);
    } else {
      say(describe(c.i));
    }
  });

  let resizeT = 0;
  window.addEventListener('resize', () => {
    clearTimeout(resizeT);
    resizeT = setTimeout(() => {
      if (!state.run) return;
      if (state.geo && state.lmap) state.lmap.invalidateSize(); else drawMap();
      drawProfile(scenario());
    }, 120);
  });
  try {
    window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
      if (state.tiles) state.tiles.setUrl(isDark() ? TILES.dark : TILES.light);
      if (state.tileLabels) state.tileLabels.setUrl(isDark() ? TILES.darkLabels : TILES.lightLabels);
      if (state.run) drawProfile(scenario());
    });
  } catch (e) { /* older browsers */ }

  $('area').addEventListener('change', (ev) => {
    if (ev.target.value === 'upload') return;
    loadArea(ev.target.value);
  });

  /* ------------------------------------------------------------- text */

  function renderNotice() {
    const m = state.areaMeta || {};
    let html;
    if (m.national) {
      const nm = nat.data && nat.data.meta;
      html = '<strong>Australia-wide.</strong> Tap a flood gauge, tide gauge or dam for a report, or tap anywhere to model flooding there from the national elevation model. Gauges, dams and readings: Bureau of Meteorology'
        + (nm && nm.realtimeReadings ? `; live Queensland river levels © State of Queensland, CC BY 4.0` : '')
        + ((nat.readingsFetched || (nm && nm.fetched)) ? `, readings updated ${escapeHtml(when(nat.readingsFetched || nm.fetched))}${nat.readingsSource === 'runtime' ? ' (live)' : ''}` : '') + '. Not official warnings.';
    } else if (m.local) {
      html = `<strong>Screening only.</strong> ${escapeHtml(m.source || '')} It includes buildings and trees in some places and misses levees and drains. Do not use for evacuation or property decisions.`;
    } else if (m.synthetic) {
      html = '<strong>Illustrative terrain.</strong> This sample is generated, not real Brisbane elevation. It shows how the model behaves. Pick a processed area or load a DEM for real ground levels.';
    } else if (m.upload) {
      html = `<strong>Your terrain.</strong> ${m.routedBy === 'pointers' ? 'Flow directions come from your d8.tif.' : 'Flow directions were computed in your browser.'} Set the gauge level for your river; the historic Brisbane peaks don’t apply here.`;
    } else {
      html = `<strong>Screening only.</strong> ${escapeHtml(m.source || '')} A surface model includes buildings and trees, so expect errors in built-up areas. Do not use for evacuation or property decisions.`;
    }
    $('notice').innerHTML = html;
    $('noticePill').textContent = m.national ? 'About this map' : m.synthetic ? 'Illustrative terrain' : m.upload ? 'Your terrain' : 'Screening only';
  }

  function renderInfo() {
    const m = state.areaMeta || {}, a = state.a;
    const lines = [];
    if (!a) {
      const nm = (nat.data && nat.data.meta) || {};
      lines.push(`<span class="label">Data</span><br>${(nm.gauges || 0).toLocaleString('en-AU')} gauges and ${(nm.storages || 0).toLocaleString('en-AU')} dams from the Bureau of Meteorology${nat.readingsSource === 'runtime' && nat.readingsFetched
        ? `; live readings fetched ${escapeHtml(when(nat.readingsFetched))}${nat.readingsSaved ? ' (saved from your last visit, checking for newer)' : ''} (the gauge list is from the site build, ${escapeHtml(when(nm.fetched))})`
        : nm.fetched ? `, fetched ${escapeHtml(when(nm.fetched))} (the site build's copy)` : ''}. On-demand terrain: Geoscience Australia DEM-H (about 30 m).`);
      $('dataInfo').innerHTML = lines.join(' ');
      $('downloads').innerHTML = '';
      return;
    }
    lines.push(`<span class="label">Terrain</span><br>${a.W} × ${a.H} cells at ${fmt(a.cell, 0)} m.`);
    if (m.synthetic) lines.push('Flow routing computed in the browser (priority-flood and D8).');
    else if (m.processedWith) lines.push(`Flow directions from ${escapeHtml(m.processedWith)}, run ${escapeHtml(m.generated || '')}.`);
    if (m.source) lines.push(escapeHtml(m.source));
    $('dataInfo').innerHTML = lines.join(' ');
    const dl = $('downloads');
    dl.innerHTML = '';
    (m.rasters || []).forEach((r) => {
      const link = document.createElement('a');
      link.href = `data/${m.id}/${r.file}`; link.textContent = r.name; link.target = '_blank'; link.rel = 'noopener';
      dl.appendChild(link);
    });
    if ((m.rasters || []).length) {
      const t = document.createElement('span'); t.className = 'hint'; t.textContent = 'GeoTIFFs for RustGIS or QGIS:';
      dl.prepend(t);
    }
  }

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  function showError(msg) {
    $('notice').innerHTML = `<strong>Problem.</strong> ${escapeHtml(msg)}`;
  }



  /* ------------------------------------------------------- Australia-wide */
  // The national view: BoM gauges, tide gauges and dams (fetched by the
  // build, see flood national), a report for whatever is tapped,
  // and on-demand flood modelling from Geoscience Australia's 1-second
  // hydrologically enforced elevation model (DEM-H), read straight from GA.

  const AUS_BOUNDS = [112.5, -44, 154, -10];
  const DEMH_WCS = 'https://services.ga.gov.au/gis/services/DEM_SRTM_1Second_Hydro_Enforced_2024/MapServer/WCSServer';
  const BOM_ATTR = 'Gauges and storages &copy; Commonwealth of Australia (Bureau of Meteorology), CC BY 4.0';
  const GAUGE_STYLE = {
    forecast: { label: 'Flood forecast gauge', color: '#1565c0', radius: 5.5 },
    information: { label: 'Flood information gauge', color: '#5c6bc0', radius: 4.5 },
    river: { label: 'River gauge', color: '#78909c', radius: 3.5 },
    tide: { label: 'Tide gauge', color: '#00897b', radius: 5.5 },
    storage: { label: 'Dam or water storage', color: '#6d4c41', radius: 6 },
  };
  status.national = { loaded: false };
  status.local = {};
  const nat = { data: null, readings: null, layers: {}, picked: null };

  // compact point features ({keys, dict, rows}) back to GeoJSON features
  function decodeCompact(c) {
    if (!c || !c.rows || !c.keys) throw new Error('not a compact file');
    const keys = c.keys, dict = c.dict || {};
    return {
      features: c.rows.map((r) => {
        const p = {};
        for (let j = 0; j < keys.length; j++) { const v = r[j + 2], d = dict[keys[j]]; p[keys[j]] = d ? (v >= 0 ? d[v] : null) : v; }
        return { type: 'Feature', geometry: { type: 'Point', coordinates: [r[0], r[1]] }, properties: p };
      }),
    };
  }
  // Recorded floods and gauge ratings: only needed for the flood over time,
  // so they load when a model is first opened, not with the map
  let historyP = null;
  function ensureHistory() {
    if (!historyP) {
      const j = (f) => fetch(f, { cache: 'no-cache' }).then((r) => (r.ok ? r.json() : {})).catch(() => ({}));
      historyP = Promise.all([j('data/events.json'), j('data/ratings.json')]).then(([ev, rt]) => {
        nat.events = (ev.events || []).filter((e) => e.series);
        nat.ratings = rt.ratings || {};
        renderShapeChoices();
      });
    }
    return historyP;
  }
  // The other river gauges (about 2,400): loaded after the map is drawn, or
  // straight away when something needs them (presets, models, reports)
  let riverP = null;
  function ensureRiverGauges() {
    if (!riverP) {
      riverP = fetch('data/national/gauges-river.min.json', { cache: 'no-cache' })
        .then((r) => { if (!r.ok) throw new Error('River gauge subset unavailable'); return r.json(); })
        .then(decodeCompact)
        .catch(async () => {
          // Older/local datasets may only have the complete compact network.
          const r = await fetch('data/national/gauges.min.json', { cache: 'no-cache' });
          if (!r.ok) throw new Error('River gauge network unavailable');
          const all = decodeCompact(await r.json());
          return { features: all.features.filter((f) => f.properties.kind === 'river') };
        }).then((c) => {
          if (!c || !nat.data) return;
          const feats = c.features;
          nat.data.gauges.push(...feats);
          if (status.national) status.national.gauges = nat.data.gauges.length;
          const layer = nat.layers['Other river gauges (BoM)'];
          if (layer) layer.addData({ type: 'FeatureCollection', features: feats });
        }).catch(() => {});
    }
    return riverP;
  }
  // The broker's readings as last saved in this browser (Cache API, written
  // by the service worker), if under 12 hours old.
  const SAVED_MAX_MS = 12 * 3600e3;
  // the page keeps its own copy (not only the service worker's, which
  // isn't in charge on a first visit)
  const SAVED_CACHE = 'flood-saved-v1';
  function saveReadings(res) {
    try {
      if (typeof caches === 'undefined' || !res || !res.ok) return;
      caches.open(SAVED_CACHE).then((c) => c.put(`${BROKER}/v1/now`, res)).then(() => { status.savedPut = 'ok'; }, (e) => { status.savedPut = String(e && e.message || e); });
    } catch (e) { /* no Cache API here */ }
  }
  async function savedReadings() {
    try {
      if (!BROKER || typeof caches === 'undefined') return null;
      const own = await (await caches.open(SAVED_CACHE)).match(`${BROKER}/v1/now`);
      const hit = own || await caches.match(`${BROKER}/v1/now`, { ignoreVary: true });
      if (!hit || !hit.ok) { status.savedCheck = { found: !!hit, own: !!own }; return null; }
      const j = await hit.json();
      const t = j && j.fetched ? new Date(j.fetched).getTime() : NaN;
      if (!j || !j.level || !(Date.now() - t < SAVED_MAX_MS)) { status.savedCheck = { found: true, own: !!own, fetched: j && j.fetched, level: !!(j && j.level) }; return null; }
      status.savedReadings = { fetched: j.fetched, own: !!own };
      return j;
    } catch (e) { status.savedCheck = { error: String(e && e.message || e) }; return null; }
  }
  function renderFeedHealth() {
    const health = nat.feedHealth;
    const box = $('feedStatus'), pill = $('feedPill');
    if (!box || !pill) return;
    const issues = [...(health ? [...(health.error ? [{ name: 'Live readings', reason: health.error }] : []), ...health.issues] : []),
      ...Object.entries(nat.layerIssues || {}).map(([name, reason]) => ({ name, reason }))];
    box.hidden = pill.hidden = !issues.length;
    pill.textContent = issues.length === 1 ? '1 feed issue' : `${issues.length} feed issues`;
    if (!issues.length) return;
    const copy = nat.readingsFetched ? `Keeping the last available readings (${when(nat.readingsFetched)}).` : 'The map remains usable; live readings may be unavailable.';
    const retry = health?.checking ? 'Checking again now…' : health?.nextRetry
      ? `Retrying automatically at ${new Date(health.nextRetry).toLocaleTimeString('en-AU', { hour: '2-digit', minute: '2-digit', second: '2-digit' })}.`
      : 'Failed sources will be checked again by the live service; some providers impose longer rate limits.';
    box.innerHTML = `<strong>Some data is delayed</strong><p>${escapeHtml(copy)} ${escapeHtml(retry)}</p><ul>${issues.map(issue => `<li><strong>${escapeHtml(issue.name)}</strong>: ${escapeHtml(issue.reason)}${issue.lastGood ? ` Last successful fetch: ${escapeHtml(when(issue.lastGood))}.` : ''}</li>`).join('')}</ul>`;
  }
  function runLiveUpdate(name, draw) {
    nat.layerIssues = nat.layerIssues || {};
    try { draw(); delete nat.layerIssues[name]; } catch (error) {
      const reason = `Could not display this feed: ${String(error?.message || error)}. Other layers remain available.`;
      if (nat.layerIssues[name] !== reason) logProblem('data', name, reason);
      nat.layerIssues[name] = reason;
    }
  }
  function requestLiveReadings(timeout, cache) {
    if (!nat.feedClient) nat.feedClient = createFeedClient({
      fetch: (...args) => fetch(...args), url: `${BROKER}/v1/now`, previous: () => nat.readings || {},
      retry: () => refreshLiveReadings(true),
      onChange: health => {
        if (health.error && health.error !== nat.feedHealth?.error)
          logProblem('live', 'Live readings delayed; keeping available data and retrying', health.error);
        nat.feedHealth = health;
        status.feeds = health;
        renderFeedHealth();
      },
    });
    return nat.feedClient.request(timeout, cache);
  }
  async function loadNationalData() {
    if (nat.data) return nat.data;
    const get = async (f) => {
      const r = await fetch(`data/national/${f}`, { cache: 'no-cache' });
      if (!r.ok) throw new Error(`${f}: ${r.status}`);
      return r.json();
    };
    try {
      // gauges come as compact columns (about half the size): the flood
      // network first, the other river gauges once the map is drawn
      let split = true;
      const gaugeFile = get('gauges-core.min.json').then(decodeCompact)
        .catch(() => { split = false; return get('gauges.min.json').then(decodeCompact); })
        .catch(() => { split = false; return get('gauges.geojson'); });
      // readings: the broker's when the switch says so, else (or if it fails) the build's
      // the copy saved by the last visit (the service worker keeps the
      // broker's answers): draw from it at once and fetch newer readings
      // in the background, instead of waiting on the broker
      const saved = DATA_SOURCE === 'runtime' ? await savedReadings() : null;
      const live = saved ? Promise.resolve(saved) : DATA_SOURCE === 'runtime'
        ? requestLiveReadings(8000).then(fresh => {
          saveReadings(new Response(JSON.stringify(fresh), { headers: { 'Content-Type': 'application/json' } }));
          return fresh;
        }).catch(() => null)
        : Promise.resolve(null);
      const [gauges, storages, built, meta, fresh] = await Promise.all([
        gaugeFile, get('storages.geojson'), get('readings.json').catch((err) => (DATA_SOURCE === 'runtime' ? null : Promise.reject(err))), get('meta.json'), live]);
      const readings = fresh && fresh.level ? fresh : built || { level: {}, storage: {} };
      nat.readingsSource = fresh && fresh.level ? 'runtime' : 'build';
      nat.readingsSaved = !!(saved && fresh === saved);
      if (nat.readingsSaved) setTimeout(() => { refreshLiveReadings(true).then((got) => { status.savedThenFresh = got; renderVersions(); }).catch(() => {}); }, 1200);
      nat.readingsFetched = (fresh && fresh.level && fresh.fetched) || (meta && meta.fetched) || null;
      nat.data = { gauges: gauges.features || [], storages: storages.features || [], meta };
      nat.readings = readings;
      if (split) setTimeout(() => ensureRiverGauges(), 1500); else riverP = Promise.resolve();
      const opt = async (f) => { try { const r = await fetch(`data/national/${f}`, { cache: 'no-cache' }); return r.ok ? await r.json() : null; } catch (e) { return null; } };
      [nat.floodclass, nat.warnings] = await Promise.all([opt('floodclass.json'), opt('warnings.json')]);
      // the broker's warnings (every 15 minutes) when readings come from it
      if (nat.readingsSource === 'runtime' && readings.warnings && readings.warnings.ok) nat.warnings = readings.warnings;
      // and its flood class levels (the Bureau's river height pages, hourly)
      if (nat.readingsSource === 'runtime' && readings.floodclass) nat.floodclass = Object.assign({}, nat.floodclass || {}, readings.floodclass);
      nat.floodclass = nat.floodclass || {};
    } catch (e) {
      nat.data = { gauges: [], storages: [], meta: { errors: [String(e)] } };
      nat.readings = { level: {}, storage: {} };
      logProblem('data', 'National map data could not be loaded', String(e && e.message || e));
    }
    // Replace the loading placeholder even when a required dataset failed.
    runLiveUpdate('Flood warnings', renderWarnings);
    runLiveUpdate('Watch list', renderWatch);
    renderFeedHealth();
    status.national = {
      loaded: true, gauges: nat.data.gauges.length, storages: nat.data.storages.length,
      levelReadings: Object.keys(nat.readings.level || {}).length,
      storageReadings: Object.keys(nat.readings.storage || {}).length,
      dataSource: DATA_SOURCE, readingsSource: nat.readingsSource || 'build', readingsFetched: nat.readingsFetched || null,
    };
    return nat.data;
  }

  function storageFill(p) {
    const r = nat.readings && nat.readings.storage && nat.readings.storage[p.station];
    if (!r || !p.capacity_ml) return null;
    return r.latest[1] / p.capacity_ml;
  }

  function storageColor(p) {
    const f = storageFill(p);
    if (f == null) return GAUGE_STYLE.storage.color;
    if (f >= 1) return '#6a1b9a';     // spilling or above full supply
    if (f >= 0.8) return '#1565c0';
    if (f >= 0.5) return '#43a047';
    if (f >= 0.25) return '#f9a825';
    return '#c62828';
  }

  function warningGaugeMarker(L, renderer, feature) {
    const [lon, lat] = feature.geometry.coordinates;
    const ring = L.circleMarker([lat, lon], { renderer, radius: 10, color: '#c62828', weight: 2.5, fill: false, interactive: true });
    ring.bindTooltip(`${feature.properties.name || 'Gauge'}: current flood warning`, { direction: 'top', offset: [0, -4] });
    ring.on('click', (event) => { L.DomEvent.stop(event); onDotClick(feature, event.latlng); });
    return ring;
  }

  // Keep group identity stable so a feed refresh preserves the layer switches.
  function updateLiveGaugeLayers(L, renderer) {
    const seaName = 'Storm tide gauges, live (Qld)';
    const seaLayer = nat.layers[seaName] || (nat.layers[seaName] = L.layerGroup());
    seaLayer.clearLayers();
    const sea = (nat.readings && nat.readings.sea) || {};
    const surgeColor = (value) => (!Number.isFinite(value) ? '#9aa0a6' : value >= 0.3 ? '#c62828' : value >= 0.15 ? '#ef6c00' : value <= -0.15 ? '#1565c0' : '#2e7d32');
    for (const gauge of Object.values(sea)) {
      if (!Number.isFinite(gauge.lat) || !Number.isFinite(gauge.lon)) continue;
      const marker = L.circleMarker([gauge.lat, gauge.lon], { renderer, radius: 7, color: '#ffffff', weight: 1.5, fillColor: surgeColor(gauge.surge), fillOpacity: 0.95 });
      marker.bindPopup(() => seaPopupHtml(gauge));
      seaLayer.addLayer(marker);
    }
    status.sea = { sites: Object.keys(sea).length, fetched: nat.readings && nat.readings.seaFetched || null };
    const warnName = 'Gauges under a current flood warning (BoM)';
    const warnLayer = nat.layers[warnName] || (nat.layers[warnName] = L.layerGroup());
    warnLayer.clearLayers();
    const warned = nat.data.gauges.filter((feature) => feature.properties.kind !== 'river' && warningsFor(feature.properties).length);
    warned.forEach((feature) => warnLayer.addLayer(warningGaugeMarker(L, renderer, feature)));
    status.warnedGauges = warned.length;
  }

  function buildNationalLayers(L, m) {
    if (Object.keys(nat.layers).length) return nat.layers;
    const renderer = nat.renderer = L.canvas({ padding: 0.3 });
    const groups = {
      'Flood forecast gauges (BoM)': ['forecast'],
      'Tide gauges (BoM)': ['tide'],
      'Flood information gauges (BoM)': ['information'],
      'Other river gauges (BoM)': ['river'],
    };
    for (const [name, kinds] of Object.entries(groups)) {
      const feats = nat.data.gauges.filter((f) => kinds.includes(f.properties.kind));
      if (!feats.length && kinds[0] !== 'river') continue;   // river gauges may still be on their way
      const st = GAUGE_STYLE[kinds[0]];
      nat.layers[name] = L.geoJSON({ type: 'FeatureCollection', features: feats }, {
        attribution: BOM_ATTR,
        pointToLayer: (f, ll) => L.circleMarker(ll, {
          renderer, radius: st.radius, color: '#ffffff', weight: 1.5, fillColor: st.color, fillOpacity: 0.95,
        }),
        onEachFeature: (f, layer) => {
          layer.bindTooltip(f.properties.name || 'Gauge', { direction: 'top', offset: [0, -4] });
          layer.on('click', (e) => { L.DomEvent.stop(e); onDotClick(f, e.latlng); });
        },
      });

    }
    // Rain radar from RainViewer's free tier: the last two hours of
    // 10-minute frames, played as a loop (pausing on the latest) so you can
    // see which way the rain is moving; to zoom 7, scaled up beyond that.
    const radar = L.layerGroup();
    let radarFrames = [], radarShown = -1, radarT = 0, radarPlay = 0, radarPaused = true, radarCtl = null;
    status.radar = { ok: null };
    const radarTime = (t) => new Date(t * 1000).toLocaleTimeString('en-AU', { hour: 'numeric', minute: '2-digit' });
    const showRadarFrame = (i) => {
      if (!radarFrames.length) return;
      i = (i + radarFrames.length) % radarFrames.length;
      // A transparent tile layer still downloads tiles. Keep only the
      // displayed frame on the map instead of fetching all twelve at once.
      radarFrames.forEach((frame, k) => {
        if (k === i) { if (!radar.hasLayer(frame.layer)) radar.addLayer(frame.layer); }
        else if (radar.hasLayer(frame.layer)) radar.removeLayer(frame.layer);
      });
      radarShown = i;
      if (radarCtl) {
        const last = i === radarFrames.length - 1;
        radarCtl.querySelector('.radar-time').textContent = `${radarTime(radarFrames[i].time)}${last ? ' (latest)' : ''}`;
      }
    };
    const radarStep = () => {
      // dwell on the latest frame, then run the loop again
      showRadarFrame(radarShown + 1);
      clearTimeout(radarPlay);
      const size = m.getSize();
      // RainViewer permits 100 tiles/IP/minute. Leave headroom for panning:
      // https://www.rainviewer.com/api/transition-faq.html
      const tileCount = (Math.ceil(size.x / 512) + 1) * (Math.ceil(size.y / 512) + 1);
      if (!radarPaused) radarPlay = setTimeout(radarStep, Math.max(2000, Math.ceil(tileCount * 60000 / 80)));
    };
    const loadRadar = async () => {
      try {
        const response = await fetch('https://api.rainviewer.com/public/weather-maps.json', { cache: 'no-cache', signal: AbortSignal.timeout(15000) });
        if (!response.ok) throw new Error(`radar metadata HTTP ${response.status}`);
        const j = await response.json();
        const past = (j.radar && j.radar.past) || [];
        if (!past.length) throw new Error('no radar frames');
        radar.clearLayers();
        const fr = past[past.length - 1];
        status.radar = { ok: true, time: fr.time, age: Math.round(Date.now() / 60000 - fr.time / 60), frames: past.slice(-12).length, loaded: 0, errors: 0 };
        radarFrames = past.slice(-12).map((fr) => ({
          time: fr.time,
          layer: L.tileLayer(`${j.host}${fr.path}/512/{z}/{x}/{y}/2/1_1.png`, {
            opacity: 0.65, tileSize: 512, zoomOffset: -1, maxNativeZoom: 8, maxZoom: 20, zIndex: 9,
            attribution: 'Rain radar &copy; <a href="https://www.rainviewer.com/" target="_blank" rel="noopener">RainViewer</a>',
          }),
        }));
        radarFrames.forEach((frame) => {
          frame.layer.on('tileload', () => {
            status.radar.loaded++;
            setLayerState('Rain radar, last 2 hours (RainViewer)', 'done', status.radar.errors ? 'Shown (some radar tiles failed)' : 'Shown');
          });
          frame.layer.on('tileerror', () => {
            status.radar.errors++;
            setLayerState('Rain radar, last 2 hours (RainViewer)', status.radar.loaded ? 'done' : 'error', 'Radar tiles could not load; the service may be rate limiting requests.');
          });
        });
        showRadarFrame(radarFrames.length - 1);
        clearTimeout(radarPlay);
        if (!radarPaused) radarPlay = setTimeout(radarStep, 2000);
      } catch (err) { status.radar = { ok: false, error: String(err.message || err) }; setLayerState('Rain radar, last 2 hours (RainViewer)', 'error', 'Radar could not be loaded. Try again later.'); }
    };
    const RadarControl = L.Control.extend({
      options: { position: 'bottomleft' },
      onAdd() {
        const d = L.DomUtil.create('div', 'radar-ctl');
        d.innerHTML = '<button type="button" class="radar-play" aria-label="Play the radar loop" title="Play">▶</button><span class="radar-time">Loading radar…</span>';
        L.DomEvent.disableClickPropagation(d);
        d.querySelector('.radar-play').addEventListener('click', (e) => {
          radarPaused = !radarPaused;
          e.currentTarget.textContent = radarPaused ? '▶' : '❚❚';
          e.currentTarget.title = radarPaused ? 'Play' : 'Pause';
          e.currentTarget.setAttribute('aria-label', radarPaused ? 'Play the radar loop' : 'Pause the radar loop');
          clearTimeout(radarPlay);
          if (radarPaused) showRadarFrame(radarFrames.length - 1); else radarPlay = setTimeout(radarStep, 500);
        });
        return d;
      },
    });
    radar.on('add', () => {
      loadRadar();
      clearInterval(radarT); radarT = setInterval(loadRadar, 10 * 60 * 1000);
      if (state.lmap && !radarCtl) { const c = new RadarControl(); c.addTo(state.lmap); radarCtl = c.getContainer(); radarCtl._ctl = c; }
    });
    radar.on('remove', () => {
      clearInterval(radarT); clearTimeout(radarPlay);
      if (radarCtl) { radarCtl._ctl.remove(); radarCtl = null; }
    });
    nat.layers['Rain radar, last 2 hours (RainViewer)'] = radar;
    runLiveUpdate('River and tide markers', () => updateLiveGaugeLayers(L, renderer));
    // warning areas: the Bureau's own outline where its warning has one,
    // otherwise around the gauges on the warned rivers (redrawn when the
    // warnings update)
    if (!nat.warnLayer) nat.warnLayer = L.layerGroup();
    nat.layers['Flood warning areas (BoM)'] = nat.warnLayer;
    runLiveUpdate('Flood warning areas', drawWarningAreas);
    if (!nat.roadClosuresLayer) nat.roadClosuresLayer = L.layerGroup();
    nat.layers['Road closures and events (official)'] = nat.roadClosuresLayer;
    runLiveUpdate('Road events', drawRoadClosures);
    if (!nat.emergencyLayer) nat.emergencyLayer = L.layerGroup();
    nat.layers['Emergency warnings (state)'] = nat.emergencyLayer;
    runLiveUpdate('Emergency warnings', drawEmergencyWarnings);
    if (!nat.rainObsLayer) nat.rainObsLayer = L.layerGroup();
    nat.layers['Rain gauges, observed 24h (BoM)'] = nat.rainObsLayer;
    runLiveUpdate('Observed rainfall', drawRainObs);
    renderFeedHealth();
    if (nat.data.storages.length) {
      nat.layers['Dams and water storages (BoM)'] = L.geoJSON({ type: 'FeatureCollection', features: nat.data.storages }, {
        attribution: BOM_ATTR,
        pointToLayer: (f, ll) => L.circleMarker(ll, {
          renderer, radius: GAUGE_STYLE.storage.radius, color: '#ffffff', weight: 2,
          fillColor: storageColor(f.properties), fillOpacity: 0.95,
        }),
        onEachFeature: (f, layer) => {
          layer.bindTooltip(f.properties.name || 'Storage', { direction: 'top', offset: [0, -4] });
          layer.on('click', (e) => { L.DomEvent.stop(e); onDotClick(f, e.latlng); });
        },
      });
    }
    return nat.layers;
  }

  function addNationalLayers(m) {
    const L = window.L;
    buildNationalLayers(L, m);
    const defaultsOn = ['Flood forecast gauges (BoM)', 'Tide gauges (BoM)', 'Dams and water storages (BoM)', 'Gauges under a current flood warning (BoM)', 'Flood warning areas (BoM)', 'Road closures and events (official)', 'Emergency warnings (state)'];
    for (const [name, layer] of Object.entries(nat.layers)) {
      registerOverlay(name, layer);
      if (nat.defaultsApplied) continue;   // respect what the viewer has switched since
      if (defaultsOn.includes(name)) { layer.userOn = true; layer.addTo(m); } else layer.userOn = false;
    }
    nat.defaultsApplied = true;
    if (!nat.dotsWired) {
      nat.dotsWired = true;
      m.on('zoomend', scaleDots);
      m.on('overlayadd', orderDots);
      // regroup on zoom, and when a gauge or dam layer is switched (not for
      // every pin, popup or flood overlay that comes and goes)
      const dotLayer = (l) => Object.entries(nat.layers).some(([n, x]) => x === l && n in DOT_RANK);
      m.on('zoomend', scheduleClusters);
      m.on('layeradd layerremove', (e) => { if (dotLayer(e.layer)) scheduleClusters(); });
    }
    scaleDots(); orderDots(); clusterDots();
    syncLayerLists();
  }

  // Country-wide, a solid band of dots hides the ones that matter: shrink
  // them below z6 and draw the forecast gauges and warnings last (on top).
  function scaleDots() {
    const m = state.lmap;
    if (!m) return;
    const z = m.getZoom(), f = z < 5 ? 0.65 : z < 6 ? 0.8 : 1;
    for (const l of Object.values(nat.layers)) {
      if (!l.eachLayer) continue;
      l.eachLayer((c) => {
        if (!c.setRadius) return;
        if (!c._r0) c._r0 = c.options.radius;
        c.setRadius(c._r0 * f);
      });
    }
  }
  let clusterT = 0;
  function scheduleClusters() { clearTimeout(clusterT); clusterT = setTimeout(clusterDots, 60); }
  function orderDots() {
    const m = state.lmap;
    if (!m) return;
    for (const n of ['Other river gauges (BoM)', 'Flood information gauges (BoM)', 'Tide gauges (BoM)', 'Dams and water storages (BoM)', 'Flood forecast gauges (BoM)', 'Gauges under a current flood warning (BoM)']) {
      const l = nat.layers[n];
      if (l && l.eachLayer && m.hasLayer(l)) l.eachLayer((c) => c.bringToFront && c.bringToFront());
    }
  }

  // Below z7 nearby dots are grouped: dots sharing a ~34 px square become one
  // numbered circle, coloured by the most important dot in it (a red ring if
  // any is under a flood warning); a tap zooms in on the group. Lone dots
  // stay as they are. The grouped dots are only hidden (styled out), so the
  // Layers switches and their state are untouched.
  const CLUSTER_Z = 7, CLUSTER_PX = 34;
  const DOT_RANK = { 'Gauges under a current flood warning (BoM)': 0, 'Flood forecast gauges (BoM)': 1, 'Flood information gauges (BoM)': 2, 'Tide gauges (BoM)': 3, 'Dams and water storages (BoM)': 4, 'Other river gauges (BoM)': 5 };
  function clusterDots() {
    const m = state.lmap, L = window.L;
    if (!m || !L) return;
    if (!nat.clusters) nat.clusters = L.layerGroup().addTo(m);
    nat.clusters.clearLayers();
    const z = m.getZoom(), on = z < CLUSTER_Z;
    const cells = new Map();
    for (const [name, l] of Object.entries(nat.layers)) {
      if (!(name in DOT_RANK) || !l.eachLayer) continue;
      const shown = m.hasLayer(l);
      l.eachLayer((c) => {
        if (!c.getLatLng || !c.setStyle) return;
        if (c._hidden) { c.setStyle(c._style0); c.options.interactive = c._interactive0; c._hidden = false; }
        if (!on || !shown) return;
        const p = m.project(c.getLatLng(), z), key = `${Math.floor(p.x / CLUSTER_PX)},${Math.floor(p.y / CLUSTER_PX)}`;
        let cl = cells.get(key);
        if (!cl) cells.set(key, (cl = { dots: [], rank: 9, color: null, warn: false, lat: 0, lng: 0 }));
        const rank = DOT_RANK[name];
        if (rank === 0) cl.warn = true;
        else {
          cl.dots.push(c);
          const ll = c.getLatLng(); cl.lat += ll.lat; cl.lng += ll.lng;
          if (rank < cl.rank) { cl.rank = rank; cl.color = c.options.fillColor; }
        }
        if (rank === 0) cl.rings = (cl.rings || []).concat(c);
      });
    }
    let groups = 0;
    for (const cl of cells.values()) {
      if (cl.dots.length < 2) continue;
      groups++;
      for (const c of cl.dots.concat(cl.rings || [])) {
        if (!c._style0) c._style0 = { opacity: c.options.opacity == null ? 1 : c.options.opacity, fillOpacity: c.options.fillOpacity == null ? 0.2 : c.options.fillOpacity };
        c.setStyle({ opacity: 0, fillOpacity: 0 }); c._hidden = true;
        c._interactive0 = c.options.interactive; c.options.interactive = false;   // the canvas skips it for taps and hovers
      }
      const n = cl.dots.length, ll = [cl.lat / n, cl.lng / n], size = n >= 100 ? 34 : n >= 10 ? 28 : 24;
      const icon = L.divIcon({ className: 'dot-cluster', iconSize: [size, size], html: `<span style="background:${cl.color}${cl.warn ? ';box-shadow:0 0 0 2.5px #c62828' : ''}">${n}</span>` });
      L.marker(ll, { icon, keyboard: true, title: `${n} gauges and dams here${cl.warn ? ', some under a flood warning' : ''}: zoom in`, zIndexOffset: 500 - cl.rank * 50 })
        .on('click', () => m.setView(ll, Math.min(CLUSTER_Z, z + 2)))
        .addTo(nat.clusters);
    }
    status.dotClusters = groups;
  }

  async function enterNational(opts) {
    deactivate();
    state.areaId = 'australia';
    status.area = 'australia';
    state.areaMeta = { id: 'australia', name: 'Australia', national: true };
    state.grid = null; state.a = null; state.run = null; state.base = null; state.gauge = -1; state.geo = null;
    showScenarioEmpty(true);
    const ok = await enterGeoMode(AUS_BOUNDS, { fit: !opts || opts.fit !== false });
    if (!ok) {
      useSampleOption();
      await loadArea('sample');
      say('The street map could not load, so the Australia-wide view is unavailable. Showing the sample terrain.', { error: true });
      return;
    }
    await loadNationalData();
    addNationalLayers(state.lmap);
    loadStudies();
    renderNotice();
    renderInfo();
    $('summaryLine').innerHTML = '<b>Australia</b> · tap a gauge, dam or tide gauge, or tap anywhere to model flooding';
  }

  function showScenarioEmpty(empty) {
    scenarioEmpty = empty;
    Array.from($('scenarioEmpty').parentElement.children).forEach((el) => {
      if (el.id !== 'scenarioEmpty' && el.id !== 'scenarioModel' && el.id !== 'edgeNote' && el.id !== 'levelPointsSet' && el.id !== 'checkSet' && el.id !== 'downloadSet' && el.id !== 'stormSet' && el.id !== 'riverSet' && el.id !== 'impactSet' && el.id !== 'recordedSet' && el.id !== 'defenceSet' && el.id !== 'timeSet') el.hidden = empty || (el.id === 'eventsSet' && !state.eventsApply);
    });
    if (empty) { $('stats').innerHTML = ''; state.edges = []; }
    renderEdgeNote();
    renderLevelPoints();
    renderStorm();
    renderScenarioTitle();
    solverControls();
    renderModeLegend();
  }

  /* ---------- reports */

  // a reading's time, with how long ago it was ("19 Oct, 6:00 pm (24 h ago)")
  function fmtReadingTime(iso) {
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return iso || '';
    const h = Math.round((Date.now() - d.getTime()) / 3600000);
    return `${d.toLocaleString('en-AU', { day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' })} (${h < 48 ? `${h} h` : `${Math.round(h / 24)} days`} ago)`;
  }
  function fmtDate(iso) {
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return iso || '';
    return d.toLocaleDateString('en-AU', { day: 'numeric', month: 'short', year: 'numeric' });
  }

  function seaPopupHtml(x) {
    // the surge: how much higher (or lower) the sea is against the predicted
    // tide than this gauge usually reads (some predictions sit a fixed amount off)
    const su = Number.isFinite(x.surge) ? x.surge : null;
    const surge = su == null ? 'not enough readings yet to tell a surge' : su >= 0.05 ? `${su.toFixed(2)} m higher than usual against the tide` : su <= -0.05 ? `${(-su).toFixed(2)} m lower than usual against the tide` : 'about as usual against the tide';
    return `<div class="sea-popup"><strong>${escapeHtml(x.name)}</strong> storm tide gauge<br>
      Sea ${Number.isFinite(x.level) ? x.level.toFixed(2) : '?'} m, predicted tide ${Number.isFinite(x.predicted) ? x.predicted.toFixed(2) : '?'} m: <strong>${escapeHtml(surge)}</strong>
      ${x.series && x.series.length > 1 ? sparkline(x.series) : ''}
      <span class="hint">${escapeHtml(fmtReadingTime(x.at))}. Heights on the gauge's own datum. Storm tide data &copy; State of Queensland, CC BY 4.0.</span></div>`;
  }

  // Rain forecast near a gauge (broker, from Open-Meteo, every 3 hours) and
  // observed rainfall at this gauge (or the nearest Bureau rain gauge within 15 km).
  function rainObsFor(p) {
    const ro = nat.readings && nat.readings.rainObs;
    if (!ro) return null;
    const bom = String(p.bom || '').replace(/^0+/, '');
    if (bom && ro[bom]) return Object.assign({ station: bom, exact: true }, ro[bom]);
    const st = String(p.station || '').replace(/^0+/, '');
    if (st && ro[st]) return Object.assign({ station: st, exact: true }, ro[st]);
    const g = nat.data && nat.data.gauges && nat.data.gauges.find((f) => f.properties.id === p.id || f.properties.station === p.station);
    const coords = g && g.geometry && g.geometry.coordinates;
    if (!coords) return null;
    const [lon, lat] = coords;
    let best = null, bestKm = 15;
    for (const [k, x] of Object.entries(ro)) {
      if (!Number.isFinite(x.lat) || !Number.isFinite(x.lon)) continue;
      const km = kmBetween([lat, lon], [x.lat, x.lon]);
      if (km < bestKm) { bestKm = km; best = Object.assign({ station: k, exact: false, km }, x); }
    }
    return best;
  }

  function rainHtml(p) {
    const parts = [];
    const obs = rainObsFor(p);
    if (obs && (Number.isFinite(obs.mm24h) || Number.isFinite(obs.mm6h))) {
      const m24 = Number.isFinite(obs.mm24h) ? obs.mm24h : 0;
      const heavyObs = m24 >= 100 || (Number.isFinite(obs.mm6h) && obs.mm6h >= 50);
      const bits = [];
      if (Number.isFinite(obs.mm24h)) bits.push(`${obs.mm24h.toFixed(1)} mm in the last 24 hours`);
      if (Number.isFinite(obs.mm6h)) bits.push(`${obs.mm6h.toFixed(1)} mm in 6 hours`);
      if (Number.isFinite(obs.mm1h) && obs.mm1h > 0) bits.push(`${obs.mm1h.toFixed(1)} mm in 1 hour`);
      const where = obs.exact ? '' : ` at ${obs.name || obs.station} (${obs.km.toFixed(0)} km away)`;
      parts.push(`<span class="rise${heavyObs ? ' rise-fast' : ''}">${heavyObs ? '<strong>Heavy rain recorded:</strong> ' : 'Observed rain'}${escapeHtml(where)}: ${escapeHtml(bits.join(', '))} (Bureau of Meteorology)</span>`);
    }
    const r = nat.readings && nat.readings.rain && nat.readings.rain[p.station];
    if (r) {
      const heavy = r[0] >= 50 || r[1] >= 100;
      parts.push(`<span class="rise${heavy ? ' rise-fast' : ''}">${heavy ? '<strong>Heavy rain forecast:</strong> ' : 'Rain forecast nearby: '}${Math.round(r[0])} mm in the next 24 hours, ${Math.round(r[1])} mm in 72 (Open-Meteo, CC BY 4.0)</span>`);
    }
    return parts.join('');
  }

  function sparkline(series) {
    const vals = series.map((s) => s[1]).filter(Number.isFinite);
    if (vals.length < 2) return '';
    const lo = Math.min(...vals), hi = Math.max(...vals), span = hi - lo || 1;
    const pts = vals.map((v, i) => `${(i / (vals.length - 1)) * 100},${40 - ((v - lo) / span) * 34 - 3}`).join(' ');
    const last = pts.split(' ').pop().split(',');
    return `<svg class="spark" viewBox="0 0 100 40" preserveAspectRatio="none" aria-hidden="true">
      <polyline points="${pts}" fill="none" stroke="var(--accent)" stroke-width="1.6" vector-effect="non-scaling-stroke"/>
      <circle cx="${last[0]}" cy="${last[1]}" r="1.8" fill="var(--accent)"/></svg>`;
  }

  function nearestFloodHubGauge(lat, lon, km) {
    const fh = state.floodhub;
    if (!fh || !fh.configured || !fh.gauges) return null;
    let best = null, bd = km;
    for (const g of fh.gauges) {
      if (!g.location) continue;
      const d = distKm(lat, lon, g.location.latitude, g.location.longitude);
      if (d < bd) { bd = d; best = g; }
    }
    return best;
  }

  function distKm(a, b, c, d) {
    const r = Math.PI / 180;
    const x = (d - b) * r * Math.cos(((a + c) / 2) * r), y = (c - a) * r;
    return Math.hypot(x, y) * 6371;
  }

  // Reports are kept for every numbered place, but the panel shows one at a
  // time (like the flood Scenario): pick another from Places, its map pin, or
  // the ‹ › buttons. The Report button shows or hides the panel.
  const reports = [];
  let activeReport = null;

  function showReport(r, opts) {
    if (!r) return;
    activeReport = r;
    layoutReports();
    if (!opts || opts.open !== false) openPanel('panel-report');
    r.el.classList.add('flash');
    setTimeout(() => r.el.classList.remove('flash'), 700);
  }

  // ‹ › in the Report and Scenario panels step to the next place that has a
  // report / a flood model and select it, so every panel follows along.
  function stepPlace(nums, current, dir) {
    if (!nums.length) return;
    nums.sort((a, b) => a - b);
    let next;
    if (current != null && nums.includes(current)) next = nums[(nums.indexOf(current) + dir + nums.length) % nums.length];
    else if (dir > 0) next = nums.find((n) => current == null || n > current) ?? nums[0];
    else next = nums.slice().reverse().find((n) => current == null || n < current) ?? nums[nums.length - 1];
    selectPlace(next, { fromList: true });
  }
  function stepReport(dir) {
    const cur = reports.some((r) => r.n === selectedNum) ? selectedNum : activeReport ? activeReport.n : selectedNum;
    stepPlace(reports.map((r) => r.n), cur, dir);
  }
  function stepScenario(dir) {
    const cur = state.areaKey && areaReg.get(state.areaKey);
    stepPlace(Array.from(areaReg.values()).map((a) => a.n), cur ? cur.n : selectedNum, dir);
  }
  window.__floodStepScenario = stepScenario;
  window.__floodStepReport = stepReport;
  $('reportPrev').addEventListener('click', () => stepReport(-1));
  $('reportNext').addEventListener('click', () => stepReport(1));
  $('scenarioPrev').addEventListener('click', () => stepScenario(-1));
  $('scenarioNext').addEventListener('click', () => stepScenario(1));

  // Reports and modelled areas share one set of numbers: an area modelled
  // from report 2 is also 2. A number is free once neither uses it.
  // Places can also be plain pins dropped on the map ("Add as a place").
  const pins = [];
  const PIN_COLOR = '#455a64';
  const HELP_KEY = 'floodExplorerPlacesHelpSeen';
  let placesHelpSeen = false, placesHelpOpen = false;
  try { placesHelpSeen = localStorage.getItem(HELP_KEY) === '1'; } catch (e) { /* storage blocked */ }

  // Property checks ("Check this property"): remembered so a property that
  // has been reported on stays visible and manageable beyond the transient
  // map layers the check draws. One record per spot; re-checking updates it.
  const propertyChecks = [];
  function rememberPropertyCheck(lat, lon, name) {
    const key = `${Math.round(lat * 1e5)},${Math.round(lon * 1e5)}`;
    const s = status.property || {};
    const depth = s.depth != null ? Math.round(s.depth * 100) / 100 : null;
    const headline = s.inModel === false ? 'No flood model covers this spot yet'
      : [depth > 0 ? `${depth} m under water` : (s.inModel ? 'dry this scenario' : null),
         s.floodsAt != null ? `floods at gauge ${s.floodsAt} m` : null,
         s.recorded ? `${s.recorded} recorded flood outline${s.recorded === 1 ? '' : 's'}` : null,
         s.council ? `${s.council} council map${s.council === 1 ? '' : 's'}` : null,
         s.arrival || null, s.offline || null].filter(Boolean).join(' · ');
    let rec = propertyChecks.find((c) => c.key === key);
    if (!rec) {
      rec = { key, id: Date.now().toString(36) + Math.random().toString(36).slice(2, 6), created: new Date().toISOString(), when: new Date().toLocaleDateString('en-AU', { day: 'numeric', month: 'short', year: 'numeric' }) };
      propertyChecks.push(rec);
    }
    rec.lat = lat; rec.lon = lon; rec.name = name; rec.headline = headline;
    rec.snapshot = { inModel: s.inModel === true, depth, hazard: s.hazard != null ? s.hazard : null, floodsAt: s.floodsAt != null ? s.floodsAt : null, route: s.route || null, arrival: s.arrival || null, offline: s.offline || null, recorded: s.recorded || 0, council: s.council || 0 };
    renderPlaces();
    saveSessionSoon();
    return rec;
  }

  function nearestNamed(lat, lon, km) {
    let best = null, bd = km;
    const all = nat.data ? [...nat.data.gauges, ...nat.data.storages] : [];
    for (const f of all) {
      const [x, y] = f.geometry.coordinates;
      const d = distKm(lat, lon, y, x);
      if (d < bd) { bd = d; best = f; }
    }
    return best ? { f: best, km: bd } : null;
  }

  function addPin(lat, lon, opts) {
    const o = opts || {};
    const near = nearestNamed(lat, lon, 25);
    const name = o.name || (near ? `Near ${near.f.properties.name}` : `${lat.toFixed(3)}, ${lon.toFixed(3)}`);
    const pin = { n: o.n != null && !numberUsed(o.n) ? o.n : nextNumber(), name, lat, lon, marker: null };
    if (state.lmap) {
      pin.marker = window.L.marker([lat, lon], { icon: numIcon(pin.n, PIN_COLOR), keyboard: true, title: `${pin.n}. ${name}`, alt: `${pin.n}. ${name}`, zIndexOffset: 800 }).addTo(state.lmap);
      pin.marker.bindTooltip(`${pin.n}. ${name}`, { direction: 'top', offset: [0, -12] });
      pin.marker.on('click', () => selectPlace(pin.n));
    }
    pins.push(pin);
    if (o.select === false) { renderPlaces(); return pin; }
    say(`Added place ${pin.n}: ${name}.`);
    selectPlace(pin.n);   // the new place is selected everywhere, like any other
    return pin;
  }
  window.__floodAddPin = (lat, lon) => addPin(lat, lon).n;

  function numberUsed(n) {
    return reports.some((r) => r.n === n) || Array.from(areaReg.values()).some((a) => a.n === n) || pins.some((p) => p.n === n);
  }
  function nextNumber() {
    const used = new Set([...reports.map((r) => r.n), ...Array.from(areaReg.values()).map((a) => a.n), ...pins.map((p) => p.n)]);
    for (let n = 1; ; n++) if (!used.has(n)) return n;
  }
  const hiddenNums = new Set();

  // off: nudged up and to the right, so a report pin doesn't sit on top of
  // the model's gauge marker with the same number (see declutterPins)
  function numIcon(n, color, active, off) {
    return window.L.divIcon({
      className: `report-pin${active ? ' active' : ''}`,
      html: `<span style="background:${color}">${n}</span>`, iconSize: [24, 24], iconAnchor: off ? [-6, 32] : [12, 12],
    });
  }
  // A report pin and its model's gauge marker are the same number at nearly
  // the same spot once zoomed in: offset the report pin while they'd overlap
  // (within ~26 px) so both stay visible and tappable.
  function declutterPins() {
    const m = state.lmap;
    if (!m) return;
    for (const r of reports) {
      const area = r.pin && areaForReport(r);
      if (!area || !area.marker) continue;
      const d = m.latLngToContainerPoint(r.pin.getLatLng()).distanceTo(m.latLngToContainerPoint(area.marker.getLatLng()));
      const off = d < 26;
      if (off !== !!r.pinOff) {
        r.pinOff = off;
        r.pin.setIcon(numIcon(r.n, (GAUGE_STYLE[r.kind] || GAUGE_STYLE.river).color, r === activeReport, off));
      }
    }
  }

  function closeReport(r) {
    const i = reports.indexOf(r);
    if (i < 0) return;
    reports.splice(i, 1);
    r.el.remove();
    if (activeReport === r) {
      const list = reports.slice().sort((a, b) => a.n - b.n);
      activeReport = list.find((x) => x.n > r.n) || list[list.length - 1] || null;
    }
    if (r.pin && state.lmap) state.lmap.removeLayer(r.pin);
    if (!areaByNumber(r.n)) hiddenNums.delete(r.n);
    layoutReports();
    renderPlaces();
  }

  function layoutReports() {
    const n = reports.length;
    if (!reports.includes(activeReport)) activeReport = reports[0] || null;
    const r = activeReport;
    reports.forEach((x) => { x.el.hidden = x !== r; });
    $('reportEmpty').hidden = !!r;
    $('h-report').textContent = r ? r.title : 'Report';
    $('reportPlace').textContent = r ? `${r.n}. ${r.name || ''}` : '';
    $('reportPrev').hidden = $('reportNext').hidden = n < 2;
    reports.forEach((x) => {
      if (!x.pin) return;
      x.pin.setIcon(numIcon(x.n, (GAUGE_STYLE[x.kind] || GAUGE_STYLE.river).color, x === r, x.pinOff));
    });
    reports.forEach(refreshReportLink);
    renderPlaces();
    status.report = { count: n, names: reports.map((x) => x.name), active: r ? r.name : null };
  }

  // How fast the river is rising (or falling), from the hourly readings
  // (broker and build: rise3h / rise24h, metres, to the latest reading).
  function riseHtml(r) {
    const r3 = Number.isFinite(r.rise3h) ? r.rise3h : null, r24 = Number.isFinite(r.rise24h) ? r.rise24h : null;
    if (r3 == null && r24 == null) return '';
    const word = (v) => (v > 0.02 ? `up ${v.toFixed(2)} m` : v < -0.02 ? `down ${(-v).toFixed(2)} m` : 'steady');
    const parts = [];
    if (r3 != null) parts.push(`${word(r3)} in 3 hours`);
    if (r24 != null) parts.push(`${word(r24)} in 24 hours`);
    if (r.tidal) return `<span class="rise">Tidal: rises and falls with the tide (${escapeHtml(parts.join(', '))})</span>`;
    const fast = (r3 != null && r3 >= 0.3) || (r24 != null && r24 >= 1);
    return `<span class="rise${fast ? ' rise-fast' : ''}">${fast ? '<strong>Rising:</strong> ' : ''}${escapeHtml(parts.join(', '))}</span>`;
  }

  // A gauge's level reading and flood class, redrawn when a live level arrives.
  // the hourly week where the broker has one, else the daily averages
  function histOrSpark(p, r) {
    const h = nat.history && nat.history[String(p.station || '')];
    if (h && h.points && h.points.length >= 3) return hourlyChart(h.points, classFor(p));
    return r && r.series && r.series.length ? sparkline(r.series) : '';
  }
  function levelReadingHtml(p) {
    const r = nat.readings.level && nat.readings.level[p.station];
    let html;
    if (r) {
      const live = r.latestKind === 'realtime';
      const bureau = r.latestKind === 'bureau';
      html = `<div class="reading"><span class="label">${p.kind === 'tide' ? 'Water level' : 'River level'}${live || bureau ? ' <span class="live-tag">live</span>' : ''}</span>
          <div class="big">${r.latest[1].toFixed(2)}<small>m</small></div>
          <span class="hint">${live ? `Hourly average to ${escapeHtml(fmtReadingTime(r.latest[0]))}, from <a href="https://water-monitoring.information.qld.gov.au/" target="_blank" rel="noopener">Queensland's water monitoring network</a> (© State of Queensland, CC BY 4.0)`
            : bureau ? `Reading at ${escapeHtml(fmtReadingTime(r.latest[0]))}, from the Bureau's river height pages (checked hourly)`
            : r.latestKind === 'hourly' ? `Hourly average to ${escapeHtml(fmtReadingTime(r.latest[0]))} (Water Data Online runs about a day behind)`
            : `Daily average for ${escapeHtml(fmtDate(r.latest[0]))} (Water Data Online runs about a day behind)`}, on the gauge's own datum.${(r.series || []).length && !(nat.history && nat.history[String(p.station || '')] && nat.history[String(p.station || '')].points.length >= 3) ? ` Daily averages, last ${(r.series || []).length} days:` : ''}</span>
          ${riseHtml(r)}
          ${rainHtml(p)}
          ${histOrSpark(p, r)}</div>`;
    } else {
      const c = classFor(p);
      html = c && Number.isFinite(c.level) && c.at
        ? `<div class="reading"><span class="label">${p.kind === 'tide' ? 'Water level' : 'River level'}</span>
          <div class="big">${c.level.toFixed(2)}<small>m</small></div>
          <span class="hint">From the Bureau's river height pages, ${escapeHtml(c.at.replace('T', ' ').slice(0, 16))} (local time)${c.tendency ? `, ${escapeHtml(c.tendency)}` : ''}, on the gauge's own datum. No recent reading is published for it on Water Data Online.</span>${histOrSpark(p, null)}</div>`
        : '<p class="hint">No recent reading is published for this gauge on Water Data Online.</p>';
    }
    return html + classHtml(p, r);
  }

  // Live levels through the Flood Explorer broker (broker/server.mjs), for
  // the state portals a browser can't ask directly. Only Queensland so far.
  const QLD_SITE = /^[0-9]{6}[A-Z]$/;
  const liveAsked = new Map();          // station -> time asked (ms)
  const LIVE_MS = 5 * 60e3;
  async function refreshLiveLevel(p, box) {
    const st = String(p.station || '');
    const qld = /^(QLD|QUEENSLAND)$/i.test(String(p.state || 'QLD'));
    if (!BROKER || !box || !qld || !QLD_SITE.test(st) || nat.readingsSource === 'runtime') return;
    const asked = liveAsked.get(st);
    if (asked && Date.now() - asked < LIVE_MS) return;
    liveAsked.set(st, Date.now());
    let res;
    try {
      const r = await fetch(`${BROKER}/v1/levels?sites=${encodeURIComponent(st)}`, { signal: AbortSignal.timeout(10000) });
      res = await r.json();
      if (!r.ok && !(res && res.sites)) throw new Error(`HTTP ${r.status}${res && res.error ? `: ${res.error}` : ''}`);
    } catch (e) {
      liveAsked.delete(st);
      logProblem('live', `Live level for ${p.name || st} unavailable`, String(e && e.message || e));
      return;
    }
    const got = res && res.sites && res.sites[st];
    if (!got || !Array.isArray(got.latest)) return;
    if (!nat.readings.level) nat.readings.level = {};
    const old = nat.readings.level[st];
    const t = (x) => new Date(x && x[0]).getTime();
    if (old && !(t(got.latest) > t(old.latest))) return;
    nat.readings.level[st] = { unit: 'm', series: old ? old.series : [], ...(old || {}), latest: got.latest, latestKind: 'realtime' };
    if (box.isConnected) box.innerHTML = levelReadingHtml(p);
    status.live = { station: st, at: got.latest[0], level: got.latest[1] };
  }

  // The broker's hourly record of a gauge for the last 7 days (it keeps
  // every gauge's level from each refresh, so Bureau-only gauges get a trend
  // too): fetched when the report opens, kept 10 minutes.
  const HIST_MS = 10 * 60e3;
  nat.history = nat.history || {};
  async function refreshHistory(p, box) {
    const st = String(p.station || '');
    if (box && st && nat.readings.level && nat.readings.level[st] && !nat.readings.level[st].series) {
      ensureSeries('level', st).then((ser) => { if (ser && ser.length && box.isConnected) box.innerHTML = levelReadingHtml(p); });
    }
    if (!BROKER || !box || !st || DATA_SOURCE !== 'runtime') return;
    const had = nat.history[st];
    if (had && Date.now() - had.asked < HIST_MS) return;
    nat.history[st] = { asked: Date.now(), points: had ? had.points : [] };
    try {
      const r = await fetch(`${BROKER}/v1/history?site=${encodeURIComponent(st)}`, { signal: AbortSignal.timeout(15000) });
      if (!r.ok) return;
      const h = await r.json();
      nat.history[st].points = (h.points || []).filter((x) => Array.isArray(x) && Number.isFinite(x[1]));
    } catch (e) { return; /* the daily series still shows */ }
    status.history = { station: st, points: nat.history[st].points.length };
    if (box.isConnected && nat.history[st].points.length >= 3) box.innerHTML = levelReadingHtml(p);
  }
  // a week of hourly levels: the line, the day ticks, and its low and high
  function hourlyChart(points, c) {
    const pts = points.map((x) => [new Date(x[0]).getTime(), x[1]]).filter((x) => Number.isFinite(x[0]));
    if (pts.length < 3) return '';
    const t0 = pts[0][0], t1 = pts[pts.length - 1][0], span = Math.max(1, t1 - t0);
    let lo = Math.min(...pts.map((x) => x[1])), hi = Math.max(...pts.map((x) => x[1]));
    // flood class lines when they're near the range shown
    const lines = c ? ['minor', 'moderate', 'major'].filter((k) => c[k] != null && c[k] <= hi + Math.max(0.5, (hi - lo) * 0.5) && c[k] >= lo - 0.5).map((k) => [k, c[k]]) : [];
    for (const [, v] of lines) { lo = Math.min(lo, v); hi = Math.max(hi, v); }
    const pad = (hi - lo) * 0.08 || 0.1, y0 = lo - pad, y1 = hi + pad;
    const X = (t) => ((t - t0) / span) * 100, Y = (v) => 52 - ((v - y0) / (y1 - y0)) * 48;
    // break the line where an hour or more is missing (a refresh that failed)
    let d = '', prev = null;
    for (const [t, v] of pts) { d += `${prev != null && t - prev > 3 * 3600e3 ? 'M' : (d ? 'L' : 'M')}${X(t).toFixed(2)},${Y(v).toFixed(2)}`; prev = t; }
    const days = [];
    for (let t = new Date(t0).setHours(24, 0, 0, 0); t < t1; t += 86400e3) days.push(t);
    const last = pts[pts.length - 1];
    const lineCol = { minor: '#f9a825', moderate: '#e65100', major: '#b71c1c' };
    return `<div class="hist"><svg class="hist-svg" viewBox="0 0 100 56" preserveAspectRatio="none" role="img" aria-label="River level, last ${Math.round(span / 86400e3) || 1} days, hourly">
      ${days.map((t) => `<line x1="${X(t).toFixed(2)}" x2="${X(t).toFixed(2)}" y1="2" y2="54" class="hist-day" vector-effect="non-scaling-stroke"/>`).join('')}
      ${lines.map(([k, v]) => `<line x1="0" x2="100" y1="${Y(v).toFixed(2)}" y2="${Y(v).toFixed(2)}" stroke="${lineCol[k]}" stroke-dasharray="2 2" stroke-width="1" vector-effect="non-scaling-stroke"/>`).join('')}
      <path d="${d}" fill="none" stroke="var(--accent)" stroke-width="1.8" vector-effect="non-scaling-stroke"/>
      <circle cx="${X(last[0]).toFixed(2)}" cy="${Y(last[1]).toFixed(2)}" r="1.6" fill="var(--accent)"/></svg>
      <span class="hint">Hourly, ${escapeHtml(new Date(t0).toLocaleDateString('en-AU', { weekday: 'short', day: 'numeric', month: 'short' }))} to now · low ${Math.min(...pts.map((x) => x[1])).toFixed(2)} m, high ${Math.max(...pts.map((x) => x[1])).toFixed(2)} m${lines.length ? ` · dashed: ${lines.map(([k]) => k).join(', ')} flood level` : ''} (the broker's record)</span></div>`;
  }

  // A gauge's (or dam's) daily series: the map polls /v1/now, which leaves
  // the series out (most of the readings' size); a report asks for its own.
  async function ensureSeries(kind, st) {
    const box = nat.readings && nat.readings[kind];
    const r = box && box[st];
    if (!r || r.series || !BROKER || DATA_SOURCE !== 'runtime' || nat.readingsSource !== 'runtime') return r ? r.series || null : null;
    try {
      const res = await fetch(`${BROKER}/v1/series?site=${encodeURIComponent(st)}${kind === 'storage' ? '&kind=storage' : ''}`, { signal: AbortSignal.timeout(15000) });
      if (!res.ok) return null;
      const j = await res.json();
      // the readings may have been replaced meanwhile: set it on the current entry
      const cur = nat.readings[kind] && nat.readings[kind][st];
      if (cur && !cur.series) cur.series = Array.isArray(j.series) ? j.series : [];
      return cur ? cur.series : null;
    } catch (e) { return null; }
  }

  function openReport(f, opts) {
    const select = !opts || opts.select !== false;
    nat.picked = f;
    const p = f.properties;
    const [lon, lat] = f.geometry.coordinates;
    const id = `${p.kind}:${p.id}`;
    const existing = reports.find((r) => r.id === id);
    if (existing) { selectPlace(existing.n); return; }
    const st = GAUGE_STYLE[p.kind] || GAUGE_STYLE.river;
    const num = nextNumber();
    let html = `<div class="card-head"><span class="pin-num" style="background:${st.color}">${num}</span><div style="min-width:0"><span class="kind">${escapeHtml(st.label)}</span><h3>${escapeHtml(p.name || 'Unnamed')}</h3></div><button type="button" class="close js-close" aria-label="Remove this report" title="Remove this report">×</button></div>`;
    const facts = [];
    if (p.kind === 'storage') {
      if (p.river) facts.push(['River', p.river]);
      if (p.capacity_ml) facts.push(['Capacity', `${Math.round(p.capacity_ml).toLocaleString('en-AU')} ML`]);
      if (p.year) facts.push(['Completed', p.year]);
      if (p.owner) facts.push(['Data owner', p.owner]);
    } else {
      if (p.basin) facts.push(['Basin', p.basin]);
      if (p.station) facts.push(['Station', p.station]);
      if (p.agency) facts.push(['Operated by', p.agency]);
    }
    if (p.state) facts.push(['State', p.state]);
    facts.push(['Location', `${lat.toFixed(4)}, ${lon.toFixed(4)}`]);
    html += `<dl class="facts">${facts.map(([k, v]) => `<dt>${escapeHtml(k)}</dt><dd>${escapeHtml(String(v))}</dd>`).join('')}</dl>`;

    // latest reading
    if (p.kind === 'storage') {
      const r = nat.readings.storage && nat.readings.storage[p.station];
      if (r) {
        const fill = storageFill(p);
        html += `<div class="reading"><span class="label">Storage volume</span>
          <div class="big">${fill != null ? Math.round(fill * 100) + '<small>% full</small>' : Math.round(r.latest[1]).toLocaleString('en-AU') + '<small>ML</small>'}</div>
          ${fill != null ? `<div class="bar"><span style="width:${Math.min(100, fill * 100)}%;background:${storageColor(p)}"></span></div>` : ''}
          <span class="hint">${Math.round(r.latest[1]).toLocaleString('en-AU')} ML, daily average for ${escapeHtml(fmtDate(r.latest[0]))}</span>
          <span class="js-storage-spark">${r.series ? sparkline(r.series) : ''}</span></div>`;
        if (fill != null && fill >= 1) html += '<p class="hint"><strong>At or above full supply.</strong> Dams at full supply may be releasing or spilling water downstream.</p>';
      } else {
        html += '<p class="hint">No recent storage reading is published for this dam.</p>';
      }
    } else {
      html += `<div class="js-reading">${levelReadingHtml(p)}</div>`;
    }
    html += warningsHtml(p);

    if (p.kind === 'storage') html += '<div class="js-history"></div>';

    // Google Flood Hub near this point
    const fhg = p.kind !== 'storage' ? nearestFloodHubGauge(lat, lon, 15) : null;
    if (fhg && fhg.status) {
      const s = sev(fhg.status.severity);
      html += `<div class="reading"><span class="label">Google Flood Hub forecast nearby</span>
        <div><span class="sev" style="background:${s.color}">${s.label}</span> ${escapeHtml([fhg.siteName, fhg.river].filter(Boolean).join(', '))}</div>
        <span class="hint">${escapeHtml(gaugeLine(fhg))}</span></div>`;
    }

    // what can be done here
    const kind = p.kind === 'tide' ? 'coast' : 'river';
    html += `<div class="actions">
      <button type="button" class="btn primary js-model">${kind === 'coast' ? 'Model coastal flooding here' : 'Model flooding here'}</button>
      <button type="button" class="btn js-zoom">Zoom to</button>
      ${stateLayerFor(p.state) ? `<button type="button" class="btn js-state">Show ${escapeHtml(stateLayerFor(p.state).state)} flood mapping</button>` : ''}
    </div>`;
    const links = [];
    if (p.url) links.push(`<a href="${escapeHtml(p.url)}" target="_blank" rel="noopener">BoM water storage page</a>`);
    links.push('<a href="https://www.bom.gov.au/water/data/" target="_blank" rel="noopener">Water Data Online</a>');
    if (p.kind !== 'storage') links.push(`<a href="https://www.bom.gov.au/australia/flood/" target="_blank" rel="noopener">BoM flood warnings</a>`);
    html += `<p class="hint">${links.join(' · ')}</p>`;
    html += '<p class="hint">Readings: Water Data Online (Bureau of Meteorology and data owners). Not an official warning.</p>';

    const el = document.createElement('article');
    el.className = 'report-card';
    el.innerHTML = html;
    const q = (sel) => el.querySelector(sel);
    const title = p.kind === 'storage' ? 'Dam report' : p.kind === 'tide' ? 'Tide gauge report' : 'River gauge report';
    const r = { id, n: num, name: p.name, title, el, pin: null, lat, lon, kind: p.kind };
    if (state.lmap) {
      r.pin = window.L.marker([lat, lon], { icon: numIcon(num, st.color), keyboard: false, zIndexOffset: 1000 });
      if (!hiddenNums.has(num)) r.pin.addTo(state.lmap);
      r.pin.on('click', () => selectPlace(r.n));
    }
    q('.js-close').addEventListener('click', () => closeReport(r));
    q('.js-model').addEventListener('click', () => {
      const linked = areaForReport(r);
      if (linked) { activateArea(linked.key, { fit: true }); openPanel('panel-scenario'); return; }
      modelHere(lat, lon, { kind, name: p.name, reportId: id });
    });
    q('.js-zoom').addEventListener('click', () => state.lmap && state.lmap.setView([lat, lon], 13));
    const sl = stateLayerFor(p.state);
    if (sl && q('.js-state')) q('.js-state').addEventListener('click', () => {
      if (sl.layer && state.lmap) {
        sl.layer.userOn = true; sl.layer.addTo(state.lmap);
        state.lmap.setView([lat, lon], Math.max(state.lmap.getZoom(), sl.minZoom || 11));
        syncLayerLists(); renderOverlayLegend();
      }
    });
    if (p.kind === 'storage') {
      addWaterHistory(p.id, q('.js-history'));
      const sp = q('.js-storage-spark');
      if (sp && !sp.innerHTML) ensureSeries('storage', p.station).then((ser) => { if (ser && ser.length && sp.isConnected) sp.innerHTML = sparkline(ser); });
    }
    else { refreshLiveLevel(p, q('.js-reading')); refreshHistory(p, q('.js-reading')); }
    const link = document.createElement('div');
    link.className = 'js-link';
    q('.actions').before(link);
    reports.push(r);
    selectedNum = num;
    $('reportBody').appendChild(el);
    if (select) selectPlace(r.n); else renderPlaces();
    return r;
  }
  window.__floodOpenStorage = (index) => {
    const f = nat.data && nat.data.storages[index || 0];
    if (f) openReport(f);
    return !!f;
  };
  function stateLayerFor(st) {
    const code = String(st || '').toUpperCase();
    const norm = { QUEENSLAND: 'QLD', 'NEW SOUTH WALES': 'NSW' }[code] || code;
    return STATE_OVERLAYS.find((o) => o.state === norm && o.layer) || null;
  }

  // tests: Queensland portal stations on the map, and a report by station
  window.__floodQldStations = (n) => ((nat.data && nat.data.gauges) || []).map((g) => g.properties)
    .filter((p) => QLD_SITE.test(String(p.station || '')) && /^(QLD|QUEENSLAND)$/i.test(String(p.state || ''))).slice(0, n || 40).map((p) => p.station);
  window.__floodOpenGauge = (station) => {
    const f = nat.data && nat.data.gauges.find((g) => g.properties.station === station);
    if (f) openReport(f);
    return !!f;
  };
  window.__floodOpenReport = (index) => {
    const f = nat.data && nat.data.gauges.filter((g) => g.properties.kind === 'forecast')[index || 0];
    if (f) openReport(f);
    return !!f;
  };

  // A tap on empty map in the national view
  const ICON_ADD_PLACE = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 21s-6.5-5.6-6.5-11a6.5 6.5 0 0 1 13 0c0 5.4-6.5 11-6.5 11Z"/><path d="M12 7v6M9 10h6"/></svg>';
  // Tapping the map shows a small popup with one add-a-place button: an
  // empty spot becomes a pinned place, a gauge or dam becomes a report.
  function spotPopup(latlng, html, label, onAdd) {
    const div = document.createElement('div');
    div.className = 'spot';
    div.innerHTML = `<div class="spot-text">${html}</div>
      <button type="button" class="spot-add" aria-label="${escapeHtml(label)}" title="${escapeHtml(label)}">${ICON_ADD_PLACE}</button>`;
    div.querySelector('.spot-add').addEventListener('click', (ev) => {
      ev.stopPropagation();
      state.lmap.closePopup();
      onAdd();
    });
    window.L.popup({ closeButton: false, className: 'spot-popup', offset: [0, -4], autoPanPadding: [24, 24] })
      .setLatLng(latlng).setContent(div).openOn(state.lmap);
  }

  function onNationalClick(e) {
    const { lat, lng } = e.latlng;
    const near = nearestNamed(lat, lng, 25);
    const coord = `${Math.abs(lat).toFixed(4)}° ${lat < 0 ? 'S' : 'N'}, ${Math.abs(lng).toFixed(4)}° ${lng < 0 ? 'W' : 'E'}`;
    spotPopup(e.latlng, `<span class="spot-coord">${coord}</span>
      ${near ? `<span class="spot-near">${near.km.toFixed(1)} km from ${escapeHtml(near.f.properties.name)}</span>` : ''}`,
    'Add as a place', () => addPin(lat, lng));
  }

  function onDotClick(f, latlng) {
    if (Date.now() < suppressClickUntil) return;
    const p = f.properties;
    const existing = reports.find((r) => r.id === `${p.kind}:${p.id}`);
    if (existing) { selectPlace(existing.n); return; }   // already a place
    const st = GAUGE_STYLE[p.kind] || GAUGE_STYLE.river;
    let sub = st.label;
    if (p.kind === 'storage') {
      const fill = storageFill(p);
      if (fill != null) sub += ` · ${Math.round(fill * 100)}% full`;
    } else {
      const rd = nat.readings && nat.readings.level && nat.readings.level[p.station];
      if (rd && rd.latest) sub += ` · ${Number(rd.latest[1]).toFixed(2)} m`;
    }
    spotPopup(latlng, `<span class="spot-name"><i class="spot-dot" style="background:${p.kind === 'storage' ? storageColor(p) : st.color}"></i>${escapeHtml(p.name || st.label)}</span>
      <span class="spot-near">${escapeHtml(sub)}</span>`,
    'Add as a place and open its report', () => openReport(f));
  }
  window.__floodTapDot = (kind, i) => {
    const list = kind === 'storage' ? nat.data.storages : nat.data.gauges.filter((g) => !kind || g.properties.kind === kind);
    const f = list[i || 0];
    if (!f) return false;
    onDotClick(f, window.L.latLng(f.geometry.coordinates[1], f.geometry.coordinates[0]));
    return true;
  };




  /* ---------- satellite water history for dams (DEA Waterbodies) */
  // Digital Earth Australia maps every waterbody seen by Landsat since 1987
  // and publishes, for each one, the percentage of its area seen wet on
  // every clear pass. The build fetches these for every BoM dam weekly
  // (flood waterhistory), because DEA's files block browsers.
  status.waterbodies = {};

  let historyPromise = null;
  function loadWaterHistory() {
    if (!historyPromise) {
      historyPromise = fetch('data/national/waterhistory.json', { cache: 'no-cache' })
        .then((r) => (r.ok ? r.json() : {}))
        .catch(() => ({}));
    }
    return historyPromise;
  }

  // monthly series -> [[time, pc], ...] without empty months
  function expandMonthly(h) {
    const [y0, m0] = h.start.split('-').map(Number);
    const out = [];
    h.monthly.forEach((v, i) => {
      if (v == null) return;
      out.push([Date.UTC(y0, m0 - 1 + i, 15), v]);
    });
    return out;
  }

  function historyChart(series) {
    const t0 = series[0][0], t1 = series[series.length - 1][0];
    const span = t1 - t0 || 1;
    const X = (t) => 4 + ((t - t0) / span) * 292, Y = (v) => 86 - (Math.max(0, Math.min(100, v)) / 100) * 78;
    const pts = series.map(([t, v]) => `${X(t).toFixed(1)},${Y(v).toFixed(1)}`).join(' ');
    const y0 = new Date(t0).getFullYear(), y1 = new Date(t1).getFullYear();
    const ticks = [];
    const step = Math.max(1, Math.round((y1 - y0) / 4));
    for (let y = Math.ceil(y0 / step) * step; y <= y1; y += step) {
      const x = X(Date.UTC(y, 0, 1));
      if (x > 20 && x < 280) ticks.push(`<line x1="${x}" x2="${x}" y1="8" y2="86" stroke="var(--line)"/><text x="${x}" y="99" text-anchor="middle">${y}</text>`);
    }
    return `<svg viewBox="0 0 300 104" style="width:100%;height:auto;display:block;font:9px var(--font-data);fill:var(--muted)" role="img" aria-label="Percentage of the waterbody seen wet, ${y0} to ${y1}">
      ${ticks.join('')}
      <line x1="4" x2="296" y1="${Y(100)}" y2="${Y(100)}" stroke="var(--line)"/><line x1="4" x2="296" y1="${Y(50)}" y2="${Y(50)}" stroke="var(--line)" stroke-dasharray="2 3"/>
      <text x="6" y="${Y(100) + 9}">100%</text><text x="6" y="${Y(50) - 2}">50%</text>
      <polyline points="${pts}" fill="none" stroke="var(--accent)" stroke-width="1.2" vector-effect="non-scaling-stroke"/>
    </svg>`;
  }

  async function addWaterHistory(storageId, box) {
    box.innerHTML = '<p class="hint">Looking up satellite records for this dam…</p>';
    const all = await loadWaterHistory();
    const h = all[storageId];
    if (!h || h.missing || !h.monthly) {
      box.innerHTML = '<p class="hint">No satellite water record is available for this dam.</p>';
      status.waterbodies = { ok: false, error: 'no record' };
      return;
    }
    const series = expandMonthly(h);
    const recent = series.filter(([t]) => t > Date.now() - 5 * 365 * 864e5).map(([, v]) => v);
    const lo = recent.length ? Math.min(...recent) : NaN, hi = recent.length ? Math.max(...recent) : NaN;
    box.innerHTML = `<div class="reading"><span class="label">Water seen by satellite</span>
      <div class="big">${Math.round(h.last[1])}<small>% of surface wet</small></div>
      <span class="hint">On ${escapeHtml(fmtDate(h.last[0]))}.${recent.length ? ` Over the last 5 years the monthly average ranged ${Math.round(lo)}–${Math.round(hi)}%.` : ''} ${h.passes.toLocaleString('en-AU')} clear Landsat passes since ${h.start.slice(0, 4)}.</span>
      ${historyChart(series)}
      <span class="hint">Monthly averages. Digital Earth Australia Waterbodies (Geoscience Australia), CC BY 4.0. Surface area, not volume.</span></div>`;
    status.waterbodies = { ok: true, points: series.length };
  }

  window.__floodOpenDam = (name) => {
    const f = nat.data && nat.data.storages.find((x) => !name || (x.properties.name || '').includes(name));
    if (f) openReport(f);
    return !!f;
  };

  /* ---------- storm tide for coastal models */
  // Queensland standard ports: highest astronomical tide and mean high water
  // springs in metres AHD (MSQ 2025 semidiurnal tidal planes, converted with
  // MSQ's standard port datum levels).
  const TIDE_PORTS = [
    ['Gold Coast Seaway', -27.94, 153.43, 1.97, 1.47, 0.760], ['Brisbane Bar', -27.37, 153.17, 2.78, 2.22, 1.243],
    ['Mooloolaba', -26.68, 153.13, 2.21, 1.70, 0.990], ['Urangan', -25.30, 152.91, 4.33, 3.54, 2.040],
    ['Bundaberg (Burnett Heads)', -24.76, 152.40, 3.68, 2.94, 1.693], ['Gladstone', -23.83, 151.25, 4.87, 4.01, 2.268],
    ['Rosslyn Bay', -23.16, 150.79, 5.21, 4.28, 2.360], ['Mackay Outer Harbour', -21.10, 149.23, 6.62, 5.35, 2.941],
    ['Bowen', -20.02, 148.25, 3.77, 2.88, 1.776], ['Townsville', -19.25, 146.83, 4.22, 3.17, 1.856],
    ['Lucinda', -18.52, 146.33, 4.06, 3.04, 1.844], ['Cairns', -16.92, 145.78, 3.57, 2.67, 1.643],
    ['Port Douglas', -16.48, 145.46, 3.40, 2.54, 1.581], ['Weipa', -12.67, 141.86, 3.33, 3.01, 1.752], ['Karumba', -17.49, 140.83, 4.85, 3.91, 2.184],
  ].map(([name, lat, lon, hat, mhws, ahd]) => ({ name, lat, lon, hat: Math.round((hat - ahd) * 100) / 100, mhws: Math.round((mhws - ahd) * 100) / 100 }));
  const SURGES = [['Tropical low', 0.5], ['Category 1–2 cyclone', 1.0], ['Category 3 cyclone', 2.0], ['Category 4–5 cyclone', 3.0]];
  // Tide heights for anywhere on the coast: Queensland's standard ports
  // (Maritime Safety Queensland) where one is within 60 km, otherwise the
  // nearest coastal point of the national tide model grid (AIMS, EOT20)
  let tideGrid;
  function loadTideGrid() {
    if (tideGrid !== undefined) return;
    tideGrid = null;
    fetch('data/tides.json').then((r) => (r.ok ? r.json() : null)).then((d) => {
      tideGrid = d && d.points && d.points.length ? d : null;
      if (tideGrid && state.a) { renderTideRow(); if (!$('stormTide').hidden) renderStormTide(); }
    }).catch(() => {});
  }
  function tidePort() {
    const g = state.geo;
    if (!g) return null;
    loadTideGrid();
    const c = [(g.north + g.south) / 2, (g.east + g.west) / 2];
    let best = null;
    for (const p of TIDE_PORTS) { const km = kmBetween([p.lat, p.lon], c); if (km < 60 && (!best || km < best.km)) best = { ...p, km, src: 'msq' }; }
    if (best || !tideGrid) return best;
    // distance from the model's box to a point (0 inside it)
    const toBox = (la, lo) => kmBetween([Math.min(g.north, Math.max(g.south, la)), Math.min(g.east, Math.max(g.west, lo))], [la, lo]);
    for (const [la, lo, hat, mhws] of tideGrid.points) {
      if (Math.abs(la - c[0]) > 1.5 || Math.abs(lo - c[1]) > 1.5) continue;
      const km = toBox(la, lo);
      if (km < 60 && (!best || km < best.km)) best = { name: `the coast at ${la.toFixed(2)}, ${lo.toFixed(2)}`, lat: la, lon: lo, hat, mhws, km, src: 'eot20' };
    }
    return best;
  }
  const tideSource = (p) => (p.src === 'eot20' ? 'national tide model (AIMS, EOT20, CC BY 4.0), metres above mean sea level' : 'Maritime Safety Queensland');
  function stormTideTotal() { return parseFloat($('tideM').value || 0) + parseFloat($('surgeM').value) + parseFloat($('setupM').value); }
  function renderStormTide(fromTideChoice) {
    const p = tidePort();
    $('tidePort').innerHTML = p
      ? (p.src === 'eot20'
        ? `Tides at <strong>${escapeHtml(p.name)}</strong>${p.km > 1 ? ` (${Math.round(p.km)} km away)` : ''}: high spring tide ${p.mhws.toFixed(2)} m, highest tide ${p.hat.toFixed(2)} m (${tideSource(p)}; mean sea level is close to AHD).`
        : `Nearest standard port: <strong>${escapeHtml(p.name)}</strong> (${Math.round(p.km)} km): high spring tide ${p.mhws.toFixed(2)} m, highest astronomical tide ${p.hat.toFixed(2)} m AHD (${tideSource(p)}).`)
      : 'No tide heights found within 60 km: enter the tide height for this coast (metres above sea level).';
    if (fromTideChoice && p) {
      const t = $('tideLevel').value;
      $('tideM').value = (t === 'hat' ? p.hat : t === 'mhws' ? p.mhws : 0).toFixed(2);
    } else if (fromTideChoice && $('tideLevel').value === 'msl') $('tideM').value = '0';
    $('surgeOut').textContent = `${parseFloat($('surgeM').value).toFixed(1)} m`;
    $('setupOut').textContent = `${parseFloat($('setupM').value).toFixed(1)} m`;
    $('applyStormTide').textContent = `Set bay level to ${stormTideTotal().toFixed(2)} m`;
    const box = $('surgePresets');
    if (!box.childElementCount) {
      box.innerHTML = SURGES.map(([n, m], i) => `<button type="button" class="btn small" data-surge="${i}">${n}<br><small>${m} m surge</small></button>`).join('');
      box.querySelectorAll('[data-surge]').forEach((b) => b.addEventListener('click', () => { $('surgeM').value = SURGES[+b.dataset.surge][1]; renderStormTide(); applyStormTide(); }));
    }
  }
  function applyStormTide() {
    const v = Math.round(stormTideTotal() * 100) / 100;
    ctl.bayLevel.max = Math.max(2.5, Math.ceil(v + 1));
    ctl.bayLevel.value = v;
    state.base = null;
    syncOutputs();
    runScenario();
    status.stormTide = { bay: v, port: (tidePort() || {}).name || null };
    return status.stormTide;
  }
  $('stormTide').addEventListener('toggle', () => { if ($('stormTide').open) renderStormTide(true); });
  $('tideLevel').addEventListener('change', () => renderStormTide(true));
  ['tideM', 'surgeM', 'setupM'].forEach((id) => $(id).addEventListener('input', () => renderStormTide()));
  $('applyStormTide').addEventListener('click', applyStormTide);
  window.__floodTidePort = async () => {
    loadTideGrid();
    for (let i = 0; i < 40 && tideGrid === null; i++) await new Promise((r) => setTimeout(r, 250));
    const p = tidePort();
    return p && { name: p.name, src: p.src, km: Math.round(p.km), mhws: p.mhws, hat: p.hat, grid: tideGrid ? tideGrid.points.length : 0 };
  };
  window.__floodStormTide = (tide, surge, setup) => {
    $('stormTide').open = true; $('tideLevel').value = tide || 'hat'; renderStormTide(true);
    if (surge != null) $('surgeM').value = surge; if (setup != null) $('setupM').value = setup;
    renderStormTide(); return applyStormTide();
  };

  /* ---------- storm (flash flooding) controls */
  function renderStorm() {
    const mode = ctl.floodType.value, on = mode !== 'river';
    $('stormSet').hidden = !on || scenarioEmpty;
    $('riverSet').hidden = mode === 'flash' || scenarioEmpty;
    $('rainMmOut').textContent = `${ctl.rainMm.value} mm`;
    status.flash = on && state.flash ? Object.assign({ mode }, state.flash) : null;
    if (!on) return;
    const f = state.flash;
    $('stormSummary').innerHTML = (f
      ? (f.excessMm > 0
        ? `${Math.round(f.excessMm)} mm runs off after ${Math.round(parseFloat(ctl.rainMm.value) - f.excessMm)} mm soaks in. Creeks rise up to ${fmt(f.maxCreekRise, 1)} m; overland flow covers ${fmt(f.overlandKm2, 2)} km²; water ponds over ${fmt(f.pondKm2, 2)} km².`
        : 'All of this rain soaks in: no runoff.')
      : '') + (f && f.pipedMm > 0 ? ` Pipes take up to ${Math.round(f.pipedMm)} mm of that runoff from built-up land (${fmt(f.urbanKm2, 1)} km², where OpenStreetMap shows buildings) and carry it to the creeks.`
        : parseFloat(ctl.pipes.value) > 0 ? (state.areaKey && (areaReg.get(state.areaKey) || {}).impactLoading ? ' Finding built-up land for the pipes…' : ' No built-up land found for the pipes here.') : '')
      + (parseFloat(ctl.warming.value) > 0 ? ` In a climate ${ctl.warming.value} °C warmer the same storm brings about ${Math.round((F.stormUplift(parseFloat(ctl.stormHours.value), parseFloat(ctl.warming.value)) - 1) * 100)}% more rain (${Math.round(parseFloat(ctl.rainMm.value) * F.stormUplift(parseFloat(ctl.stormHours.value), parseFloat(ctl.warming.value)))} mm; draft Australian Rainfall and Runoff guidance: about 15% per °C for an hour's storm, 8% for a day's).` : '')
      + ' Screening only: pipe capacity is a single typical rate, and culverts, blockages and timing are not modelled.';
    const g = state.geo;
    $('ifdNote').innerHTML = `The buttons are example storms, not official values for this place. For the official design rainfall here (such as the 1% annual chance storm), look up ${g ? `${((g.north + g.south) / 2).toFixed(4)}, ${((g.east + g.west) / 2).toFixed(4)}` : 'its coordinates'} in the <a href="https://www.bom.gov.au/water/designRainfalls/revised-ifd/?year=2016" target="_blank" rel="noopener">Bureau's design rainfall tool</a> and set the rain and duration to match.`;
    const box = $('stormPresets');
    if (!box.childElementCount) {
      box.innerHTML = STORMS.map(([n, mm, h], i) => `<button type="button" class="btn small" data-storm="${i}">${n}<br><small>${mm} mm in ${h < 1 ? `${h * 60} min` : `${h} h`}</small></button>`).join('');
      box.querySelectorAll('[data-storm]').forEach((b) => b.addEventListener('click', () => {
        const [, mm, h] = STORMS[+b.dataset.storm];
        ctl.rainMm.value = mm; ctl.stormHours.value = String(h);
        runScenario();
      }));
    }
  }
  window.__floodSetStorm = (mode, mm, h, ground) => {
    ctl.floodType.value = mode; if (mm != null) ctl.rainMm.value = mm; if (h != null) ctl.stormHours.value = String(h); if (ground) ctl.ground.value = ground;
    runScenario(); return status.flash;
  };

  /* ---------- flood classes, warnings and level points */
  function classFor(p) { return p && p.bom != null && nat.floodclass ? nat.floodclass[String(p.bom)] || null : null; }
  function floodStatus(v, c) {
    if (!c || v == null) return null;
    if (c.major != null && v >= c.major) return 'major';
    if (c.moderate != null && v >= c.moderate) return 'moderate';
    if (c.minor != null && v >= c.minor) return 'minor';
    return 'below minor';
  }
  function classHtml(p, r) {
    const c = classFor(p);
    if (!c) return '';
    const st = r ? floodStatus(r.latest[1], c) : null;
    const cell = (v) => (v == null ? '–' : `${v.toFixed(2)} m${c.zero != null ? `<br><small>${(c.zero + v).toFixed(2)} m AHD</small>` : ''}`);
    const bomNow = c.class && !/no classification/i.test(c.class) ? `<span class="hint bom-now">Bureau: ${escapeHtml(String(c.class).toLowerCase())}${c.tendency ? `, ${escapeHtml(c.tendency)}` : ''}${Number.isFinite(c.level) ? ` at ${c.level.toFixed(2)} m` : ''}${c.at ? ` (${escapeHtml(c.at.replace('T', ' ').slice(0, 16))}, local time)` : ''}.</span>` : '';
    return `<div class="classes"><span class="label">Flood classes (BoM)</span>${st ? ` <strong>· now ${st}</strong>` : ''}${bomNow}
      <table><tr><th>Minor</th><th>Moderate</th><th>Major</th></tr><tr><td>${cell(c.minor)}</td><td>${cell(c.moderate)}</td><td>${cell(c.major)}</td></tr></table>
      <span class="hint">On the gauge board${c.zero != null ? `; gauge zero is ${c.zero.toFixed(2)} m AHD, so these can set a flood model's level` : '; no gauge zero is published, so they can\'t be converted to heights'}.</span></div>`;
  }
  function warningsFor(p) {
    const list = (nat.warnings && nat.warnings.warnings) || [];
    const st = String(p.state || '').toUpperCase().slice(0, 3);
    const keys = [p.basin, p.river_name, p.name].filter(Boolean).map((x) => String(x).toLowerCase().replace(/ (river )?basin$/, '').replace(/\s+r(iver)?\b.*$/, ''))
      .filter((k) => k.length > 3);
    return list.filter((w) => (!st || !w.state || w.state === st || (st === 'QUE' && w.state === 'QLD'))
      && keys.some((k) => w.title.toLowerCase().includes(k)));
  }
  function warningsHtml(p) {
    const ws = warningsFor(p);
    if (!ws.length) return '';
    return `<div>${ws.map((w) => warnItemHtml(w, `${w.severity && w.severity !== 'Unknown' ? `${escapeHtml(w.severity)} · ` : ''}Current Bureau of Meteorology warning${w.published ? ` · ${escapeHtml(fmtWarnTime(w.published))}` : ''}`)).join('')}</div>`;
  }
  function fmtWarnTime(t) {
    const d = new Date(t);
    return Number.isNaN(d.getTime()) ? t : `issued ${d.toLocaleString('en-AU', { weekday: 'short', day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' })}`;
  }
  // Warnings on the map. The Bureau's CAP files sometimes carry the warned
  // area's outline; otherwise the area is drawn around the gauges on the
  // rivers the warning names (the same match a gauge report uses).
  const WARN_COLOR = { extreme: '#b71c1c', major: '#b71c1c', severe: '#e65100', moderate: '#e65100', minor: '#f9a825' };
  const warnColor = (w) => WARN_COLOR[String(w.severity || '').toLowerCase()] || (/watch/i.test(w.title || '') ? '#6a1b9a' : '#c62828');
  const allWarnings = () => (nat.warnings && nat.warnings.warnings) || [];
  const warnKey = (w) => w.id || w.title;
  function warningGauges(w) {
    const gs = (nat.data && nat.data.gauges) || [];
    const hit = (f) => warningsFor(f.properties).some((x) => warnKey(x) === warnKey(w));
    const main = gs.filter((f) => f.properties.kind !== 'river' && hit(f));
    return main.length ? main : gs.filter(hit).slice(0, 60);
  }
  // convex hull (monotone chain) of [lat, lon] points
  function hull(pts) {
    const p = [...pts].sort((a, b) => a[1] - b[1] || a[0] - b[0]);
    if (p.length < 3) return p;
    const cross = (o, a, b) => (a[1] - o[1]) * (b[0] - o[0]) - (a[0] - o[0]) * (b[1] - o[1]);
    const lo = [], up = [];
    for (const q of p) { while (lo.length >= 2 && cross(lo[lo.length - 2], lo[lo.length - 1], q) <= 0) lo.pop(); lo.push(q); }
    for (const q of p.slice().reverse()) { while (up.length >= 2 && cross(up[up.length - 2], up[up.length - 1], q) <= 0) up.pop(); up.push(q); }
    return lo.slice(0, -1).concat(up.slice(0, -1));
  }
  // where a warning is: its outline(s), or a hull around its gauges padded
  // by about 12 km (so one or two gauges still make an area)
  function warningShape(w) {
    // the Bureau's flood warning catchments, which the broker adds (the
    // service doesn't answer browsers); else the area around its gauges
    if (Array.isArray(w.polygons) && w.polygons.length) return { rings: w.polygons, from: 'bureau', names: w.areaNames || [], gauges: warningGauges(w) };
    const gauges = warningGauges(w);
    if (!gauges.length) return { rings: [], from: 'none', gauges };
    const pts = [];
    for (const f of gauges) {
      const [lo, la] = f.geometry.coordinates, d = 0.11, dl = d / Math.cos((la * Math.PI) / 180);
      for (let k = 0; k < 12; k++) { const a = (k / 12) * 2 * Math.PI; pts.push([la + d * Math.sin(a), lo + dl * Math.cos(a)]); }
    }
    return { rings: [hull(pts)], from: 'gauges', gauges };
  }
  function warningPopupHtml(w, shape) {
    const g = shape ? shape.gauges : warningGauges(w);
    const names = g.slice(0, 8).map((f) => escapeHtml(f.properties.name)).join(', ');
    return `<div class="warn-pop"><strong>${escapeHtml(w.title)}</strong>
      <small>${escapeHtml(w.state || '')}${w.severity && w.severity !== 'Unknown' ? ` · ${escapeHtml(w.severity)}` : ''}${w.published ? ` · ${escapeHtml(fmtWarnTime(w.published))}` : ''}</small>
      ${w.description ? `<div class="warn-body">${escapeHtml(w.description)}</div>` : ''}
      ${shape && shape.names && shape.names.length ? `<small>Area: ${escapeHtml(shape.names.join('; '))} (the Bureau's flood warning catchments)</small>` : ''}
      ${g.length ? `<small>Gauges on ${shape && shape.from === 'bureau' ? 'this warning' : 'the warned rivers (the area drawn around them)'}: ${names}${g.length > 8 ? ` and ${g.length - 8} more` : ''}</small>` : '<small>No gauges on the map match this warning, so it has no area here.</small>'}
      <div class="warn-actions">${peakBtns(w)}<button type="button" class="btn small" data-warn-area="${escapeHtml(warnKey(w))}">Model this warning area</button>${w.link ? `<a class="btn small" href="${escapeHtml(w.link)}" target="_blank" rel="noopener">Bureau page ↗</a>` : ''}</div></div>`;
  }
  function drawWarningAreas() {
    const L = window.L, lyr = nat.warnLayer;
    if (!L || !lyr || !nat.data) return;
    lyr.clearLayers();
    nat.warnShapes = new Map();
    let drawn = 0, outlines = 0;
    for (const w of allWarnings()) {
      const shape = warningShape(w);
      nat.warnShapes.set(warnKey(w), shape);
      if (!shape.rings.length) continue;
      const c = warnColor(w);
      const poly = L.polygon(shape.rings, { color: c, weight: 2, fillColor: c, fillOpacity: shape.from === 'bureau' ? 0.18 : 0.1, dashArray: shape.from === 'bureau' ? null : '6 5' });
      poly.bindTooltip(w.title, { sticky: true });
      poly.bindPopup(() => warningPopupHtml(w, shape), { maxWidth: 360 });
      poly.on('popupopen', (e) => wirePopupButtons(e.popup.getElement()));
      poly.addTo(lyr);
      shape.layer = poly;
      drawn++; if (shape.from === 'bureau') outlines++;
    }
    status.warningAreas = { warnings: allWarnings().length, drawn, bureauOutlines: outlines };
  }
  // What a road closure actually is, as the agencies report it: a full
  // closure, one closed to through traffic, a part closure, a restriction
  // (4WD or weight limits) or mere lane and water impacts. Each paints
  // differently so nobody reads a lane closure as "closed to all traffic".
  const ROAD_LEVELS = {
    closed: { color: '#c62828', label: 'Closed to all traffic', dash: null },
    'closed to through traffic': { color: '#d84315', label: 'Closed to through traffic', dash: null },
    'part closed': { color: '#ef6c00', label: 'Part closed — some lanes', dash: '7 4' },
    'access restricted': { color: '#6d4c41', label: 'Access restricted', dash: '7 4' },
    'lanes affected': { color: '#f9a825', label: 'Lanes affected — pass with care', dash: '4 5' },
    caution: { color: '#90a4ae', label: 'Hazard reported — use caution', dash: '4 5' },
  };
  const ROAD_SOURCE = { QLD: 'QLDTraffic', NSW: 'Live Traffic NSW', WA: 'Main Roads WA', SA: 'Traffic SA', NT: 'Road Report NT', TAS: 'State Growth Tasmania', ACT: 'ACT Gov' };
  const roadSource = (st) => ROAD_SOURCE[st] || 'official traffic feed';
  const roadLevelOf = (x) => (x && x.level) || (x && x.closed ? 'closed' : 'caution');
  function roadClosurePopupHtml(x) {
    const st = ROAD_LEVELS[roadLevelOf(x)] || ROAD_LEVELS.caution;
    return `<div class="road-popup"><strong>${escapeHtml(x.road || 'Road')}</strong>${x.where ? ` <span class="hint">${escapeHtml(x.where)}</span>` : ''}<br>
      <div><span style="background:${st.color}" class="road-kind"></span><strong>${escapeHtml(st.label)}</strong>${x.type ? ` <span class="hint">· ${escapeHtml(x.type)}</span>` : ''}${x.hazard === 'fire' ? ' <span class="hint">· 🔥 fire</span>' : ''}</div>
      <span class="hint">${escapeHtml(x.desc || 'Reported event')}${x.updated ? ` · updated ${escapeHtml(when(x.updated))}` : ''}</span>
      ${x.due ? `<br><span class="hint">Because of: ${escapeHtml(x.due)}</span>` : ''}
      ${x.impact ? `<br><span class="hint">${escapeHtml(x.impact)}</span>` : ''}
      <br><span class="hint">Source: ${escapeHtml(roadSource(x.state))}${x.major ? ' · major road' : ''}</span>
      ${x.link ? `<br><a class="btn small" href="${escapeHtml(x.link)}" target="_blank" rel="noopener">Official page ↗</a>` : ''}</div>`;
  }
  function drawRoadClosures() {
    const L = window.L, lyr = nat.roadClosuresLayer;
    if (!L || !lyr) return;
    lyr.clearLayers();
    const items = (nat.readings && nat.readings.roads && nat.readings.roads.items) || [];
    let n = 0;
    for (const x of items) {
      if (!Number.isFinite(x.lat) || !Number.isFinite(x.lon)) continue;
      const st = ROAD_LEVELS[roadLevelOf(x)] || ROAD_LEVELS.caution;
      const w = (roadLevelOf(x) === 'closed' ? 4 : 2.5) + (x.major ? 1 : 0);
      let m;
      if (Array.isArray(x.line) && x.line.length >= 2) {
        m = L.polyline(x.line.map(([la, lo]) => [la, lo]), { color: st.color, weight: w, opacity: 0.9, dashArray: st.dash || undefined });
      } else {
        m = L.circleMarker([x.lat, x.lon], { radius: x.major ? 6 : 4, color: '#ffffff', weight: 1.5, fillColor: st.color, fillOpacity: 0.95 });
      }
      m.bindPopup(() => roadClosurePopupHtml(x), { maxWidth: 320 });
      m.addTo(lyr);
      n++;
    }
    status.roadClosures = {
      count: items.length, drawn: n,
      closed: items.filter((x) => x.closed).length,
      levels: items.reduce((m, x) => { const k = roadLevelOf(x); m[k] = (m[k] || 0) + 1; return m; }, {}),
      sources: nat.readings && nat.readings.roads ? nat.readings.roads.sources : null,
    };
  }
  const EMERGENCY_COLORS = { advice: '#f9a825', watch_and_act: '#ef6c00', emergency: '#c62828' };
  function emergencyPopupHtml(x) {
    const c = EMERGENCY_COLORS[x.level] || '#90a4ae';
    return `<div class="road-popup"><strong>${escapeHtml(x.title || 'Emergency warning')}</strong>${x.location ? ` <span class="hint">${escapeHtml(x.location)}</span>` : ''}<br>
      <div><span style="background:${c}" class="road-kind"></span><strong>${escapeHtml((x.level || '').replace(/_/g,' '))}</strong>${x.hazard ? ` <span class="hint">· ${escapeHtml(x.hazard)}</span>` : ''}${x.type ? ` <span class="hint">· ${escapeHtml(x.type)}</span>` : ''}</div>
      ${x.status ? `<span class="hint">Status: ${escapeHtml(x.status)}</span><br>` : ''}
      ${x.size && x.size !== '0 ha' ? `<span class="hint">Size: ${escapeHtml(x.size)}</span><br>` : ''}
      ${x.council ? `<span class="hint">Council: ${escapeHtml(x.council)}</span><br>` : ''}
      <span class="hint">Source: ${escapeHtml(x.source || 'state emergency service')}${x.updated ? ` · issued ${escapeHtml(x.updated)}` : ''}</span>
      ${x.link ? `<br><a class="btn small" href="${escapeHtml(x.link)}" target="_blank" rel="noopener">Official page ↗</a>` : ''}</div>`;
  }
  function drawEmergencyWarnings() {
    const L = window.L, lyr = nat.emergencyLayer;
    if (!L || !lyr) return;
    lyr.clearLayers();
    const items = (nat.readings && nat.readings.emergency && nat.readings.emergency.items) || [];
    let n = 0;
    for (const x of items) {
      const pt = Array.isArray(x.point) ? x.point : null;
      if (!pt || !Number.isFinite(pt[0]) || !Number.isFinite(pt[1])) continue;
      const c = EMERGENCY_COLORS[x.level] || '#90a4ae';
      const m = L.circleMarker([pt[0], pt[1]], { radius: x.level === 'emergency' ? 8 : 6, color: '#ffffff', weight: 1.5, fillColor: c, fillOpacity: 0.95 });
      m.bindPopup(() => emergencyPopupHtml(x), { maxWidth: 320 });
      m.addTo(lyr);
      n++;
    }
    status.emergencyWarnings = { count: items.length, drawn: n, levels: items.reduce((m, x) => { m[x.level] = (m[x.level] || 0) + 1; return m; }, {}) };
  }
  function drawRainObs() {
    const L = window.L, lyr = nat.rainObsLayer;
    if (!L || !lyr) return;
    lyr.clearLayers();
    const ro = (nat.readings && nat.readings.rainObs) || {};
    const gaugeFor = (st) => (nat.data && nat.data.gauges || []).find((g) => String(g.properties.station) === String(st) || String(g.properties.bom).replace(/^0+/, '') === String(st));
    let n = 0;
    for (const [st, x] of Object.entries(ro)) {
      if (!Number.isFinite(x.lat) || !Number.isFinite(x.lon)) continue;
      const m24 = Number.isFinite(x.mm24h) ? x.mm24h : 0;
      const heavy = m24 >= 100 || (Number.isFinite(x.mm6h) && x.mm6h >= 50);
      const color = heavy ? '#c62828' : (m24 >= 50 ? '#ef6c00' : '#1565c0');
      const m = L.circleMarker([x.lat, x.lon], { radius: heavy ? 7 : 5, color: '#ffffff', weight: 1.5, fillColor: color, fillOpacity: 0.9 });
      const bits = [];
      if (Number.isFinite(x.mm24h)) bits.push(`${x.mm24h.toFixed(1)} mm in 24 h`);
      if (Number.isFinite(x.mm6h)) bits.push(`${x.mm6h.toFixed(1)} mm in 6 h`);
      if (Number.isFinite(x.mm1h) && x.mm1h > 0) bits.push(`${x.mm1h.toFixed(1)} mm in 1 h`);
      const gf = gaugeFor(st);
      m.bindPopup(() => `<div class="rain-obs-popup"><strong>${escapeHtml(x.name || 'Rain gauge')}</strong>${gf ? ` <span class="hint">${escapeHtml(gf.properties.name || '')} area</span>` : ''}<br>
        <span class="hint">Observed rainfall (Bureau of Meteorology, last ${Number.isFinite(x.mm24h) ? '24' : '6'} hours): ${escapeHtml(bits.join(', '))}${x.station ? ` · station ${escapeHtml(String(x.station))}` : ''}</span></div>`);
      m.addTo(lyr);
      n++;
    }
    status.rainObs = { count: Object.keys(ro).length, drawn: n };
  }
  // redraw the live sources (warnings, road closures, rain obs) when new
  // readings arrive from the broker
  // (defined later; declared here so buildNationalLayers can call them)
  // Show a warning on the map: switch the layer on, fit its area, open it.
  function showWarning(w) {
    if (!w || !state.lmap) return;
    if (!nat.warnShapes || !nat.warnShapes.has(warnKey(w))) drawWarningAreas();
    const shape = nat.warnShapes && nat.warnShapes.get(warnKey(w));
    const m = state.lmap, lyr = nat.warnLayer;
    if (lyr && !m.hasLayer(lyr)) { lyr.userOn = true; lyr.addTo(m); syncLayerLists(); }
    if (shape && shape.layer) {
      m.fitBounds(shape.layer.getBounds(), { padding: [30, 30], maxZoom: 10 });
      shape.layer.openPopup(shape.layer.getBounds().getCenter());
    } else {
      const pop = window.L.popup({ maxWidth: 360 }).setLatLng(m.getCenter()).setContent(warningPopupHtml(w, shape)).openOn(m);
      wirePopupButtons(pop.getElement());
    }
    status.shownWarning = { id: w.id, from: shape ? shape.from : 'none' };
  }
  window.__floodShowWarning = (i) => showWarning(allWarnings()[i || 0]);
  // warning items anywhere (panel, gauge reports): show on the map
  document.addEventListener('click', (e) => {
    const b = e.target.closest && e.target.closest('[data-warn-key]');
    if (!b) return;
    e.preventDefault();
    const w = allWarnings().find((x) => warnKey(x) === b.dataset.warnKey);
    if (w) showWarning(w);
  });
  // The heights a warning predicts ("may peak near 2.60 metres at
  // Blackall"), each with its gauge: a button models that peak.
  function warningPeaks(w) {
    const gs = (nat.data && nat.data.gauges) || [];
    if (!w.__peaks || w.__peaksN !== gs.length) {
      w.__peaksN = gs.length;
      w.__peaks = warningTargets(w.description || '').map((t) => ({ t, f: gaugeForTarget(t, gs, w.state) })).filter((x) => x.f);
    }
    return w.__peaks;
  }
  const peakLabel = (t) => `Model ${t.kind === 'peak' ? 'the forecast peak' : `the ${t.cls} flood level`}: ${t.level.toFixed(2)} m at ${t.place}`;
  const peakBtns = (w) => warningPeaks(w).map((pk, i) => `<button type="button" class="btn small primary" data-warn-model="${escapeHtml(warnKey(w))}" data-peak="${i}">${escapeHtml(peakLabel(pk.t))}</button>`).join('');
  // a height on the gauge board, as a level in the model: exactly with the
  // gauge zero, else roughly from the gauge's rating (its usual height sits
  // at the model's normal water surface)
  function boardToModel(p, board) {
    const c = classFor(p);
    if (c && c.zero != null) return { level: Math.round((c.zero + board) * 100) / 100, exact: true };
    if (!state.a || state.gauge < 0) return null;
    const normal = state.a.dem[state.gauge] + 0.3;
    const rt = gaugeRating();
    if (rt && Number.isFinite(rt.hmed)) return { level: Math.round((normal + (board - rt.hmed)) * 100) / 100, exact: false, how: "from the gauge's rating" };
    // else from the lowest level the gauge recorded lately (taken as its
    // normal level): the record and the daily averages, over 5 days or more
    const r = nat.readings.level && nat.readings.level[p.station];
    const h = nat.history && nat.history[String(p.station || '')];
    const pts = [...((r && r.series) || []), ...((h && h.points) || []), ...(r && r.latest ? [r.latest] : [])]
      .map((x) => [new Date(x[0]).getTime(), x[1]]).filter((x) => Number.isFinite(x[0]) && Number.isFinite(x[1]));
    if (pts.length >= 3) {
      const days = (Math.max(...pts.map((x) => x[0])) - Math.min(...pts.map((x) => x[0]))) / 86400e3;
      const low = Math.min(...pts.map((x) => x[1]));
      if (days >= 5 && board > low) return { level: Math.round((normal + (board - low)) * 100) / 100, exact: false, how: `as ${(board - low).toFixed(2)} m above the lowest level recorded in the last ${Math.round(days)} days (${low.toFixed(2)} m), taken as its normal level` };
    }
    return null;
  }
  async function modelWarningPeak(w, i, opts) {
    const o = opts || {};
    const pk = warningPeaks(w)[i];
    if (!pk) return null;
    const f = pk.f, p = f.properties, [lo, la] = f.geometry.coordinates, t = pk.t;
    if (state.lmap) state.lmap.closePopup();
    const rep = openReport(f, { select: false });
    const ok = await modelHere(la, lo, { kind: 'river', name: p.name, reportId: rep ? rep.id : null, quiet: !!o.quiet });
    if (!ok || !state.a || state.gauge < 0) return null;
    try { await ensureHistory(); } catch (e) { /* no ratings: gauge zero only */ }
    if (rep) { try { await refreshHistory(p, document.createElement('div')); } catch (e) { /* daily averages only */ } }
    try { await ensureSeries('level', String(p.station || '')); } catch (e) { /* the hourly record only */ }
    const conv = boardToModel(p, t.level);
    status.warningModel = { warning: w.id, gauge: p.name, board: t.level, kind: t.kind, level: conv ? conv.level : null, exact: conv ? conv.exact : null, how: conv ? (conv.how || 'gauge zero') : null };
    if (!conv) {
      if (o.quiet) return null;
      say(`Model ready, but ${p.name} has no published gauge zero or rating, so the warning's ${t.level.toFixed(2)} m (on the gauge board) can't be placed in it. Set the level in Scenario.`);
      return status.warningModel;
    }
    ctl.floodType.value = 'river';
    ctl.gaugeLevel.min = Math.min(parseFloat(ctl.gaugeLevel.min), Math.floor(conv.level - 2));
    ctl.gaugeLevel.max = Math.max(parseFloat(ctl.gaugeLevel.max), Math.ceil(conv.level + 3));
    ctl.gaugeLevel.value = conv.level;
    ctl.extra.value = 0;
    state.base = null;
    syncOutputs();
    runScenario();
    renderLevelPoints();
    say(`Modelling ${t.kind === 'peak' ? 'the forecast peak' : `the ${t.cls} flood level`} from the Bureau's warning: ${t.level.toFixed(2)} m on the gauge board at ${t.place}${conv.exact ? ` (${conv.level.toFixed(2)} m AHD)` : `, placed roughly ${conv.how}, as no gauge zero is published for it`}. A screening estimate, not the Bureau's flood map.`);
    return status.warningModel;
  }
  window.__floodModelWarning = (i, j) => modelWarningPeak(allWarnings()[i || 0], j || 0);

  // One button adds everything the watch list and the current warnings
  // point at: a place at every listed gauge that has none, and a flood
  // model at every warning's forecast peak that names a gauge with a
  // publishable zero or a recent record. Models build one after another
  // (each downloads its elevation from the national service), at most
  // PEAK_MAX_PER_PRESS new things per press; the button stays and says
  // what's left. Modelled again only for gauges whose model was closed.
  const PEAK_MAX_PER_PRESS = 5;
  const modeledWarns = new Set();   // warn keys modelled this visit
  function pendingWatchWork() {
    const gs = (nat.data && nat.data.gauges) || [];
    const hasReport = (f) => reports.some((r) => r.id === `${f.properties.kind}:${f.properties.id}`);
    const places = ((nat.readings && nat.readings.watch) || [])
      .filter((w) => w.kind === 'river' || w.kind === 'flood')
      .map((w) => w.kind === 'flood' ? gs.find((g) => String(g.properties.bom) === String(w.station)) : gs.find((g) => g.properties.station === w.station))
      .filter((f) => f && !hasReport(f));
    const byGauge = new Map();   // two warnings naming one gauge keep the higher peak
    for (const w of allWarnings()) {
      if (modeledWarns.has(warnKey(w))) continue;
      for (const [i, pk] of warningPeaks(w).entries()) {
        const f = pk.f;
        const rep = reports.find((r) => r.id === `${f.properties.kind}:${f.properties.id}`);
        if (rep && areaForReport(rep)) continue;   // that gauge already has a model
        const old = byGauge.get(f.properties.id);
        if (!old || pk.t.level > old.pk.t.level) byGauge.set(f.properties.id, { w, i, wkey: warnKey(w), pk });
      }
    }
    return { places, models: [...byGauge.values()], total: places.length + byGauge.size };
  }
  async function modelAllWatchWork(btn) {
    const pending = pendingWatchWork();
    if (!pending.total) {
      say('Nothing to add: every forecast peak is already modelled and every gauge on the watch list already has a place.');
      return null;
    }
    // the models are the slow, scarce part: they get the cap first; the
    // place pins are instant and fill whatever is left over
    const batch = [
      ...pending.models.map((j) => ({ kind: 'model', j })),
      ...pending.places.map((f) => ({ kind: 'place', f })),
    ];
    const doing = batch.slice(0, PEAK_MAX_PER_PRESS);
    return withBusy(btn, 'Adding places and models…', async () => {
      let modelsDone = 0, placesDone = 0, failed = 0, stopped = null;
      const modelJobs = doing.filter((x) => x.kind === 'model').length;
      for (const job of doing) {
        if (job.kind === 'place') { openReport(job.f, { select: false }); placesDone++; continue; }
        setBusy(true, `Building flood model ${modelsDone + 1} of ${modelJobs || 1}…`);
        try {
          const got = await modelWarningPeak(job.j.w, job.j.i, { quiet: true });
          if (got) { modeledWarns.add(job.j.wkey); modelsDone++; } else {
            failed++;
            // the elevation service refusing more requests is not a bad
            // match: stop the batch and ask for a retry instead of racing
            // through the rest and failing them all the same way
            const err = `${(status.local || {}).error || ''}`;
            if (/429|too many|rate|throttl/i.test(err)) { stopped = 'rate'; break; }
          }
        } catch (e) { failed++; }
        setBusy(false);
      }
      setBusy(false);
      const left = batch.length - doing.length;
      status.watchWork = { models: modelsDone, places: placesDone, failed, left, stopped };
      const words = [];
      if (placesDone) words.push(placesDone === 1 ? '1 gauge report' : `${placesDone} gauge reports`);
      if (modelsDone) words.push(modelsDone === 1 ? '1 flood model' : `${modelsDone} flood models`);
      let msg = words.length ? `Added ${words.join(' and ')} from the watch list and the current warnings.` : 'Nothing could be added.';
      if (stopped === 'rate') msg += ' The national elevation service is refusing more requests right now (too many at once) — press the button again in a few minutes for the flood models.';
      else if (failed) msg += ` ${failed === 1 ? 'One forecast peak could' : `${failed} forecast peaks could`} not be placed (the gauge has no published zero or recent record) — open that warning and set the level in Scenario.`;
      if (left) msg += ` ${left} more on the list — press the button again for the next batch.`;
      renderWatch();
      say(msg);
      return status.watchWork;
    });
  }
  window.__floodPendingWatchWork = () => { const p = pendingWatchWork(); return { models: p.models.length, places: p.places.length, total: p.total }; };
  window.__floodModelPeaks = () => modelAllWatchWork(null);
  window.__floodHistory = (st) => (nat.history && nat.history[st]) || null;
  window.__floodWarningPeaks = () => allWarnings().map((w) => ({ id: w.id, peaks: warningPeaks(w).map((pk) => ({ place: pk.t.place, river: pk.t.river, level: pk.t.level, kind: pk.t.kind, gauge: pk.f.properties.name })), targets: warningTargets(w.description || '').length }));
  function onWarnModel(b) {
    const w = allWarnings().find((x) => warnKey(x) === b.dataset.warnKey || warnKey(x) === b.dataset.warnModel);
    if (w) withBusy(b, 'Building the flood model…', () => modelWarningPeak(w, +b.dataset.peak || 0));
  }
  async function onWarnArea(b) {
    const w = allWarnings().find((x) => warnKey(x) === b.dataset.warnArea);
    if (!w) return;
    const shape = nat.warnShapes && nat.warnShapes.get(warnKey(w));
    if (!shape || !shape.layer) { say('No area outline for this warning.'); return; }
    const bb = shape.layer.getBounds();
    const center = bb.getCenter();
    const halfKm = Math.min(15, Math.max(5, Math.ceil(Math.max(
      (bb.getNorth() - bb.getSouth()) * 111 / 2,
      (bb.getEast() - bb.getWest()) * 111 * Math.cos(center.lat * Math.PI / 180) / 2
    ))));
    await withBusy(b, 'Downloading elevation for this warning area…', async () => {
      const ok = await modelHere(center.lat, center.lng, { halfKm, name: w.title, lidar: false });
      if (ok) {
        const area = state.areaKey && areaReg.get(state.areaKey);
        if (area) area.polygon = shape.rings;
        say(`Model area created for "${w.title}" (≈${2 * halfKm} km). Set a level in Scenario to run it.`);
      }
    });
  }
  document.addEventListener('click', (e) => {
    const b = e.target.closest && e.target.closest('[data-warn-model],[data-warn-area]');
    if (b) { e.preventDefault(); if (b.hasAttribute('data-warn-area')) onWarnArea(b); else onWarnModel(b); }
  });
  // Leaflet keeps clicks inside a popup to itself: wire those directly
  const wirePopupButtons = (el) => el && el.querySelectorAll('[data-warn-model],[data-warn-area]').forEach((b) => b.addEventListener('click', (e) => { e.preventDefault(); e.stopPropagation(); if (b.hasAttribute('data-warn-area')) onWarnArea(b); else onWarnModel(b); }));
  const warnItemHtml = (x, meta) => `<div class="warn-item${x.severity ? ` sev-${escapeHtml(x.severity.toLowerCase())}` : ''}"><strong>${escapeHtml(x.title)}</strong>${x.description ? `<span class="warn-text">${escapeHtml(x.description)}</span>` : ''}<small>${meta}</small>
    <div class="warn-actions">${peakBtns(x)}<button type="button" class="btn small" data-warn-area="${escapeHtml(warnKey(x))}">Model this warning area</button><button type="button" class="btn small" data-warn-key="${escapeHtml(warnKey(x))}">View on map</button>${x.link ? `<a class="btn small" href="${escapeHtml(x.link)}" target="_blank" rel="noopener">Bureau page ↗</a>` : ''}</div></div>`;
  // What's worth a look now (the broker's watch list): Bureau warnings,
  // gauges in flood, fast or sustained rises, storm surges and heavy rain
  // forecast, each with the reason, most pressing first.
  const WATCH_ICON = { warning: '⚠', flood: '▲', river: '↑', sea: '≈' };
  function watchName(w) {
    if (w.kind === 'river') {
      const f = nat.data && nat.data.gauges.find((g) => g.properties.station === w.station);
      return f ? f.properties.name : `Gauge ${w.station}`;
    }
    if (w.kind === 'sea') return `${w.name || w.station} (storm tide gauge)`;
    return w.name || w.station;
  }
  // Where a watch item is, and which of your places (gauge reports, flood
  // models, study areas) it's near: within 50 km, or inside or beside an area.
  const NEAR_KM = 50;
  function watchPoint(w) {
    if (w.kind === 'sea') { const x = nat.readings.sea && nat.readings.sea[w.station]; return x ? [x.lat, x.lon] : null; }
    const gs = (nat.data && nat.data.gauges) || [];
    const f = w.kind === 'flood' ? gs.find((g) => String(g.properties.bom) === String(w.station))
      : w.kind === 'river' ? gs.find((g) => g.properties.station === w.station) : null;
    if (f) return [f.geometry.coordinates[1], f.geometry.coordinates[0]];
    const c = w.kind === 'flood' && nat.floodclass && nat.floodclass[w.station];
    return c && Number.isFinite(c.lat) && Number.isFinite(c.lon) ? [c.lat, c.lon] : null;
  }
  function myPlaces() {
    const out = [];
    for (const r of reports) if (Number.isFinite(r.lat)) out.push({ name: `${r.n}. ${r.name}`, lat: r.lat, lon: r.lon });
    for (const a of areaReg.values()) if (a.outline) { const b = a.outline.getBounds(); out.push({ name: `${a.n}. ${a.name}`, box: [b.getSouth(), b.getWest(), b.getNorth(), b.getEast()] }); }
    try { for (const st of studies) if (Array.isArray(st.bounds)) out.push({ name: `Study area ${st.letter}`, box: st.bounds }); } catch (e) { /* not set up yet */ }
    return out;
  }
  function nearMyPlace(w, places) {
    if (w.kind === 'warning') {
      // warnings have no location: near if they name a river one of your gauge reports is on
      for (const r of reports) {
        const f = nat.data && nat.data.gauges.find((g) => `${g.properties.kind}:${g.properties.id}` === r.id);
        if (f && warningsFor(f.properties).some((x) => x.id === w.station || x.title === w.name)) return `${r.n}. ${r.name}`;
      }
      return null;
    }
    const pt = watchPoint(w);
    if (!pt) return null;
    for (const p of places) {
      if (p.box) {
        const [s, wst, n, e] = p.box, pad = 0.3;
        if (pt[0] >= s - pad && pt[0] <= n + pad && pt[1] >= wst - pad && pt[1] <= e + pad) return p.name;
      } else if (kmBetween(pt, [p.lat, p.lon]) <= NEAR_KM) return p.name;
    }
    return null;
  }
  const WATCH_SEEN_KEY = 'floodExplorer.watchSeen.v1', WATCH_NOTIFY_KEY = 'floodExplorer.watchNotify';
  const watchKey = (w) => `${w.kind}:${w.station}:${(w.why || [])[0] || ''}`;
  function watchNotify(list) {
    let on = false;
    try { on = localStorage.getItem(WATCH_NOTIFY_KEY) === '1'; } catch (e) { /* no storage */ }
    if (!on || typeof Notification === 'undefined' || Notification.permission !== 'granted') return;
    let seen = [];
    try { seen = JSON.parse(localStorage.getItem(WATCH_SEEN_KEY) || '[]'); } catch (e) { seen = []; }
    const fresh = list.filter((w) => w.near && !seen.includes(watchKey(w)));
    for (const w of fresh.slice(0, 3)) {
      try { new Notification(`Flood Explorer: ${watchName(w)}`, { body: `${(w.why || []).join('; ')}. Near ${w.near}.`, tag: watchKey(w) }); } catch (e) { /* not allowed here */ }
    }
    try { localStorage.setItem(WATCH_SEEN_KEY, JSON.stringify([...new Set([...seen, ...list.filter((w) => w.near).map(watchKey)])].slice(-300))); } catch (e) { /* this visit only */ }
  }
  function renderWatch() {
    const box = $('watchBox');
    if (!box) return;
    const places = myPlaces();
    const list = ((nat.readings && nat.readings.watch) || []).map((w) => Object.assign({}, w, { near: places.length ? nearMyPlace(w, places) : null }));
    // near your places first, otherwise as the broker ranked them
    list.sort((a, b) => (b.near ? 1 : 0) - (a.near ? 1 : 0));
    status.watch = { count: list.length, kinds: list.reduce((m, w) => (m[w.kind] = (m[w.kind] || 0) + 1, m), {}) };
    if (nat.readingsSource !== 'runtime') { box.hidden = true; return; }
    box.hidden = false;
    const shown = list.slice(0, 40);
    box.innerHTML = `<h3 class="places-sub">Watch list${list.length ? ` (${list.length})` : ''}</h3>
      ${list.length ? `<ul class="watch-list">${shown.map((w, i) => `<li><button type="button" class="watch-item watch-${escapeHtml(w.kind)}" data-watch="${i}">
        <span class="watch-icon" aria-hidden="true">${WATCH_ICON[w.kind] || '•'}</span>
        <span class="watch-main"><strong>${escapeHtml(watchName(w))}</strong><small>${escapeHtml((w.why || []).join('; '))}</small>${w.near ? `<small class="watch-near">Near ${escapeHtml(w.near)}</small>` : ''}</span></button>${w.kind === 'warning' && w.link ? `<div class="warn-actions watch-actions"><button type="button" class="btn small" data-watch="${i}">View on map</button><a class="btn small" href="${escapeHtml(w.link)}" target="_blank" rel="noopener">Bureau page ↗</a></div>` : ''}</li>`).join('')}</ul>`
        : '<p class="hint">Nothing on the watch list: no current warnings, gauges in flood, fast rises, storm surges or heavy rain forecast.</p>'}
      ${( () => {
        let pend;
        try { pend = pendingWatchWork(); } catch (e) { pend = { models: [], places: [] }; }
        const bits = [];
        if (pend.models.length) bits.push(`model ${pend.models.length === 1 ? 'the forecast peak' : `the ${pend.models.length} forecast peaks`}`);
        if (pend.places.length) bits.push(`add ${pend.places.length === 1 ? 'the place' : `${pend.places.length} places`} in a flood`);
        return bits.length ? `<p class="hint"><button type="button" class="btn primary" id="watchPeaks">${escapeHtml(`${bits[0]}${bits[1] ? ` and ${bits[1]}` : ''}`)}</button><br>One press builds a flood model for every warning peak at a gauge the model can place, and pins a place at every gauge the watch list flags. At most 5 per press — the elevation comes live from the national service.</p>` : '';
      })()}
      ${typeof Notification !== 'undefined' ? `<p class="hint"><button type="button" class="btn" id="watchNotify">${(() => { try { return localStorage.getItem(WATCH_NOTIFY_KEY) === '1' && Notification.permission === 'granted'; } catch (e) { return false; } })() ? 'Stop notifications' : 'Notify me about new items near my places'}</button><br>While this map is open in a tab, it checks for new items every 15 minutes.</p>` : ''}
      <p class="hint">Updated ${escapeHtml(when(nat.readingsFetched))} ${(() => { const w = refreshWaitMs(); return w > 0 ? `<button type="button" class="link-btn" id="watchRefresh" disabled title="Once every 5 minutes">Refresh again in ${Math.ceil(w / 60e3)} min</button>` : '<button type="button" class="link-btn" id="watchRefresh">Refresh now</button>'; })()} (the broker fetches new readings every 15 minutes; the map checks for them every 15 minutes too). ${nat.readings.watchRule ? `On the list: ${escapeHtml(nat.readings.watchRule)}.` : ''} Near your places: within ${NEAR_KM} km of a gauge report, or in or beside a flood model or study area. A pointer to look closer, not a warning; follow official warnings.</p>`;
    const pb = $('watchPeaks');
    if (pb) pb.addEventListener('click', () => modelAllWatchWork(pb));
    const nb = $('watchNotify');
    if (nb) nb.addEventListener('click', async () => {
      let on = false;
      try { on = localStorage.getItem(WATCH_NOTIFY_KEY) === '1'; } catch (e) { /* no storage */ }
      if (on) { try { localStorage.removeItem(WATCH_NOTIFY_KEY); } catch (e) { /* no storage */ } renderWatch(); return; }
      const perm = await Notification.requestPermission();
      if (perm === 'granted') {
        try {
          localStorage.setItem(WATCH_NOTIFY_KEY, '1');
          // what's on the list now counts as seen: notify about what's new from here
          localStorage.setItem(WATCH_SEEN_KEY, JSON.stringify(list.filter((w) => w.near).map(watchKey)));
        } catch (e) { /* this visit only */ }
        say('You\'ll be notified about new items near your places while the map is open.');
      } else say('Notifications are blocked for this site in your browser settings.');
      renderWatch();
    });
    const rb = $('watchRefresh');
    if (rb) rb.addEventListener('click', (e) => withBusy(e.currentTarget, 'Checking…', async () => {
      if (refreshWaitMs() > 0) return;
      try { localStorage.setItem(REFRESH_KEY, String(Date.now())); } catch (err) { lastManualRefresh = Date.now(); }
      const got = await refreshLiveReadings(true);
      say(got === 'new' ? `New readings loaded (fetched ${ago(nat.readingsFetched)}).`
        : got === 'same' ? `Already up to date: these are the newest readings (fetched ${ago(nat.readingsFetched)}). The next fetch is due within 15 minutes of that.`
          : 'The live data broker didn\'t answer; try again in a few minutes.');
      renderWatch();
    }));
    // the button comes back when the 5 minutes are up
    clearTimeout(refreshT);
    const wait = refreshWaitMs();
    if (wait > 0) refreshT = setTimeout(renderWatch, Math.min(wait, 60e3) + 200);
    watchNotify(list);
    box.querySelectorAll('[data-watch]').forEach((b) => b.addEventListener('click', () => openWatchItem(shown[+b.dataset.watch])));
    const n = list.length;
    const badge = $('forecastBadge');
    badge.hidden = !n;
    badge.textContent = n > 99 ? '99+' : String(n);
  }
  async function openWatchItem(w) {
    if (!w) return;
    if (w.kind === 'warning') {
      const x = allWarnings().find((y) => y.id === w.station || y.title === w.name);
      if (x) showWarning(x); else if (w.link) window.open(w.link, '_blank', 'noopener');
      return;
    }
    if (w.kind === 'sea') {
      const x = nat.readings.sea && nat.readings.sea[w.station];
      if (x && state.lmap) {
        const lyr = nat.layers['Storm tide gauges, live (Qld)'];
        if (lyr && !state.lmap.hasLayer(lyr)) { lyr.addTo(state.lmap); syncLayerLists(); }
        state.lmap.setView([x.lat, x.lon], 12);
        window.L.popup().setLatLng([x.lat, x.lon]).setContent(seaPopupHtml(x)).openOn(state.lmap);
      }
      return;
    }
    if (typeof ensureRiverGauges === 'function') { try { await ensureRiverGauges(); } catch (e) { /* the core gauges still work */ } }
    const gs = (nat.data && nat.data.gauges) || [];
    const f = w.kind === 'flood' ? gs.find((g) => String(g.properties.bom) === String(w.station)) : gs.find((g) => g.properties.station === w.station);
    if (!f) { say(`That gauge (${w.station}) isn't on the map.`); return; }
    const [lo, la] = f.geometry.coordinates;
    if (state.lmap) state.lmap.setView([la, lo], Math.max(state.lmap.getZoom(), 11));
    openReport(f);
  }
  window.__floodWatch = () => ({ list: (nat.readings && nat.readings.watch) || [], shown: !$('watchBox').hidden, items: document.querySelectorAll('#watchBox [data-watch]').length,
    near: [...document.querySelectorAll('#watchBox .watch-near')].map((x) => x.textContent) });

  // While the map is open, fetch the broker's readings again every 15
  // minutes (cheap: an unchanged file is a 304) and update the watch list
  // and warnings.
  // If the first try timed out (a broker waking up can be slow), the map
  // starts on the site build's readings and switches over when this works.
  // "Refresh now" at most once every 5 minutes (remembered across reloads)
  const REFRESH_EVERY_MS = 5 * 60e3, REFRESH_KEY = 'floodExplorer.lastRefresh';
  let lastManualRefresh = 0, refreshT = 0;
  function refreshWaitMs() {
    let t = lastManualRefresh;
    try { t = Math.max(t, parseInt(localStorage.getItem(REFRESH_KEY) || '0', 10) || 0); } catch (e) { /* this visit only */ }
    return Math.max(0, t + REFRESH_EVERY_MS - Date.now());
  }
  // manual: the "Refresh now" button (works in a background tab too, and
  // asks past the browser's cache: an unchanged file is a cheap 304)
  async function refreshLiveReadings(manual) {
    if (DATA_SOURCE !== 'runtime' || !nat.readings || (document.hidden && !manual)) return 'off';
    const fallback = nat.readingsSource !== 'runtime';
    try {
      const fresh = await requestLiveReadings(fallback || manual ? 30000 : 15000, manual ? 'no-cache' : 'default');
      nat.readingsSaved = false;
      if (!fallback && fresh.fetched === nat.readingsFetched) { renderFeedHealth(); return 'same'; }
      saveReadings(new Response(JSON.stringify(fresh), { headers: { 'Content-Type': 'application/json' } }));
      nat.readings = fresh;
      nat.readingsFetched = fresh.fetched;
      if (fallback) {
        nat.readingsSource = 'runtime';
        if (status.national) Object.assign(status.national, { readingsSource: 'runtime', readingsFetched: fresh.fetched, levelReadings: Object.keys(fresh.level || {}).length });
        say('Live readings are in now (they were slow to arrive).');
        renderVersions();
      }
      if (fresh.warnings && fresh.warnings.ok) nat.warnings = fresh.warnings;
      if (fresh.floodclass) nat.floodclass = Object.assign({}, nat.floodclass || {}, fresh.floodclass);
      const redraws = [['Flood warnings', renderWarnings], ['Watch list', renderWatch], ['Place information', renderInfo],
        ['Road events', drawRoadClosures], ['Emergency warnings', drawEmergencyWarnings], ['Observed rainfall', drawRainObs]];
      if (state.lmap && nat.renderer) redraws.unshift(['River and tide markers', () => {
        updateLiveGaugeLayers(window.L, nat.renderer);
        scaleDots(); orderDots(); scheduleClusters();
      }]);
      for (const [name, redraw] of redraws) runLiveUpdate(name, redraw);
      renderFeedHealth();
      status.liveRefresh = { at: new Date().toISOString(), fetched: fresh.fetched, manual: !!manual };
      return 'new';
    } catch (e) { return 'error'; /* next time */ }
  }
  setInterval(refreshLiveReadings, 15 * 60 * 1000);
  // Retry missing startup readings. Once connected, the feed client also
  // retries subsequent failures with bounded backoff, without overlapping requests.
  const liveRetry = setInterval(() => {
    if (!nat.readings) return;
    if (DATA_SOURCE !== 'runtime' || nat.readingsSource === 'runtime') { clearInterval(liveRetry); return; }
    if (!nat.feedHealth?.nextRetry) refreshLiveReadings();
  }, 45 * 1000);
  document.addEventListener('visibilitychange', () => { if (!document.hidden) refreshLiveReadings(); });
  window.__floodRefreshLive = (manual) => refreshLiveReadings(manual);
  window.__floodOpenWatch = (i) => openWatchItem(((nat.readings && nat.readings.watch) || [])[i || 0]);

  function renderWarnings() {
    const box = $('warningsBox');
    if (!box) return;
    const w = nat.warnings;
    status.warnings = w ? { ok: w.ok, count: (w.warnings || []).length } : { ok: false };
    if (!w) { box.innerHTML = '<p class="hint">Current flood warnings could not be loaded.</p>'; return; }
    const list = w.warnings || [];
    box.innerHTML = `<h3 class="places-sub">Current flood warnings (BoM)</h3>${list.length
      ? list.map((x) => warnItemHtml(x, `${escapeHtml(x.state)}${x.severity && x.severity !== 'Unknown' ? ` · ${escapeHtml(x.severity)}` : ''}${x.published ? ` · ${escapeHtml(fmtWarnTime(x.published))}` : ''}`)).join('')
      : `<p class="hint">${w.ok ? 'No flood warnings or watches are current.' : 'The warning feeds could not be reached at the last update.'}</p>`}
      <p class="hint">Checked ${escapeHtml(ago(w.fetched))}. Always follow official warnings at <a href="https://www.bom.gov.au/australia/warnings/" target="_blank" rel="noopener">bom.gov.au</a>.</p>`;
    nat.warningCount = list.length;
    if (list.length) $('forecastBadge').hidden = false;
    drawWarningAreas();
  }

  // Gauges inside the active model: their flood classes (where the gauge
  // zero is known) or current readings become level points.
  function gaugesInModel() {
    const g = state.geo;
    if (!g || !nat.data || !state.a) return [];
    return nat.data.gauges.filter((f) => {
      const [lo, la] = f.geometry.coordinates;
      return la > g.south && la < g.north && lo > g.west && lo < g.east && f.properties.kind !== 'tide';
    });
  }
  function streamCellAt(lat, lon) {
    const c = latLngCell({ lat, lng: lon });
    if (!c) return -1;
    const s = F.snapToStream(state.a, c.x, c.y, 10);
    return s >= 0 ? s : c.i;
  }
  function applyGaugeLevels(which) {
    const pts = [];
    for (const f of gaugesInModel()) {
      const p = f.properties, c = classFor(p);
      if (!c || c.zero == null) continue;
      let v;
      if (which === 'now') { const r = nat.readings.level && nat.readings.level[p.station]; v = r ? r.latest[1] : null; } else v = c[which];
      if (v == null) continue;
      const cell = streamCellAt(f.geometry.coordinates[1], f.geometry.coordinates[0]);
      if (cell >= 0) pts.push({ cell, level: Math.round((c.zero + v) * 100) / 100, label: p.name, auto: true });
    }
    if (!pts.length) return 0;
    // the one nearest the model's gauge sets the gauge level; the rest are points
    const gx = state.gauge % state.a.W, gy = Math.floor(state.gauge / state.a.W);
    pts.sort((p1, p2) => Math.hypot(p1.cell % state.a.W - gx, Math.floor(p1.cell / state.a.W) - gy) - Math.hypot(p2.cell % state.a.W - gx, Math.floor(p2.cell / state.a.W) - gy));
    const first = pts[0], d = Math.hypot(first.cell % state.a.W - gx, Math.floor(first.cell / state.a.W) - gy);
    const rest = d <= 12 ? pts.slice(1) : pts;
    if (d <= 12) {
      ctl.gaugeLevel.min = Math.min(parseFloat(ctl.gaugeLevel.min), Math.floor(first.level - 2));
      ctl.gaugeLevel.max = Math.max(parseFloat(ctl.gaugeLevel.max), Math.ceil(first.level + 3));
      ctl.gaugeLevel.value = first.level;
      ctl.extra.value = 0;
    }
    state.controls = (state.controls || []).filter((x) => !x.auto).concat(rest);
    state.base = null;
    syncOutputs();
    runScenario();
    renderLevelPoints();
    say(`Set ${pts.length} gauge level${pts.length === 1 ? '' : 's'} from ${which === 'now' ? 'current readings' : `${which} flood class`}.`);
    return pts.length;
  }
  window.__floodApplyGaugeLevels = applyGaugeLevels;

  function renderLevelPoints() {
    const set = $('levelPointsSet');
    if (!set) return;
    const local = state.a && state.geo;
    status.levelPoints = (state.controls || []).length;
    set.hidden = !local || scenarioEmpty || ctl.floodType.value === 'flash';
    $('checkSet').hidden = !local || scenarioEmpty;
    $('impactSet').hidden = !local || scenarioEmpty;
    $('defenceSet').hidden = !local || scenarioEmpty || ctl.floodType.value === 'flash';
    $('timeSet').hidden = !!state.inertial || !local || scenarioEmpty || ctl.floodType.value !== 'river' || state.gauge < 0;
    if (!$('timeSet').hidden) { renderShapeChoices(); renderTideRow(); }
    $('recordedSet').hidden = !local || scenarioEmpty;
    clearTimeout(impactT);
    impactT = setTimeout(() => { maybeRenderImpact(); renderRecorded(); renderDefences(); if (!state.timeView) renderTimeline(); }, 250);
    $('downloadSet').hidden = !local || scenarioEmpty;
    if (set.hidden) return;
    const sc = $('satCheck');
    if (sc.dataset.key && sc.dataset.key !== String(state.areaKey)) { sc.innerHTML = ''; sc.dataset.key = ''; }
    const inside = gaugesInModel(), withZero = inside.filter((f) => { const c = classFor(f.properties); return c && c.zero != null; });
    const withClass = inside.filter((f) => classFor(f.properties));
    let ch = '';
    if (withZero.length) {
      const hasNow = withZero.some((f) => nat.readings.level && nat.readings.level[f.properties.station]);
      ch = `<p class="hint">${withZero.length} gauge${withZero.length === 1 ? '' : 's'} here ${withZero.length === 1 ? 'has' : 'have'} Bureau flood class levels. Set the river to:</p>
        <div class="class-btns"><button type="button" class="btn small" data-cls="minor">Minor</button><button type="button" class="btn small" data-cls="moderate">Moderate</button><button type="button" class="btn small" data-cls="major">Major</button>${hasNow ? '<button type="button" class="btn small" data-cls="now">Now</button>' : ''}</div>`;
    } else if (withClass.length) {
      ch = `<p class="hint">${withClass.length} gauge${withClass.length === 1 ? '' : 's'} here ${withClass.length === 1 ? 'has' : 'have'} flood classes, but on the gauge board without a published gauge zero, so they can't be placed on the map. See the gauge reports.</p>`;
    }
    $('classLevels').innerHTML = ch;
    $('classLevels').querySelectorAll('[data-cls]').forEach((b) => b.addEventListener('click', () => applyGaugeLevels(b.dataset.cls)));
    const pts = state.controls || [];
    $('levelPoints').innerHTML = pts.map((p, i) => `<div class="level-point"><span>${escapeHtml(p.label || `Point ${i + 1}`)}</span>
      <input type="number" step="0.05" value="${p.level.toFixed(2)}" data-lp="${i}" aria-label="Water level at ${escapeHtml(p.label || `point ${i + 1}`)} in metres">
      <button type="button" class="icon-btn" data-lp-drop="${i}" aria-label="Remove this level point" title="Remove">×</button></div>`).join('');
    $('levelPoints').querySelectorAll('[data-lp]').forEach((inp) => inp.addEventListener('change', () => {
      const v = parseFloat(inp.value);
      if (Number.isFinite(v)) { state.controls[+inp.dataset.lp].level = v; state.base = null; runScenario(); }
    }));
    $('levelPoints').querySelectorAll('[data-lp-drop]').forEach((b) => b.addEventListener('click', () => {
      state.controls.splice(+b.dataset.lpDrop, 1); state.base = null; runScenario(); renderLevelPoints();
    }));
    const nb = overlappingAreas().length;
    let jb = $('joinModels');
    if (!jb) {
      jb = document.createElement('button');
      jb.type = 'button'; jb.className = 'btn small'; jb.id = 'joinModels';
      busyClick(jb, 'Joining…', () => joinNeighbours());
      $('addLevelPoint').after(jb);
    }
    jb.hidden = !nb;
    jb.textContent = `Match ${nb} overlapping model${nb === 1 ? '' : 's'} to this level`;
    $('addLevelPoint').setAttribute('aria-pressed', String(!!state.addingPoint));
    $('addLevelPoint').textContent = state.addingPoint ? 'Tap the river on the map…' : 'Add a level point';
  }
  $('addLevelPoint').addEventListener('click', () => { state.addingPoint = !state.addingPoint; renderLevelPoints(); });

  // Joining models: where models overlap, the active one's water level on
  // the main channel inside the overlap becomes a level point in each
  // neighbour, and so on outward, so the surface is continuous across seams.
  const geoOverlap = (g1, g2) => g1 && g2 && g1.west < g2.east && g1.east > g2.west && g1.south < g2.north && g1.north > g2.south;
  function overlappingAreas() {
    const me = state.areaKey && areaReg.get(state.areaKey);
    if (!me || !state.geo) return [];
    return Array.from(areaReg.values()).filter((b) => b !== me && geoOverlap(state.geo, b.geo));
  }
  function seamPoint(geoB) {
    // the main channel of the active model inside the overlap with geoB
    const a = state.a, g = state.geo, run = state.run;
    if (!a || !run) return null;
    const x0 = Math.max(0, Math.floor(((Math.max(g.west, geoB.west) - g.west) / (g.east - g.west)) * a.W));
    const x1 = Math.min(a.W - 1, Math.ceil(((Math.min(g.east, geoB.east) - g.west) / (g.east - g.west)) * a.W));
    const y0 = Math.max(0, Math.floor(((g.north - Math.min(g.north, geoB.north)) / (g.north - g.south)) * a.H));
    const y1 = Math.min(a.H - 1, Math.ceil(((g.north - Math.max(g.south, geoB.south)) / (g.north - g.south)) * a.H));
    let best = -1, bestAcc = -1;
    for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) {
      const i = y * a.W + x;
      if (a.stream[i] && a.acc[i] > bestAcc && Number.isFinite(run.level[i])) { bestAcc = a.acc[i]; best = i; }
    }
    if (best < 0) return null;
    const [lat, lon] = cellLatLng(best);
    return { lat, lon, level: run.level[best] };
  }
  let joining = false;
  async function joinNeighbours() {
    const start = state.areaKey && areaReg.get(state.areaKey);
    if (!start || !state.run || joining) return 0;
    joining = true;
    let count = 0;
    try {
      const done = new Set([start.key]);
      const queue = [start.key];
      while (queue.length) {
        const k = queue.shift();
        if (state.areaKey !== k) { activateArea(k); await state.ready; }
        const from = areaReg.get(k);
        const plans = overlappingAreas().filter((b) => !done.has(b.key)).map((b) => ({ b, pt: seamPoint(b.geo) })).filter((x) => x.pt);
        for (const { b, pt } of plans) {
          activateArea(b.key);
          await state.ready;
          if (!state.a) continue;
          const cell = streamCellAt(pt.lat, pt.lon);
          if (cell < 0) continue;
          state.controls = (state.controls || []).filter((c) => c.join !== from.key)
            .concat([{ cell, level: Math.round(pt.level * 100) / 100, label: `Joined to ${from.n}. ${from.name}`, join: from.key }]);
          state.base = null;
          runScenario();
          done.add(b.key);
          queue.push(b.key);
          count++;
        }
      }
    } finally {
      if (state.areaKey !== start.key) { activateArea(start.key); await state.ready; }
      joining = false;
    }
    say(count ? `Matched ${count} overlapping model${count === 1 ? '' : 's'} to this water level.` : 'No overlapping model shares a river channel with this one.');
    status.joined = count;
    return count;
  }
  window.__floodJoinNeighbours = joinNeighbours;
  function addLevelPointAt(latlng) {
    const s0 = streamCellAt(latlng.lat, latlng.lng);
    state.addingPoint = false;
    if (s0 < 0) { say('That spot is outside this model.'); renderLevelPoints(); return; }
    const lv = state.run && Number.isFinite(state.run.level[s0]) ? state.run.level[s0] : state.a.dem[s0] + 1;
    state.controls = (state.controls || []).concat([{ cell: s0, level: Math.round(lv * 20) / 20, label: `Point ${(state.controls || []).length + 1}` }]);
    state.base = null;
    runScenario();
    renderLevelPoints();
    say('Level point added. Type the water level you want there in Scenario.');
  }
  window.__floodAddLevelPoint = (lat, lon) => addLevelPointAt({ lat, lng: lon });

  // Compare the model's flood with Digital Earth Australia's record of how
  // often satellites have seen water at each spot (Landsat, 1987 on).
  const DEA_WCS = 'https://ows.dea.ga.gov.au/';
  async function compareWithSatellite() {
    const a = state.a, g = state.geo, run = state.run, key = state.areaKey;
    const box = $('satCheck');
    if (!a || !g || !run) return null;
    box.dataset.key = String(key);
    box.innerHTML = '<p class="hint">Fetching the satellite water record for this area…</p>';
    const W = Math.min(a.W, 1000), H = Math.round(W * a.H / a.W);
    const url = `${DEA_WCS}?service=WCS&version=1.0.0&request=GetCoverage&coverage=ga_ls_wo_fq_myear_3&measurements=frequency`
      + `&crs=EPSG:4326&bbox=${g.west},${g.south},${g.east},${g.north}&width=${W}&height=${H}&format=GeoTIFF`;
    let freq, fw, fh;
    try {
      const r = await fetch(url);
      if (!r.ok) throw new Error(`the satellite service returned ${r.status}`);
      const buf = await r.arrayBuffer();
      try { const t = F.parseSimpleTiff(buf); freq = t.data; fw = t.W; fh = t.H; } catch (err) {
        await loadGeoTiffLib();
        const img = await (await window.GeoTIFF.fromArrayBuffer(buf)).getImage();
        fw = img.getWidth(); fh = img.getHeight();
        freq = (await img.readRasters({ samples: [0] }))[0];
      }
    } catch (err) {
      box.innerHTML = `<p class="hint">Couldn't fetch the satellite record: ${escapeHtml(err.message || String(err))}.</p>`;
      status.satCheck = { ok: false, error: String(err.message || err) };
      return status.satCheck;
    }
    if (state.areaKey !== key) return null;
    // compare on the satellite grid: "seen wet" = water in at least 1% of
    // clear observations, ignoring the sea and permanent water (over 80%)
    let sat = 0, mod = 0, hit = 0;
    for (let y = 0; y < fh; y++) {
      const ym = Math.min(a.H - 1, Math.floor(((y + 0.5) / fh) * a.H));
      for (let x = 0; x < fw; x++) {
        const f = freq[y * fw + x];
        const xm = Math.min(a.W - 1, Math.floor(((x + 0.5) / fw) * a.W));
        const c = ym * a.W + xm;
        if (a.ocean && a.ocean[c]) continue;
        if (Number.isFinite(f) && f > 0.8) { continue; }
        const s0 = Number.isFinite(f) && f >= 0.01 && f <= 1, m0 = run.wet[c] === 1;
        if (s0) sat++;
        if (m0) mod++;
        if (s0 && m0) hit++;
      }
    }
    const px = (g.east - g.west) * 111.32 * Math.cos(((g.north + g.south) / 2) * Math.PI / 180) * (g.north - g.south) * 110.574 / (fw * fh);
    const km = (n) => `${(n * px).toFixed(1)} km²`;
    const pct = (x, y) => (y ? `${Math.round((100 * x) / y)}%` : '–');
    const csi = sat + mod - hit ? hit / (sat + mod - hit) : 0;
    status.satCheck = { ok: true, sat, mod, hit, csi: Math.round(csi * 100) / 100 };
    box.innerHTML = `<div class="stats-mini">
      <p><strong>${pct(hit, sat)}</strong> of the land satellites have seen under water (${km(sat)}) is flooded in this scenario.</p>
      <p><strong>${pct(hit, mod)}</strong> of this scenario's flood (${km(mod)}) is land satellites have seen under water.</p>
      <p>Agreement score <strong>${Math.round(csi * 100)}</strong>/100 (overlap ÷ either).</p></div>
      <p class="hint">Satellite record: Digital Earth Australia water observations, Landsat 1987 to now, counting land seen wet in at least 1% of clear passes and leaving out permanent water and the sea. Clouds hide many floods' peaks, and the record mixes many events, so a perfect match isn't expected: low first figure means the scenario is smaller than past floods; low second figure means it floods land that hasn't been seen wet.</p>`;
    return status.satCheck;
  }
  busyClick($('satCheckBtn'), 'Fetching satellite water records…', () => compareWithSatellite());
  window.__floodSatCheck = compareWithSatellite;

  /* ---------- sessions: share links and places remembered between visits */
  // Everything numbered on the map (reports, pins, flood models with their
  // scenario settings and level points), the studied areas and the view are
  // written to a compact JSON, base64url-encoded into the link's #s= part
  // and kept in this browser so the next visit picks up where you left off.
  const SESSION_KEY = 'floodExplorer.session.v1';
  let restoring = false, sessionT = 0;
  const r5 = (x) => Math.round(x * 1e5) / 1e5;
  function cellToLatLon(i, W, H, g) {
    const x = (i % W) + 0.5, y = Math.floor(i / W) + 0.5;
    return [r5(g.north - (y / H) * (g.north - g.south)), r5(g.west + (x / W) * (g.east - g.west))];
  }
  function modelPoints(grid, geo, gauge, controls) {
    if (!grid || !geo) return { gp: null, cp: [] };
    const ll = (c) => cellToLatLon(c, grid.W, grid.H, geo);
    return {
      gp: gauge >= 0 ? ll(gauge) : null,
      cp: (controls || []).map((c) => [...ll(c.cell), c.level, c.label || '']),
    };
  }
  function restoreModelPoints(points) {
    if (points.gp) {
      const gauge = streamCellAt(points.gp[0], points.gp[1]);
      if (gauge >= 0) state.gauge = gauge;
    }
    state.controls = (points.cp || []).map(([la, lo, level, label]) => ({ cell: streamCellAt(la, lo), level, label })).filter((c) => c.cell >= 0);
  }
  function sessionState() {
    const m = state.lmap;
    const out = { v: 1 };
    if (m && !$('lmap').hidden) { const c = m.getCenter(); out.view = [r5(c.lat), r5(c.lng), Math.round(m.getZoom() * 100) / 100]; }
    out.reports = reports.map((r) => ({ n: r.n, id: r.id }));
    out.pins = pins.map((p) => ({ n: p.n, lat: r5(p.lat), lon: r5(p.lon), name: p.name }));
    out.checks = propertyChecks.map((c) => ({ id: c.id, lat: r5(c.lat), lon: r5(c.lon), name: c.name, created: c.created, headline: c.headline, snap: c.snapshot }));
    out.areas = [];
    for (const a of areaReg.values()) {
      const meta = a.areaMeta || {};
      const detailed = !meta.local && a.areaId && meta.bounds_lonlat && !meta.upload && !meta.synthetic;
      if (!detailed && (!meta.local || !meta.gaugeLatLon)) continue;
      const live = a.key === state.areaKey;
      const ctlv = live ? Object.fromEntries(CTL_KEYS.map((k) => [k, ctl[k].value])) : a.ctl;
      const ctrls = (live ? state.controls : a.controls) || [];
      const grid = live ? state.grid : a.grid, geo = live ? state.geo : a.geo;
      const points = modelPoints(grid, geo, live ? state.gauge : a.gauge, ctrls);
      out.areas.push({
        id: detailed ? a.areaId : undefined,
        n: a.n, name: a.name, kind: meta.kind, g: meta.gaugeLatLon && meta.gaugeLatLon.map(r5), c: (meta.centerLatLon || meta.gaugeLatLon || []).map(r5), h: meta.halfKm || 10,
        rid: meta.reportId || null, pin: meta.pinN != null ? meta.pinN : null, pre: meta.presetId || null, ctl: ctlv,
        gp: points.gp, cp: points.cp, sa: live ? state.streamAreaKm2 : a.streamAreaKm2,
        def: a.defences && (a.defences.levees.length || a.defences.gates.length) ? a.defences : null,
      });
    }
    const act = state.areaKey && areaReg.get(state.areaKey);
    out.active = act ? act.n : (selectedNum != null ? selectedNum : null);
    out.studies = studies.map((x) => ({ l: x.letter, b: x.bounds.map(r5), name: x.name, m: x.nums || [] }));
    return out;
  }
  const b64 = (str) => {
    // chunked char codes: spreading every byte into fromCharCode throws
    // RangeError past ~65 k bytes, which saved share links would hit
    const bytes = new TextEncoder().encode(str);
    let s = '';
    for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
    return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  };
  const unb64 = (txt) => new TextDecoder().decode(Uint8Array.from(atob(txt.replace(/-/g, '+').replace(/_/g, '/')), (ch) => ch.charCodeAt(0)));
  function shareUrl() { return `${location.origin}${location.pathname}#s=${b64(JSON.stringify(sessionState()))}`; }
  window.__floodShareUrl = shareUrl;
  function saveSessionSoon() {
    if (restoring) return;
    clearTimeout(sessionT);
    sessionT = setTimeout(() => {
      if (restoring || !state.lmap) return;
      const st = sessionState();
      try {
        if (!st.reports.length && !st.pins.length && !st.areas.length) localStorage.removeItem(SESSION_KEY);
        else localStorage.setItem(SESSION_KEY, JSON.stringify(st));
      } catch (e) { /* storage unavailable */ }
    }, 1500);
  }
  async function restoreSession(st, why) {
    if (!st || st.v !== 1 || !state.lmap) return false;
    restoring = true;
    if (nat.data) await ensureRiverGauges();
    status.restore = { running: true, why };
    try {
      if (!nat.data) await loadNationalData();
      for (const x of st.studies || []) {
        if (studies.some((y) => y.bounds.join() === x.b.join())) continue;
        const sObj = { letter: studies.some((y) => y.letter === x.l) ? nextLetter() : x.l, bounds: x.b, name: x.name, created: new Date().toISOString(), summary: null, loaded: false, nums: Array.isArray(x.m) ? x.m : [] };
        studies.push(sObj); drawStudy(sObj);
      }
      saveStudies();
      const all = [...(nat.data.gauges || []), ...(nat.data.storages || [])];
      for (const r of st.reports || []) {
        const f = all.find((x) => `${x.properties.kind}:${x.properties.id}` === r.id);
        if (f) openReport(f, { n: r.n, select: false });
      }
      for (const p of st.pins || []) if (!pins.some((q) => q.n === p.n)) addPin(p.lat, p.lon, { n: p.n, name: p.name, select: false });
      for (const c of st.checks || []) {
        if (propertyChecks.some((x) => x.id === c.id)) continue;
        const rec = { id: c.id, key: `${Math.round(c.lat * 1e5)},${Math.round(c.lon * 1e5)}`, created: c.created, when: c.created ? new Date(c.created).toLocaleDateString('en-AU', { day: 'numeric', month: 'short', year: 'numeric' }) : '', lat: c.lat, lon: c.lon, name: c.name, headline: c.headline || '', snapshot: c.snap || {} };
        propertyChecks.push(rec);
      }
      const areas = (st.areas || []).slice().sort((x, y) => x.n - y.n);
      for (const [k, a] of areas.entries()) {
        if (numberUsed(a.n) && areaByNumber(a.n)) continue;
        setBusy(true, `Rebuilding flood model ${k + 1} of ${areas.length}…`);
        const size = MODEL_SIZES.find(([h]) => h === a.h) || MODEL_SIZES[0];
        const rep = a.rid && reports.find((r) => r.id === a.rid);
        // Older links stored only the slider; restore its catchment threshold
        // before analysing terrain or snapping the saved level points.
        const sa = a.sa ?? (a.ctl && a.ctl.streamArea != null ? streamFromSlider(Number(a.ctl.streamArea)) : undefined);
        let ok;
        if (a.id) {
          await loadArea(a.id, { keepN: a.n, streamAreaKm2: sa });
          ok = state.areaId === a.id;
        } else ok = await modelHere(a.g[0], a.g[1], {
          kind: a.kind, name: a.name, reportId: rep ? rep.id : null, pinN: a.pin, presetId: a.pre,
          halfKm: size[0], cellM: size[1], center: a.c, keepN: a.n, quiet: true,
          streamAreaKm2: Number.isFinite(sa) && sa > 0 ? sa : undefined,
        });
        if (!ok) continue;
        // wait until the model is registered on the map, so its settings are
        // saved with it rather than lost when it is next selected
        for (let t = 0; t < 80 && !(state.areaKey && areaByNumber(a.n) && areaByNumber(a.n).key === state.areaKey); t++) await new Promise((r) => setTimeout(r, 100));
        if (a.ctl) CTL_KEYS.forEach((key) => { if (key !== 'streamArea' && a.ctl[key] != null) ctl[key].value = a.ctl[key]; });
        if (a.def) { const na = areaByNumber(a.n); if (na) { na.defences = a.def; await applyDefences(); } }
        restoreModelPoints(a);
        state.base = null;
        syncOutputs();
        runScenario();
        saveActive();
      }
      if (st.active != null) {
        const a = areaByNumber(st.active);
        if (a) activateArea(a.key); else if (numberUsed(st.active)) selectPlace(st.active);
      }
      if (st.view) state.lmap.setView([st.view[0], st.view[1]], st.view[2]);
      const n = (st.reports || []).length + (st.pins || []).length + areas.filter((a) => !(st.reports || []).some((r) => r.n === a.n) && !(st.pins || []).some((p) => p.n === a.n)).length;
      status.restore = { ok: true, why, places: n, areas: areas.length };
      if (n) say(why === 'link' ? `Opened ${n} place${n === 1 ? '' : 's'} from the link.` : `Restored ${n} place${n === 1 ? '' : 's'} from your last visit.`);
      return true;
    } catch (err) {
      status.restore = { ok: false, error: String(err.message || err) };
      return false;
    } finally {
      restoring = false;
      setBusy(false);
      renderPlaces();
      saveSessionSoon();
    }
  }
  window.__floodRestore = (st) => restoreSession(st, 'test');
  async function restoreOnStart() {
    const m = /[#&]s=([A-Za-z0-9_-]+)/.exec(location.hash || '');
    if (m) {
      try { await restoreSession(JSON.parse(unb64(m[1])), 'link'); } catch (e) { say('That link could not be read.', { error: true }); }
      return;
    }
    let saved;
    try { saved = JSON.parse(localStorage.getItem(SESSION_KEY) || 'null'); } catch (e) { saved = null; }
    if (saved) await restoreSession(saved, 'saved');
  }
  $('shareBtn').addEventListener('click', async () => {
    const url = shareUrl();
    try { await navigator.clipboard.writeText(url); say('Link copied: it opens this view with all your places, scenarios and study areas.'); } catch (e) { window.prompt('Copy this link:', url); }
  });
  function clearAllPlaces() {
    reports.slice().forEach(closeReport);
    Array.from(areaReg.keys()).forEach((k) => removeArea(k, { quiet: true }));
    pins.splice(0).forEach((p) => p.marker && state.lmap && state.lmap.removeLayer(p.marker));
    propertyChecks.length = 0;
    hiddenNums.clear();
    selectedNum = null;
    try { localStorage.removeItem(SESSION_KEY); } catch (e) { /* nothing saved */ }
    $('area').value = 'australia';
    enterNational({ fit: false });
    renderPlaces();
  }

  /* ---------- address search (OpenStreetMap Nominatim) */
  // Searches run only when you press Enter (Nominatim's usage policy rules
  // out search-as-you-type). Picking a result flies there and shows the
  // flood depth if a model covers it, with a button to add it as a place.
  $('searchForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const q = $('searchInput').value.trim();
    const box = $('searchResults');
    if (!q) { box.hidden = true; return; }
    box.hidden = false;
    box.innerHTML = '<p class="hint">Searching…</p>';
    try {
      const r = await fetch(`https://nominatim.openstreetmap.org/search?format=jsonv2&countrycodes=au&limit=6&q=${encodeURIComponent(q)}`, { headers: { 'Accept-Language': 'en-AU' } });
      const list = r.ok ? await r.json() : [];
      status.search = { ok: r.ok, results: list.length };
      if (!list.length) { box.innerHTML = '<p class="hint">No matches in Australia.</p>'; return; }
      box.innerHTML = list.map((x, i) => {
        const [first, ...rest] = String(x.display_name).split(', ');
        return `<button type="button" data-i="${i}">${escapeHtml(first)}<small>${escapeHtml(rest.slice(0, 4).join(', '))}</small></button>`;
      }).join('') + '<p class="hint">Search by <a href="https://nominatim.org/" target="_blank" rel="noopener">OpenStreetMap Nominatim</a>.</p>';
      box.querySelectorAll('[data-i]').forEach((b) => b.addEventListener('click', () => {
        const x = list[+b.dataset.i];
        box.hidden = true;
        goToSearchResult(parseFloat(x.lat), parseFloat(x.lon), String(x.display_name).split(', ').slice(0, 2).join(', '));
      }));
    } catch (err) {
      box.innerHTML = '<p class="hint">Search is unavailable right now.</p>';
      status.search = { ok: false, error: String(err.message || err) };
    }
  });
  document.addEventListener('click', (e) => { if (!e.target.closest('#searchForm, #searchResults')) $('searchResults').hidden = true; });
  async function goToSearchResult(lat, lon, label) {
    if (!state.lmap || $('lmap').hidden) await loadArea('australia');
    const m = state.lmap;
    m.setView([lat, lon], Math.max(m.getZoom(), 15));
    const ll = window.L.latLng(lat, lon);
    const hit = areaAt(ll);
    let extra = '';
    if (hit) {
      if (hit.key !== state.areaKey) activateArea(hit.key);
      await state.ready;
      const c = state.a && latLngCell(ll);
      if (c) extra = `<span class="spot-near">${escapeHtml(describe(c.i))} · in ${hit.n}. ${escapeHtml(hit.name)}</span>`;
    } else {
      extra = '<span class="spot-near">No flood model covers this spot yet.</span>';
    }
    status.searchHit = { inModel: !!hit };
    spotPopup(ll, `<span class="spot-name">${escapeHtml(label)}</span>${extra}<button type="button" class="link-btn spot-check">Check this property</button>`, 'Add as a place', () => addPin(lat, lon, { name: label }));
    const chk = document.querySelector('.leaflet-popup .spot-check');
    if (chk) chk.addEventListener('click', () => { state.lmap.closePopup(); checkProperty(lat, lon, label); });
  }
  window.__floodGoTo = goToSearchResult;

  /* ---------- downloads */
  function slug(t) { return String(t || 'flood').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || 'flood'; }
  function download(blob, name) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = name;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 5000);
  }
  // Minimal single-strip float32 GeoTIFF in WGS84 lon/lat.
  function geoTiffBytes(data, W, H, g, nodata) {
    const sx = (g.east - g.west) / W, sy = (g.north - g.south) / H;
    const nd = `${nodata}\0`;
    const e = [
      [256, 4, [W]], [257, 4, [H]], [258, 3, [32]], [259, 3, [1]], [262, 3, [1]], [273, 4, [0]], [277, 3, [1]],
      [278, 4, [H]], [279, 4, [W * H * 4]], [284, 3, [1]], [339, 3, [3]],
      [33550, 12, [sx, sy, 0]], [33922, 12, [0, 0, 0, g.west, g.north, 0]],
      [34735, 3, [1, 1, 0, 3, 1024, 0, 1, 2, 1025, 0, 1, 1, 2048, 0, 1, 4326]],
      [42113, 2, nd],
    ];
    const size = { 2: 1, 3: 2, 4: 4, 12: 8 };
    const ifdLen = 2 + e.length * 12 + 4;
    let extra = 8 + ifdLen;
    const extras = [];
    for (const [, t, v] of e) {
      const bytes = size[t] * v.length;
      if (bytes > 4) { extras.push(extra); extra += bytes + (bytes % 2); } else extras.push(-1);
    }
    const dataOff = extra + (extra % 4 ? 4 - (extra % 4) : 0);
    const buf = new ArrayBuffer(dataOff + W * H * 4), dv = new DataView(buf);
    dv.setUint16(0, 0x4949); dv.setUint16(2, 42, true); dv.setUint32(4, 8, true);
    dv.setUint16(8, e.length, true);
    e.forEach(([tag, t, v0], k) => {
      const v = tag === 273 ? [dataOff] : v0;
      const o = 10 + k * 12;
      dv.setUint16(o, tag, true); dv.setUint16(o + 2, t, true); dv.setUint32(o + 4, v.length, true);
      const at = extras[k] >= 0 ? extras[k] : o + 8;
      if (extras[k] >= 0) dv.setUint32(o + 8, at, true);
      for (let i = 0; i < v.length; i++) {
        if (t === 2) dv.setUint8(at + i, v.charCodeAt(i));
        else if (t === 3) dv.setUint16(at + 2 * i, v[i], true);
        else if (t === 4) dv.setUint32(at + 4 * i, v[i], true);
        else dv.setFloat64(at + 8 * i, v[i], true);
      }
    });
    dv.setUint32(10 + e.length * 12, 0, true);
    new Float32Array(buf, dataOff, W * H).set(data);
    return buf;
  }
  function placeLabel() { const a = state.areaKey && areaReg.get(state.areaKey); return a ? `${a.n}-${a.name}` : 'flood-model'; }
  function downloadDepthTiff() {
    const a = state.a, run = state.run, g = state.geo;
    if (!a || !run || !g) return false;
    const out = new Float32Array(a.N);
    for (let i = 0; i < a.N; i++) out[i] = run.wet[i] && !(a.ocean && a.ocean[i]) ? Math.round(run.depth[i] * 100) / 100 : -9999;
    download(new Blob([geoTiffBytes(out, a.W, a.H, g, -9999)], { type: 'image/tiff' }), `flood-depth-${state.inertial ? '2d-final-' : ''}${slug(placeLabel())}.tif`);
    return true;
  }
  function floodGeoJSON() {
    const a = state.a, run = state.run, g = state.geo;
    if (!a || !run || !g) return null;
    const step = a.N > 1.2e6 ? 2 : 1, W2 = Math.ceil(a.W / step), H2 = Math.ceil(a.H / step);
    const wetAt = (x, y) => {
      for (let dy = 0; dy < step; dy++) for (let dx = 0; dx < step; dx++) {
        const xx = x * step + dx, yy = y * step + dy;
        if (xx < a.W && yy < a.H) { const i = yy * a.W + xx; if (run.wet[i] && !(a.ocean && a.ocean[i])) return true; }
      }
      return false;
    };
    const sx = ((g.east - g.west) / a.W) * step, sy = ((g.north - g.south) / a.H) * step;
    const polys = [];
    let open = new Map();
    const close = (r) => {
      const x0 = r5(g.west + r.x0 * sx), x1 = r5(Math.min(g.east, g.west + r.x1 * sx));
      const y0 = r5(g.north - r.y0 * sy), y1 = r5(Math.max(g.south, g.north - r.y1 * sy));
      polys.push([[[x0, y0], [x0, y1], [x1, y1], [x1, y0], [x0, y0]]]);
    };
    for (let y = 0; y <= H2; y++) {
      const next = new Map();
      if (y < H2) {
        let x = 0;
        while (x < W2) {
          if (!wetAt(x, y)) { x++; continue; }
          const x0 = x;
          while (x < W2 && wetAt(x, y)) x++;
          const key = `${x0},${x}`, r = open.get(key);
          if (r) { r.y1 = y + 1; next.set(key, r); open.delete(key); } else next.set(key, { x0, x1: x, y0: y, y1: y + 1 });
        }
      }
      open.forEach(close);
      open = next;
    }
    const s0 = scenario(), area = state.areaKey && areaReg.get(state.areaKey);
    return {
      type: 'FeatureCollection',
      features: [{
        type: 'Feature',
        properties: {
          name: area ? `${area.n}. ${area.name}` : 'Flood model', model: state.inertial ? 'local-inertial-2d-experimental' : 'fast-terrain',
          simulation: state.inertial || null, gauge_level_m: state.inertial ? null : s0.gaugeLevel, bay_level_m: state.inertial ? null : s0.bayLevel,
          level_points: state.inertial ? 0 : (state.controls || []).length, generated: new Date().toISOString(),
          source: (state.areaMeta && state.areaMeta.source) || '', note: 'Screening model only; not for evacuation or property decisions.',
        },
        geometry: { type: 'MultiPolygon', coordinates: polys },
      }],
    };
  }
  window.__floodGeoJSON = () => { const gj = floodGeoJSON(); return gj ? gj.features[0].geometry.coordinates.length : -1; };
  function downloadGeoJSON() {
    const gj = floodGeoJSON();
    if (!gj) return false;
    download(new Blob([JSON.stringify(gj)], { type: 'application/geo+json' }), `flood-outline-${state.inertial ? '2d-final-' : ''}${slug(placeLabel())}.geojson`);
    return true;
  }
  function printableReport() {
    const area = state.areaKey && areaReg.get(state.areaKey);
    if (!area || !state.run) return false;
    const rows = Array.from(document.querySelectorAll('#scenarioBody .slider')).filter((el) => !el.closest('[hidden]')).map((el) => {
      const lab = el.querySelector('label'), out = el.querySelector('output');
      return lab && out ? `<tr><th>${escapeHtml(lab.textContent)}</th><td>${escapeHtml(out.textContent)}</td></tr>` : '';
    }).join('');
    const pts = (state.controls || []).map((c) => `<tr><th>${escapeHtml(c.label || 'Level point')}</th><td>${c.level.toFixed(2)} m</td></tr>`).join('');
    const rep = area.reportId && reports.find((r) => r.id === area.reportId);
    const repHtml = rep ? Array.from(rep.el.querySelectorAll('.reading, .classes, .warn-item')).map((el) => el.outerHTML).join('') : '';
    const sat = $('satCheck').dataset.key === String(state.areaKey) ? $('satCheck').innerHTML : '';
    const impact = area.impact && !area.impact.error ? $('impactBox').innerHTML : '';
    const recScores = area.recScores ? Object.entries(area.recScores).map(([id, html]) => {
      const rec = RECORDED.find((r) => r.id === id) || (area.recorded || []).find((r) => r.id === id);
      return `<h3>${escapeHtml(rec ? rec.name : id)}</h3>${html.replace(/<button[\s\S]*?<\/button>/g, '')}`;
    }).join('') : '';
    const storm = ctl.floodType.value !== 'river' ? `<p>${escapeHtml($('summaryLine').textContent)}</p><p>${$('stormSummary').innerHTML}</p>` : '';
    const g = state.geo, img = overlayImageUrl(area.overlay);
    const w = window.open('', '_blank');
    if (!w) { say('Allow pop-ups to open the printable report.'); return false; }
    w.document.write(`<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Flood report: ${escapeHtml(area.name)}</title>
      <style>body{font:14px/1.45 system-ui,sans-serif;color:#1d2a33;margin:24px;max-width:820px}h1{font-size:22px;margin:0 0 4px}h2{font-size:15px;margin:22px 0 6px;border-bottom:1px solid #ccd;padding-bottom:3px}
      table{border-collapse:collapse}th,td{text-align:left;padding:3px 12px 3px 0;vertical-align:top}th{font-weight:600}.stats{display:grid;grid-template-columns:repeat(4,1fr);gap:8px}.stats>*{border:1px solid #ccd;border-radius:6px;padding:6px}
      .map{border:1px solid #ccd;background:#eef2f5;padding:8px}.map img{width:100%;image-rendering:pixelated}.hint,small{color:#5a6b78;font-size:12px}.warn-item{display:block;background:#fff4e2;padding:6px;margin:4px 0;color:#5a3b00}
      svg{max-width:100%}@media print{button{display:none}}</style></head><body>
      <button onclick="print()">Print or save as PDF</button>
      <h1>${area.n}. ${escapeHtml(area.name)}</h1><p class="hint">Flood Explorer screening model · ${escapeHtml(new Date().toLocaleString('en-AU'))}</p>
      <h2>Result</h2><div class="stats">${$('stats').innerHTML}</div>
      <h2>Scenario</h2><table>${rows}${pts}</table>
      ${img ? `<h2>Flood extent</h2><div class="map"><img src="${img}" alt="Flood depth map"><p class="hint">Area ${g.south.toFixed(4)}° to ${g.north.toFixed(4)}° latitude, ${g.west.toFixed(4)}° to ${g.east.toFixed(4)}° longitude. Darker blue is deeper water.</p></div>` : ''}
      ${storm ? `<h2>Storm</h2>${storm}` : ''}
      ${impact ? `<h2>What's affected</h2>${impact}` : ''}
      ${recScores ? `<h2>Accuracy against recorded floods</h2>${recScores}` : ''}
      ${repHtml ? `<h2>Gauge</h2>${repHtml}` : ''}
      ${sat ? `<h2>Satellite check</h2>${sat}` : ''}
      <h2>About this model</h2><p>${escapeHtml((state.areaMeta && state.areaMeta.source) || '')}</p>
      <p class="hint">Screening only: it shows land below the chosen water surface that connects to the river or sea. It misses levees, drains and the timing of a flood. Do not use for evacuation or property decisions; follow official warnings from the Bureau of Meteorology and your state emergency service.</p>
      <p class="hint">Open this model: <a href="${escapeHtml(shareUrl())}">link</a></p></body></html>`);
    w.document.close();
    return true;
  }
  $('dlTiff').addEventListener('click', downloadDepthTiff);
  $('dlGeojson').addEventListener('click', downloadGeoJSON);
  $('dlReport').addEventListener('click', printableReport);
  window.__floodDepthTiffBytes = () => { const a = state.a; return a && state.run ? geoTiffBytes(new Float32Array(a.N), a.W, a.H, state.geo, -9999).byteLength : -1; };

  /* ---------- shared: ArcGIS queries and drawing polygons onto a model grid */
  const degPerM = 1 / 111320;
  async function esriFeatures(layerUrl, g, opts) {
    const o = opts || {};
    const out = [];
    for (let offset = 0, page = 0; page < 20; page++) {
      const params = new URLSearchParams({
        where: o.where || '1=1', geometry: `${g.west},${g.south},${g.east},${g.north}`, geometryType: 'esriGeometryEnvelope',
        inSR: '4326', spatialRel: 'esriSpatialRelIntersects', outSR: '4326', outFields: o.fields || 'OBJECTID',
        returnGeometry: 'true', f: 'json', resultOffset: String(offset), resultRecordCount: String(o.page || 1000),
      });
      if (o.simplify) params.set('maxAllowableOffset', String(o.simplify));
      const r = await fetch(`${layerUrl}/query?${params}`);
      if (!r.ok) throw new Error(`${r.status}`);
      const j = await r.json();
      if (j.error) throw new Error(j.error.message || 'query failed');
      out.push(...(j.features || []));
      if (!j.exceededTransferLimit || !(j.features || []).length) break;
      offset += j.features.length;
    }
    return out;
  }
  // Draw polygons (Esri rings, lon/lat) onto a W×H canvas over bounds g.
  function drawRings(features, g, W, H, colorOf) {
    const cv = document.createElement('canvas');
    cv.width = W; cv.height = H;
    const ctx = cv.getContext('2d');
    ctx.imageSmoothingEnabled = false;
    const sx = W / (g.east - g.west), sy = H / (g.north - g.south);
    features.forEach((f, i) => {
      const rings = f.geometry && f.geometry.rings;
      if (!rings) return;
      ctx.beginPath();
      for (const ring of rings) ring.forEach(([x, y], k) => {
        const px = (x - g.west) * sx, py = (g.north - y) * sy;
        if (k) ctx.lineTo(px, py); else ctx.moveTo(px, py);
      });
      ctx.fillStyle = colorOf(f, i);
      ctx.fill('evenodd');
    });
    return ctx.getImageData(0, 0, W, H).data;
  }

  /* ---------- impact: buildings, roads, key sites and people affected */
  // Buildings, roads and key sites come from OpenStreetMap (Overpass API);
  // people from the ABS 2021 Census by SA1, spread across each SA1's
  // buildings. Counts are for the active model and current scenario.
  const OVERPASS = ['https://overpass-api.de/api/interpreter', 'https://maps.mail.ru/osm/tools/overpass/api/interpreter', 'https://overpass.kumi.systems/api/interpreter'];
  const ABS_SA1 = 'https://geo.abs.gov.au/arcgis/rest/services/Hosted/ABS_2021_Census_G01_SA1/FeatureServer/0';
  const ABS_SA2 = 'https://geo.abs.gov.au/arcgis/rest/services/ASGS2021/SA2/FeatureServer/0';
  // workers by place of work per SA2 (ABS 2021 Working Population Profile),
  // collected by the build; loaded the first time impact is counted
  let workersP = null;
  const workersBySa2 = () => (workersP = workersP || fetch('data/workers.json').then((r) => (r.ok ? r.json() : null)).catch(() => null));
  // area of Esri polygon rings in km² (lon/lat degrees; holes subtract)
  function ringsKm2(rings) {
    let a2 = 0;
    for (const ring of rings || []) {
      let sum = 0, lat = 0;
      for (let k = 0; k < ring.length; k++) { const [x0, y0] = ring[k], [x1, y1] = ring[(k + 1) % ring.length]; sum += x0 * y1 - x1 * y0; lat += y0; }
      a2 += (sum / 2) * 111.32 * 110.574 * Math.cos(((lat / Math.max(1, ring.length)) * Math.PI) / 180);
    }
    return Math.abs(a2);
  }
  const SITE_KINDS = {
    hospital: 'Hospital', clinic: 'Clinic', doctors: 'Doctors', school: 'School', kindergarten: 'Kindergarten', childcare: 'Childcare',
    nursing_home: 'Aged care', fire_station: 'Fire station', police: 'Police', ambulance_station: 'Ambulance', community_centre: 'Community centre',
  };
  const ROAD_TYPES = 'motorway|trunk|primary|secondary|tertiary|unclassified|residential|living_street';
  async function overpass(q) {
    let last = null;
    for (const url of OVERPASS) {
      try {
        const r = await fetch(url, { method: 'POST', body: new URLSearchParams({ data: q }) });
        if (r.ok) return await r.json();
        last = new Error(`OpenStreetMap service returned ${r.status}`);
      } catch (err) { last = err; }
    }
    throw last || new Error('OpenStreetMap service unavailable');
  }
  // The build keeps copies of OpenStreetMap for the presets (data/osm/):
  // used when one covers the whole model, so counts don't wait on Overpass
  let osmIndex;
  async function osmCopy(g) {
    if (osmIndex === undefined) {
      try { const r = await fetch('data/osm/index.json'); osmIndex = r.ok ? await r.json() : []; } catch (err) { osmIndex = []; }
    }
    const hit = (osmIndex || []).find((x) => x.bbox[0] <= g.south && x.bbox[1] <= g.west && x.bbox[2] >= g.north && x.bbox[3] >= g.east);
    if (!hit) return null;
    try {
      const r = await fetch(`data/osm/${hit.id}.json`);
      if (!r.ok) return null;
      const d = await r.json();
      const inBox = (lat, lon) => lat >= g.south && lat <= g.north && lon >= g.west && lon <= g.east;
      const bx = [], by = [], isHome = [], isWork = [];
      for (let i = 0; i < d.f.length; i++) {
        const lon = d.b[2 * i], lat = d.b[2 * i + 1];
        if (!inBox(lat, lon)) continue;
        bx.push(lon); by.push(lat); isHome.push(d.f[i] & 1 ? 1 : 0); isWork.push(d.f[i] & 2 ? 1 : 0);
      }
      // roads with any point in the model (kept whole, so they join up)
      const roads = [];
      for (const [name, type, seq] of d.roads) {
        if (!seq.some((k) => inBox(d.nodes[2 * k], d.nodes[2 * k + 1]))) continue;
        roads.push({ name, type, pts: seq.map((k) => ({ lat: d.nodes[2 * k], lon: d.nodes[2 * k + 1] })), nodes: seq });
      }
      const sites = d.sites.filter((x) => inBox(x[2], x[3])).map(([name, kind, lat, lon]) => ({ name, kind, lat, lon }));
      return { bx, by, isHome: Uint8Array.from(isHome), isWork: Uint8Array.from(isWork), roads, sites, copy: { id: hit.id, fetched: d.fetched } };
    } catch (err) { return null; }
  }
  async function loadImpactData(area) {
    const g = area.geo || state.geo;
    const copy = await osmCopy(g);
    if (copy) return finishImpactData(g, copy.bx, copy.by, copy.isHome, copy.isWork, copy.roads, copy.sites, copy.copy);
    const bb = `${g.south},${g.west},${g.north},${g.east}`;
    // sections are separated by markers so ids-only blocks can be told apart
    const mark = (n) => `make marker name="${n}";out;`;
    const q = `[out:json][timeout:150];
      ${mark('buildings')}way["building"](${bb});out ids center qt;
      ${mark('homes')}way["building"~"^(house|residential|detached|semidetached_house|terrace|apartments|bungalow|dormitory|duplex|cabin)$"](${bb});out ids qt;
      ${mark('work')}way["building"~"^(commercial|retail|industrial|office|warehouse|supermarket|school|university|college|hospital|public|civic|government|kindergarten)$"](${bb});out ids qt;
      ${mark('roads')}way["highway"~"^(${ROAD_TYPES})(_link)?$"](${bb});out body geom qt;
      ${mark('sites')}nwr["amenity"~"^(${Object.keys(SITE_KINDS).join('|')})$"](${bb});out tags center qt;
      nwr["social_facility"~"^(nursing_home|assisted_living)$"](${bb});out tags center qt;
      nwr["emergency"~"^(evacuation_centre|evacuation_center)$"](${bb});out tags center qt;
      nwr["evacuation_centre"="yes"](${bb});out tags center qt;nwr["evacuation_center"="yes"](${bb});out tags center qt;`;
    const osm = await overpass(q);
    const els = osm.elements || [];
    const bIdx = new Map(), bx = [], by = [], homes = new Set(), work = new Set();
    const roads = [], sites = [];
    let section = '';
    for (const e of els) {
      if (e.type === 'marker') { section = e.tags && e.tags.name; continue; }
      if (section === 'buildings' && e.center) { if (!bIdx.has(e.id)) { bIdx.set(e.id, bx.length); bx.push(e.center.lon); by.push(e.center.lat); } } else if (section === 'homes') homes.add(e.id);
      else if (section === 'work') work.add(e.id);
      else if (section === 'roads' && e.geometry) roads.push({ name: (e.tags && (e.tags.name || e.tags.ref)) || '', type: e.tags ? e.tags.highway : '', pts: e.geometry, nodes: e.nodes || [] });
      else if (section === 'sites' && e.tags) {
        const ll = e.center || (e.lat != null ? { lat: e.lat, lon: e.lon } : null);
        const evac = /^evacuation_cent(re|er)$/.test(e.tags.emergency || '') || e.tags.evacuation_centre === 'yes' || e.tags.evacuation_center === 'yes';
        const kind = evac ? EVAC : SITE_KINDS[e.tags.amenity] || (e.tags.social_facility ? 'Aged care' : null);
        if (ll && kind) sites.push({ name: e.tags.name || kind, kind, lat: ll.lat, lon: ll.lon });
      }
    }
    const isHome = new Uint8Array(bx.length), isWork = new Uint8Array(bx.length);
    for (const [id, i] of bIdx) { if (homes.has(id)) isHome[i] = 1; if (work.has(id)) isWork[i] = 1; }
    return finishImpactData(g, bx, by, isHome, isWork, roads, sites, null);
  }
  async function finishImpactData(g, bx, by, isHome, isWork, roads, sites, copy) {
    // road network: nodes shared between ways join them
    const nodeIdx = new Map(), nlat = [], nlon = [], edges = [];
    roads.forEach((rd, ri) => {
      const ids = rd.nodes.length === rd.pts.length ? rd.nodes : rd.pts.map((p) => `${p.lat.toFixed(6)},${p.lon.toFixed(6)}`);
      let prev = -1;
      ids.forEach((id, k) => {
        let n = nodeIdx.get(id);
        if (n == null) { n = nlat.length; nodeIdx.set(id, n); nlat.push(rd.pts[k].lat); nlon.push(rd.pts[k].lon); }
        if (prev >= 0) edges.push([prev, n, ri]);
        prev = n;
      });
    });
    const net = { lat: Float64Array.from(nlat), lon: Float64Array.from(nlon), edges };
    // people: ABS SA1 populations (optional)
    let sa1 = null;
    try {
      const feats = await esriFeatures(ABS_SA1, g, { fields: '*', simplify: 20 * degPerM, page: 1000 });
      const key = feats.length && Object.keys(feats[0].attributes || {}).find((k) => /^tot_p_p$/i.test(k));
      if (key) sa1 = { feats, pop: feats.map((f) => Number(f.attributes[key]) || 0), km2: feats.map((f) => ringsKm2(f.geometry && f.geometry.rings)) };
    } catch (err) { sa1 = null; }
    // workers: each SA2's workers by place of work (optional)
    let sa2 = null;
    try {
      const wk = await workersBySa2();
      if (wk && wk.workers) {
        const feats = await esriFeatures(ABS_SA2, g, { fields: '*', simplify: 50 * degPerM, page: 200 });
        const key = feats.length && Object.keys(feats[0].attributes || {}).find((k) => /^sa2_code(_?2021)?$/i.test(k));
        if (key) sa2 = { feats, workers: feats.map((f) => Number(wk.workers[String(f.attributes[key])]) || 0), km2: feats.map((f) => ringsKm2(f.geometry && f.geometry.rings)) };
      }
    } catch (err) { sa2 = null; }
    return { bx: Float64Array.from(bx), by: Float64Array.from(by), isHome, isWork, roads, net, sites, sa1, sa2, fetched: copy ? Date.parse(copy.fetched) : Date.now(), copy };
  }
  function cellOf(lat, lon) {
    const g = state.geo, a = state.a;
    const x = Math.floor(((lon - g.west) / (g.east - g.west)) * a.W), y = Math.floor(((g.north - lat) / (g.north - g.south)) * a.H);
    return x < 0 || y < 0 || x >= a.W || y >= a.H ? -1 : y * a.W + x;
  }
  function computeImpact(d, useCache) {
    const a = state.a, run = state.run;
    if (!a || !run || !d) return null;
    // Everything but the floor-height numbers depends only on the impact
    // data and the model run, so memoise the heavy sweep on d. Runs and
    // area objects are replaced per scenario, invalidating naturally (like
    // state.hazard); draw and per-call work beyond one floor loop goes away.
    if (!useCache || !d.cache || d.cache.a !== a || d.cache.run !== run) {
      const ts = Date.now();   // (Date, not performance: tests run this outside a browser)
      d.cache = { a, run, base: computeScenarioImpact(d, a, run) };
      d.cache.sweepMs = Date.now() - ts;
    }
    const base = d.cache.base;
    const noFloor = $('floorUnknown') && $('floorUnknown').checked;
    const floorH = noFloor ? null : parseFloat($('floorHeight').value);
    const nB = d.bx.length;
    let overFloor = null, damage = null;
    if (floorH != null) {
      overFloor = 0; damage = 0;
      for (let i = 0; i < nB; i++) {
        const z = base.bDepth[i];
        if (z > floorH && z > 0) { overFloor++; damage += damageShare(z - floorH); }
      }
      damage *= Math.max(0, parseFloat($('bldValue').value) || 0);
    }
    return Object.assign({}, base, { overFloor, floorH, damage });
    // The heavy sweep: buildings, roads and isolation (BFS over dry roads),
    // people (SA1), workers (SA2), road lengths and key sites. Rebuilt only
    // when the impact data or the run changes.
    function computeScenarioImpact(d, a, run) {
    const depthAt = (c) => (c >= 0 && run.wet[c] && !(a.ocean && a.ocean[c]) ? run.depth[c] : 0);
    // buildings
    const nB = d.bx.length;
    let bWet = 0, bDeep = 0, hWet = 0, workWet = 0;
    const bCell = new Int32Array(nB), bFlood = new Uint8Array(nB), bDepth = new Float32Array(nB);
    for (let i = 0; i < nB; i++) {
      const c = cellOf(d.by[i], d.bx[i]);
      bCell[i] = c;
      const z = bDepth[i] = depthAt(c);
      if (z >= 0.15) {
        bWet++; bFlood[i] = 1;
        if (d.isHome[i]) hWet++;
        if (d.isWork[i]) workWet++;
        if (z >= 0.5) bDeep++;
      }
    }
    // evacuation: dry roads still joined to the edge of the model area by
    // dry roads; dry buildings whose nearest road is cut off are isolated
    const net = d.net;
    let isolatedB = 0, isolatedPeopleW = null, cutEdges = [], islandEdges = [];
    if (net && net.lat.length) {
      const nN = net.lat.length, g = state.geo;
      const dryNode = new Uint8Array(nN);
      for (let n = 0; n < nN; n++) dryNode[n] = depthAt(cellOf(net.lat[n], net.lon[n])) < 0.3 ? 1 : 0;
      const adj = Array.from({ length: nN }, () => []);
      const edgeDry = net.edges.map(([u, v]) => {
        let ok = dryNode[u] && dryNode[v];
        if (ok) for (let t = 1; t < 4 && ok; t++) { const f = t / 4; if (depthAt(cellOf(net.lat[u] + (net.lat[v] - net.lat[u]) * f, net.lon[u] + (net.lon[v] - net.lon[u]) * f)) >= 0.3) ok = 0; }
        return ok;
      });
      net.edges.forEach(([u, v], k) => { if (edgeDry[k]) { adj[u].push(v); adj[v].push(u); } });
      const mx = ((g.east - g.west) / a.W) * 3, my = ((g.north - g.south) / a.H) * 3;
      const reach = new Uint8Array(nN), q = [];
      for (let n = 0; n < nN; n++) {
        const edge = net.lat[n] < g.south + my || net.lat[n] > g.north - my || net.lon[n] < g.west + mx || net.lon[n] > g.east - mx;
        if (edge && dryNode[n]) { reach[n] = 1; q.push(n); }
      }
      for (let h = 0; h < q.length; h++) for (const m of adj[q[h]]) if (!reach[m]) { reach[m] = 1; q.push(m); }
      // roads that don't join the edge even when everything is dry (private
      // roads, mapping gaps) aren't cut off by the flood
      if (!net.dryReach) {
        const all = Array.from({ length: nN }, () => []);
        net.edges.forEach(([u, v]) => { all[u].push(v); all[v].push(u); });
        const dr = new Uint8Array(nN), q2 = [];
        for (let n = 0; n < nN; n++) if (net.lat[n] < g.south + my || net.lat[n] > g.north - my || net.lon[n] < g.west + mx || net.lon[n] > g.east - mx) { dr[n] = 1; q2.push(n); }
        for (let h = 0; h < q2.length; h++) for (const m of all[q2[h]]) if (!dr[m]) { dr[m] = 1; q2.push(m); }
        net.dryReach = dr;
      }
      net.edges.forEach(([u, v, ri], k) => {
        if (!edgeDry[k]) cutEdges.push([u, v]);
        else if (!reach[u] || !reach[v]) islandEdges.push([u, v]);
      });
      // nearest road node for each dry building (grid hash ~ 200 m)
      const hs = 0.002, hash = new Map();
      for (let n = 0; n < nN; n++) { const k = `${Math.floor(net.lat[n] / hs)},${Math.floor(net.lon[n] / hs)}`; let l = hash.get(k); if (!l) hash.set(k, (l = [])); l.push(n); }
      const isoB = new Uint8Array(nB);
      for (let i = 0; i < nB; i++) {
        if (bFlood[i]) continue;
        const ky = Math.floor(d.by[i] / hs), kx = Math.floor(d.bx[i] / hs);
        let best = -1, bd = Infinity;
        for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) for (const n of hash.get(`${ky + dy},${kx + dx}`) || []) {
          const dd = (net.lat[n] - d.by[i]) ** 2 + ((net.lon[n] - d.bx[i]) * 0.9) ** 2;
          if (dd < bd) { bd = dd; best = n; }
        }
        if (best >= 0 && dryNode[best] && !reach[best] && net.dryReach[best]) { isoB[i] = 1; isolatedB++; }
      }
      isolatedPeopleW = isoB;
    }
    // people: each SA1's population spread over its buildings (or its land)
    let people = null, peopleIsolated = null;
    if (d.sa1) {
      if (!d.sa1Grid || d.sa1Key !== state.areaKey + a.W) {
        const px = drawRings(d.sa1.feats, state.geo, a.W, a.H, (f, i) => `rgb(${(i + 1) >> 16 & 255},${(i + 1) >> 8 & 255},${(i + 1) & 255})`);
        const idg = new Int32Array(a.N).fill(-1);
        for (let c = 0; c < a.N; c++) { const v = (px[4 * c] << 16) | (px[4 * c + 1] << 8) | px[4 * c + 2]; if (px[4 * c + 3] > 250 && v > 0 && v <= d.sa1.feats.length) idg[c] = v - 1; }
        d.sa1Grid = idg; d.sa1Key = state.areaKey + a.W;
      }
      const nS = d.sa1.pop.length, tot = new Float64Array(nS), hit = new Float64Array(nS), land = new Float64Array(nS), wetL = new Float64Array(nS), inside = new Float64Array(nS);
      for (let i = 0; i < nB; i++) { const s = bCell[i] >= 0 ? d.sa1Grid[bCell[i]] : -1; if (s >= 0) { tot[s]++; if (bFlood[i]) hit[s]++; } }
      for (let c = 0; c < a.N; c++) { const s = d.sa1Grid[c]; if (s >= 0) inside[s] += (a.cell * a.cell) / 1e6; }
      for (let c = 0; c < a.N; c++) { const s = d.sa1Grid[c]; if (s >= 0 && !(a.ocean && a.ocean[c])) { land[s]++; if (depthAt(c) >= 0.15) wetL[s]++; } }
      // Buildings are fetched only inside the model. Allocate only the
      // covered share of each SA1's population, as for SA2 workers below.
      const pop = d.sa1.pop.map((p, s) => {
        const km2 = d.sa1.km2 ? d.sa1.km2[s] : ringsKm2(d.sa1.feats[s].geometry?.rings);
        return p * (km2 > 0 ? Math.min(1, inside[s] / km2) : 0);
      });
      people = 0;
      for (let s = 0; s < nS; s++) people += pop[s] * (tot[s] > 0 ? hit[s] / tot[s] : (land[s] ? wetL[s] / land[s] : 0));
      if (isolatedPeopleW) {
        const iso = new Float64Array(nS);
        for (let i = 0; i < nB; i++) { const s0 = bCell[i] >= 0 ? d.sa1Grid[bCell[i]] : -1; if (s0 >= 0 && isolatedPeopleW[i]) iso[s0]++; }
        peopleIsolated = 0;
        for (let s = 0; s < nS; s++) if (tot[s] > 0) peopleIsolated += pop[s] * (iso[s] / tot[s]);
      }
    }
    // workers: each SA2's workers (by place of work) spread over its mapped
    // workplaces (or all its buildings if none are mapped by type), scaled
    // by how much of the SA2 lies inside the model
    let workers = null, workersAll = null;
    if (d.sa2) {
      if (!d.sa2Grid || d.sa2Key !== state.areaKey + a.W) {
        const px = drawRings(d.sa2.feats, state.geo, a.W, a.H, (f, i) => `rgb(${(i + 1) >> 16 & 255},${(i + 1) >> 8 & 255},${(i + 1) & 255})`);
        const idg = new Int32Array(a.N).fill(-1);
        for (let c = 0; c < a.N; c++) { const v = (px[4 * c] << 16) | (px[4 * c + 1] << 8) | px[4 * c + 2]; if (px[4 * c + 3] > 250 && v > 0 && v <= d.sa2.feats.length) idg[c] = v - 1; }
        d.sa2Grid = idg; d.sa2Key = state.areaKey + a.W;
      }
      const nS = d.sa2.workers.length, wT = new Float64Array(nS), wH = new Float64Array(nS), bT = new Float64Array(nS), bH = new Float64Array(nS), inside = new Float64Array(nS);
      for (let i = 0; i < nB; i++) {
        const s = bCell[i] >= 0 ? d.sa2Grid[bCell[i]] : -1;
        if (s < 0) continue;
        bT[s]++; if (bFlood[i]) bH[s]++;
        if (d.isWork[i]) { wT[s]++; if (bFlood[i]) wH[s]++; }
      }
      const cellKm2 = (a.cell * a.cell) / 1e6;
      for (let c = 0; c < a.N; c++) { const s = d.sa2Grid[c]; if (s >= 0) inside[s] += cellKm2; }
      workers = 0; workersAll = 0;
      for (let s = 0; s < nS; s++) {
        const frac = d.sa2.km2[s] > 0 ? Math.min(1, inside[s] / d.sa2.km2[s]) : 0, W = d.sa2.workers[s] * frac;
        workersAll += W;
        workers += W * (wT[s] >= 3 ? wH[s] / wT[s] : bT[s] > 0 ? bH[s] / bT[s] : 0);
      }
    }
    // roads: length under more than 0.3 m of water (impassable to cars)
    const cutBy = new Map();
    let cutKm = 0, roadKm = 0;
    for (const rd of d.roads) {
      let cut = 0;
      for (let k = 1; k < rd.pts.length; k++) {
        const p0 = rd.pts[k - 1], p1 = rd.pts[k];
        const len = Math.hypot((p1.lon - p0.lon) * Math.cos((p0.lat * Math.PI) / 180), p1.lat - p0.lat) * 111.32;
        roadKm += len;
        const steps = Math.max(1, Math.ceil((len * 1000) / a.cell));
        let wetSteps = 0;
        for (let t = 0; t < steps; t++) {
          const f = (t + 0.5) / steps;
          if (depthAt(cellOf(p0.lat + (p1.lat - p0.lat) * f, p0.lon + (p1.lon - p0.lon) * f)) >= 0.3) wetSteps++;
        }
        cut += (len * wetSteps) / steps;
      }
      if (cut > 0) { cutKm += cut; const key = rd.name || `(unnamed ${rd.type})`; cutBy.set(key, (cutBy.get(key) || 0) + cut); }
    }
    const worstRoads = Array.from(cutBy.entries()).filter(([n]) => !n.startsWith('(unnamed')).sort((x, y) => y[1] - x[1]).slice(0, 8);
    // key sites
    const sitesHit = d.sites.map((s) => ({ ...s, depth: depthAt(cellOf(s.lat, s.lon)) })).filter((s) => s.depth >= 0.15).sort((x, y) => y.depth - x.depth);
    return {
      buildings: nB, bWet, bDeep, hWet, workers, workersAll, homesTagged: d.isHome.reduce((x, y) => x + y, 0), workWet, workTagged: d.isWork.reduce((x, y) => x + y, 0),
      bDepth, isolatedB, peopleIsolated, cutEdges, islandEdges, people, cutKm, roadKm, worstRoads, sites: d.sites.length, sitesHit,
    };
    }
  }
  // Indicative damage: the EU Joint Research Centre's global depth–damage
  // function for residential buildings in Oceania (Huizinga et al. 2017),
  // share of a building's value lost against water depth (m), applied to the
  // depth above the floor.
  const JRC_OCEANIA_RES = [[0, 0], [0.5, 0.475], [1, 0.64], [1.5, 0.715], [2, 0.788], [3, 0.929], [4, 0.967], [5, 0.983], [6, 1]];
  function damageShare(d) {
    if (d <= 0) return 0;
    for (let k = 1; k < JRC_OCEANIA_RES.length; k++) {
      const [d1, f1] = JRC_OCEANIA_RES[k], [d0, f0] = JRC_OCEANIA_RES[k - 1];
      if (d <= d1) return f0 + ((f1 - f0) * (d - d0)) / (d1 - d0);
    }
    return 1;
  }
  let impactLayer = null;
  // What the map marks were last built from, and which run the shown counts
  // describe — used to skip rebuilds and to flag stale counts when the
  // automatic updates are switched off.
  let impactDrawn = null;
  let impactShown = { areaKey: null, run: null };
  function maybeRenderImpact() {
    const auto = $('impactAuto');
    if (!(auto && auto.checked)) {
      // Automatic updates off: keep the last counts, flag them stale when
      // the scenario changed, and drop map marks that belong to the old run.
      if (impactShown.areaKey === state.areaKey && impactShown.run !== state.run) {
        if (impactLayer) impactLayer.clearLayers();
        if (roadsLayer) roadsLayer.clearLayers();
        impactDrawn = null;
        $('impactStale').hidden = false;
      }
      return;
    }
    if ($('impactStale')) $('impactStale').hidden = true;
    renderImpact();
  }
  let roadsLayer = null; // persistent overlay: toggled from the layers panel, not per-scenario
  function renderImpact() {
    if (state.inertial && !state.run) { $('impactBox').textContent = 'Load a terrain model first.'; status.impact = null; return; }
    const box = $('impactBox');
    const area = state.areaKey && areaReg.get(state.areaKey);
    if (!box || !area) return;
    const d = area.impact;
    if (!d) {
      box.innerHTML = ''; status.impact = null; if (impactLayer) impactLayer.clearLayers(); if (roadsLayer) roadsLayer.clearLayers(); impactDrawn = null;
      if (roadsLayer && state.lmap && state.lmap.hasLayer(roadsLayer) && !area.impactLoading) setTimeout(roadsLayerOn, 0);   // the layer is on: count this model too
      return;
    }
    if (d.error) { box.innerHTML = `<p class="hint">Couldn't fetch what's here: ${escapeHtml(d.error)}.</p>`; return; }
    const r = computeImpact(d, true);
    if (!r) return;
    if (d.cache) status.impactTiming = Object.assign(status.impactTiming || {}, { sweepMs: d.cache.sweepMs, buildings: d.bx.length, roads: d.roads ? d.roads.length : null });
    status.impact = {
      buildings: r.buildings, bWet: r.bWet, overFloor: r.overFloor, workWet: r.workWet, workers: r.workers == null ? null : Math.round(r.workers), isolated: r.isolatedB, damage: r.damage == null ? null : Math.round(r.damage),
      people: r.people == null ? null : Math.round(r.people), peopleIsolated: r.peopleIsolated == null ? null : Math.round(r.peopleIsolated),
      cutKm: Math.round(r.cutKm * 10) / 10, sites: r.sites, sitesHit: r.sitesHit.length,
      source: d.copy ? `copy:${d.copy.id}` : 'live',
    };
    if (state.pinned) setTimeout(renderCompare, 0);
    const n = (x) => Math.round(x).toLocaleString('en-AU');
    box.innerHTML = `<div class="stats">
        <div class="stat"><div class="label">Buildings flooded</div><div class="v">${n(r.bWet)}<small> of ${n(r.buildings)}</small></div></div>
        <div class="stat"><div class="label">People affected</div><div class="v">${r.people == null ? '–' : `≈${n(r.people)}`}</div></div>
        <div class="stat"><div class="label">Roads cut</div><div class="v">${r.cutKm.toFixed(1)}<small>km</small></div></div>
        <div class="stat"><div class="label">Key sites flooded</div><div class="v">${r.sitesHit.length}<small> of ${r.sites}</small></div></div>
        <div class="stat"><div class="label">Water above floor</div><div class="v">${r.overFloor == null ? '–' : `${n(r.overFloor)}<small> buildings</small>`}</div></div>
        <div class="stat"><div class="label">Indicative damage</div><div class="v">${r.damage == null ? '–' : r.damage >= 1e6 ? `$${(r.damage / 1e6).toFixed(1)}<small>m</small>` : `$${n(r.damage / 1000)}<small>k</small>`}</div></div>
        <div class="stat"><div class="label">Cut off, still dry</div><div class="v">${n(r.isolatedB)}<small> buildings${r.peopleIsolated != null ? ` · ≈${n(r.peopleIsolated)} people` : ''}</small></div></div></div>
      ${r.damage == null ? '<p class="hint"><strong>Floor height not known</strong>, so water-above-floor and damage are skipped. Find or survey floor levels, or untick &ldquo;no floor height known&rdquo; to estimate them.</p>' : '<p class="hint"><strong>Damage</strong> applies the EU Joint Research Centre\'s global depth–damage curve for homes in Oceania to the water above each building\'s floor, times the value per building you set: an order-of-magnitude guide, not an insurance or recovery estimate.</p>'}
      <p class="hint"><strong>Daytime:</strong> ${n(r.workWet)} flooded buildings are mapped as workplaces, shops, schools or public buildings${r.workTagged ? '' : ' (few buildings here are mapped by type)'}${r.workers != null ? `; about <strong>${n(r.workers)}</strong> of the ${n(r.workersAll)} people who work in the model area work in flooded buildings (ABS 2021 Census place of work by SA2, spread over each area's mapped workplaces)` : ''}. The people figure above counts residents. <strong>Cut off</strong> means the building's nearest road is dry but no dry road leads out of the model area (orange on the map); flooded roads are red.</p>
      <p class="hint">Flooded means at least 15 cm of water at the building or site; ${n(r.bDeep)} buildings have more than 50 cm${r.homesTagged ? `; ${n(r.hWet)} of the flooded buildings are mapped as homes` : ''}. Roads are cut where water is over 30 cm deep.</p>
      ${r.worstRoads.length ? `<p><strong>Roads cut:</strong> ${r.worstRoads.map(([nm, km]) => `${escapeHtml(nm)} (${km < 1 ? `${Math.round(km * 1000)} m` : `${km.toFixed(1)} km`})`).join(', ')}</p>` : ''}
      ${(() => { const ev = d.sites.filter((x) => x.kind === EVAC), evh = r.sitesHit.filter((x) => x.kind === EVAC); return ev.length ? `<p><strong>Evacuation centres:</strong> ${ev.length} mapped here (green on the map)${evh.length ? `, <strong>${evh.length} flooded</strong>: ${evh.map((x) => escapeHtml(x.name)).join(', ')}` : ', none flooded'}. Use <em>Check this property</em> for the dry route to one.</p>` : ''; })()}
      ${r.sitesHit.length ? `<p><strong>Key sites:</strong> ${r.sitesHit.slice(0, 12).map((s) => `${escapeHtml(s.name)} <small>(${s.kind.toLowerCase()}, ${s.depth.toFixed(1)} m)</small>`).join('; ')}${r.sitesHit.length > 12 ? ` and ${r.sitesHit.length - 12} more` : ''}</p>` : ''}
      ${state.inertial ? `<p class="hint"><strong>Experimental 2D model:</strong> depths are the local-inertial solver's final water depth on its coarse (${Math.round(state.inertial.cell)} m) grid — building, road and people figures are indicative only, and water keeps moving after this snapshot.</p>` : ''}
      <p class="hint">Buildings, roads and sites: © OpenStreetMap contributors (ODbL), complete only where mapped${d.copy ? ` (the site's copy from ${escapeHtml(new Date(d.copy.fetched).toLocaleDateString('en-AU', { day: 'numeric', month: 'short', year: 'numeric' }))})` : ''}. People: ABS 2021 Census by SA1, spread across each area's buildings${r.people == null ? ' (not available here right now)' : ''}. Estimates for screening only.</p>`;
    // mark flooded key sites, cut roads and cut-off roads on the map
    if (state.lmap) {
      if (!impactLayer) impactLayer = window.L.layerGroup().addTo(state.lmap);
      if (!roadsLayer) roadsLayer = window.L.layerGroup(); // registered at map init
      const net = d.net, seg = (list, style) => {
        if (!net || !list.length) return;
        window.L.polyline(list.map(([u, v]) => [[net.lat[u], net.lon[u]], [net.lat[v], net.lon[v]]]), Object.assign({ interactive: false }, style)).addTo(roadsLayer);
      };
      // rebuild the map marks only when the data, run or road toggle changed
      const roadOn = state.lmap.hasLayer(roadsLayer);
      const changed = !impactDrawn || impactDrawn.d !== d || impactDrawn.run !== state.run || impactDrawn.a !== state.a || impactDrawn.roadOn !== roadOn;
      if (changed) {
        const td = performance.now();
        impactLayer.clearLayers();
        roadsLayer.clearLayers();
        if (roadOn) {
          seg(r.cutEdges, { color: '#c62828', weight: 4, opacity: 0.85 });
          seg(r.islandEdges, { color: '#ef6c00', weight: 4, opacity: 0.9, dashArray: '6 4' });
        }
        // evacuation centres: green when dry, red ring when flooded
        d.sites.filter((x) => x.kind === EVAC).forEach((x) => {
          const hitE = r.sitesHit.some((h) => h.lat === x.lat && h.lon === x.lon);
          window.L.circleMarker([x.lat, x.lon], { radius: 8, color: hitE ? '#c62828' : '#ffffff', weight: 2.5, fillColor: '#1b7837', fillOpacity: 0.95 })
            .bindTooltip(`${escapeHtml(x.name)} (evacuation centre${hitE ? ', flooded' : ''})`).addTo(impactLayer);
        });
        r.sitesHit.forEach((s) => window.L.circleMarker([s.lat, s.lon], { radius: 7, color: '#c62828', weight: 2.5, fillColor: '#fff', fillOpacity: 0.9 })
          .bindTooltip(`${s.name}: ${s.kind}, ${s.depth.toFixed(1)} m of water`).addTo(impactLayer));
        impactDrawn = { d, run: state.run, a: state.a, roadOn };
        status.impactTiming = Object.assign(status.impactTiming || {}, { drawMs: Math.round((performance.now() - td) * 10) / 10, cutSegs: r.cutEdges.length, islandSegs: r.islandEdges.length });
      }
      impactShown = { areaKey: state.areaKey, run: state.run };
      if ($('impactStale')) $('impactStale').hidden = true;
      roadsReport();
    }
  }
  async function countImpact() {
    const area = state.areaKey && areaReg.get(state.areaKey);
    if (!area || !state.a) return null;
    const box = $('impactBox');
    box.innerHTML = '<p class="hint">Fetching buildings, roads and key sites from OpenStreetMap, and population from the ABS…</p>';
    status.impact = { loading: true };
    const tl = performance.now();
    try { area.impact = await loadImpactData(area); status.impactTiming = { loadMs: Math.round(performance.now() - tl) }; } catch (err) { area.impact = { error: String(err.message || err) }; status.impact = { error: area.impact.error }; }
    renderImpact();
    return status.impact;
  }
  busyClick($('impactBtn'), 'Counting buildings, people and roads…', () => countImpact());
  $('floorHeight').addEventListener('input', () => { const c = $('floorUnknown'); if (c && c.checked) c.checked = false; $('floorHeight').disabled = false; $('floorHeightOut').textContent = `${parseFloat($('floorHeight').value).toFixed(1)} m`; renderImpact(); });
  $('floorUnknown').addEventListener('change', () => { const c = $('floorUnknown'); $('floorHeight').disabled = !!c.checked; $('floorHeightOut').textContent = c.checked ? 'not known' : `${parseFloat($('floorHeight').value).toFixed(1)} m`; renderImpact(); });
  $('bldValue').addEventListener('change', () => renderImpact());
  window.__floodCountImpact = countImpact;

  /* ---------- accuracy: compare with recorded floods */
  const QLD_FLOODLINES = 'https://spatial-gis.information.qld.gov.au/arcgis/rest/services/InlandWaters/FloodLines/MapServer';
  const BCC_FS = 'https://services2.arcgis.com/dEKgZETqwmDAh1rP/ArcGIS/rest/services';
  const RECORDED = [
    { id: 'bcc2022', name: 'February 2022, Brisbane River and creeks (Brisbane City Council)', url: `${BCC_FS}/Flood_Awareness_Historic_Brisbane_River_and_Creek_Floods_Feb2022/FeatureServer/0` },
    { id: 'bcc2011', name: 'January 2011, Brisbane River (Brisbane City Council)', url: `${BCC_FS}/Flood_Awareness_Historic_Brisbane_River_Floods_Jan2011/FeatureServer/0` },
    { id: 'bcc1974', name: 'January 1974, Brisbane River (Brisbane City Council)', url: `${BCC_FS}/Flood_Awareness_Historic_Brisbane_River_Floods_Jan1974/FeatureServer/0` },
    { id: 'q1974', name: '1974 flood line, Brisbane and Bremer rivers (Qld)', url: `${QLD_FLOODLINES}/12` },
    { id: 'q2010b', name: '2010 flood line, Bundaberg (Qld)', url: `${QLD_FLOODLINES}/13` },
    { id: 'q2011j', name: 'January 2011 flood lines, Queensland towns', url: `${QLD_FLOODLINES}/14` },
    { id: 'q2011a', name: 'April 2011 flood lines, Queensland towns', url: `${QLD_FLOODLINES}/15` },
    { id: 'q2012', name: '2012 flood lines, south-west Queensland towns', url: `${QLD_FLOODLINES}/16` },
    { id: 'q2013b', name: '2013 flood line, Bundaberg (Qld)', url: `${QLD_FLOODLINES}/17` },
    { id: 'q2017f', name: '2017 flood line, Fitzroy River (Qld)', url: `${QLD_FLOODLINES}/18` },
    { id: 'q2017l', name: '2017 flood line, Logan and Albert rivers (Qld)', url: `${QLD_FLOODLINES}/19` },
    { id: 'q2019w', name: '2019 flood lines, western Queensland', url: `${QLD_FLOODLINES}/20` },
  ];
  // Victoria's flood history (DEECA, CC BY 4.0) holds many events in one
  // layer: features in the model area are grouped into one entry per event.
  const VIC_WFS = 'https://opendata.maps.vic.gov.au/geoserver/wfs';
  const VIC_LAYER = 'open-data-platform:vic_flood_history_public';
  const toRings = (geom) => (!geom ? null : geom.type === 'Polygon' ? geom.coordinates : geom.type === 'MultiPolygon' ? geom.coordinates.flat() : null);
  async function victorianRecorded(g) {
    if (g.south > -33.9 || g.north < -39.3 || g.east < 140.9 || g.west > 150.1) return [];   // outside Victoria
    const p = new URLSearchParams({ service: 'WFS', version: '1.0.0', request: 'GetFeature', typeName: VIC_LAYER, outputFormat: 'application/json', srsName: 'EPSG:4326', maxFeatures: '3000', bbox: `${g.west},${g.south},${g.east},${g.north}` });
    const j = await (await fetch(`${VIC_WFS}?${p}`)).json();
    const feats = (j.features || []).filter((f) => toRings(f.geometry));
    if (!feats.length) return [];
    const keys = Object.keys(feats[0].properties || {});
    const key = keys.find((k) => /event/i.test(k)) || keys.find((k) => /(^|_)name/i.test(k)) || keys.find((k) => /year|date/i.test(k));
    const groups = new Map();
    for (const f of feats) {
      const v = key ? String(f.properties[key] ?? 'unnamed event') : 'recorded floods';
      if (!groups.has(v)) groups.set(v, []);
      groups.get(v).push({ geometry: { rings: toRings(f.geometry) } });
    }
    status.vicRecorded = { key, events: groups.size, features: feats.length };
    return Array.from(groups.entries()).sort((x, y) => y[1].length - x[1].length).slice(0, 12)
      .map(([v, fs], i) => {
        const d = /^\d{4}-\d{2}-\d{2}/.test(v) ? new Date(v) : null;
        const label = d && !Number.isNaN(d.getTime()) ? `flood observed ${d.toLocaleDateString('en-AU', { day: 'numeric', month: 'long', year: 'numeric' })}` : v;
        return { id: `vic${i}`, name: `Victoria: ${label} (Victorian flood history)`, features: fs };
      });
  }

  async function findRecorded() {
    const g = state.geo, area = state.areaKey && areaReg.get(state.areaKey);
    if (!g || !area) return [];
    const box = $('recordedBox');
    box.innerHTML = '<p class="hint">Looking for recorded flood outlines here…</p>';
    const found = [];
    await Promise.all(RECORDED.map(async (rec) => {
      try {
        const p = new URLSearchParams({ where: '1=1', geometry: `${g.west},${g.south},${g.east},${g.north}`, geometryType: 'esriGeometryEnvelope', inSR: '4326', spatialRel: 'esriSpatialRelIntersects', returnCountOnly: 'true', f: 'json' });
        const j = await (await fetch(`${rec.url}/query?${p}`)).json();
        if (j.count > 0) found.push(rec);
      } catch (err) { /* service down: skip */ }
    }));
    found.sort((x, y) => RECORDED.indexOf(x) - RECORDED.indexOf(y));
    try { found.push(...await victorianRecorded(g)); } catch (err) { /* service unavailable */ }
    area.recorded = found;
    status.recorded = found.map((r) => r.id);
    renderRecorded();
    return status.recorded;
  }
  function renderRecorded() {
    const box = $('recordedBox'), area = state.areaKey && areaReg.get(state.areaKey);
    if (!box || !area || !area.recorded) { if (box) box.innerHTML = ''; return; }
    if (!area.recorded.length) { box.innerHTML = '<p class="hint">No recorded flood outlines are published for this area in the sources the app knows (Queensland flood lines, Brisbane City Council and Victoria\'s flood history). New South Wales doesn\'t publish its recorded flood outlines as an open map service.</p>'; return; }
    box.innerHTML = area.recorded.map((r) => `<div class="rec-row"><span>${escapeHtml(r.name)}</span>
      <span class="downloads"><button type="button" class="btn small" data-rec-score="${r.id}">Score this scenario</button>${state.inertial ? '' : '<button type="button" class="btn small" data-rec-fit="${r.id}">Find the matching level</button>'}</span>
      <div class="rec-out" id="recOut-${r.id}">${area.recScores && area.recScores[r.id] ? area.recScores[r.id] : ''}</div></div>`).join('')
      + '<p class="hint">Scored only around the recorded outline (within about 500 m of it), on land, so areas the survey didn\'t cover don\'t count against the model.</p>';
    box.querySelectorAll('[data-rec-score]').forEach((b) => busyClick(b, 'Scoring…', () => scoreRecorded(b.dataset.recScore)));
    box.querySelectorAll('[data-rec-fit]').forEach((b) => busyClick(b, 'Fitting the level…', () => fitRecorded(b.dataset.recFit)));
  }
  async function recordedMask(rec) {
    const area = state.areaKey && areaReg.get(state.areaKey), a = state.a, g = state.geo;
    area.recMasks = area.recMasks || {};
    const key = `${rec.id}:${a.W}`;
    if (area.recMasks[key]) return area.recMasks[key];
    const feats = rec.features || await esriFeatures(rec.url, g, { simplify: (a.cell / 2) * degPerM });
    const px = drawRings(feats, g, a.W, a.H, () => '#000');
    const flood = new Uint8Array(a.N);
    for (let c = 0; c < a.N; c++) flood[c] = px[4 * c + 3] > 127 ? 1 : 0;
    // scoring region: within ~500 m of the recorded flood
    const r = Math.max(1, Math.round(500 / a.cell));
    const near = new Uint8Array(a.N);
    const tmp = new Uint8Array(a.N);
    for (let y = 0; y < a.H; y++) { let last = -1e9; for (let x = 0; x < a.W; x++) { if (flood[y * a.W + x]) last = x; tmp[y * a.W + x] = x - last <= r ? 1 : 0; } last = 1e9; for (let x = a.W - 1; x >= 0; x--) { if (flood[y * a.W + x]) last = x; if (last - x <= r) tmp[y * a.W + x] = 1; } }
    for (let x = 0; x < a.W; x++) { let last = -1e9; for (let y = 0; y < a.H; y++) { if (tmp[y * a.W + x]) last = y; near[y * a.W + x] = y - last <= r ? 1 : 0; } last = 1e9; for (let y = a.H - 1; y >= 0; y--) { if (tmp[y * a.W + x]) last = y; if (last - y <= r) near[y * a.W + x] = 1; } }
    area.recMasks[key] = { flood, near, features: feats.length };
    return area.recMasks[key];
  }
  const scoreText = (s, km2) => `<strong>Agreement ${Math.round(s.csi * 100)}/100.</strong> The scenario floods ${Math.round(s.captured * 100)}% of the recorded flood; ${Math.round(s.extra * 100)}% of what it floods nearby was dry in the record (${(s.fa * km2).toFixed(2)} km²).`;
  async function scoreRecorded(id) {
    const area = state.areaKey && areaReg.get(state.areaKey);
    const rec = RECORDED.find((r) => r.id === id) || (area && (area.recorded || []).find((r) => r.id === id));
    if (!rec || !area || !state.run) return null;
    const out = $(`recOut-${id}`);
    if (out) out.innerHTML = '<p class="hint">Fetching the recorded outline…</p>';
    try {
      const m = await recordedMask(rec);
      const s = F.scoreRun(state.a, state.run, m);
      const html = `<p>${scoreText(s, (state.a.cell * state.a.cell) / 1e6)}</p>${state.inertial ? '<p class="hint">Experimental 2D model: compares the solver\'s final wet extent on its coarse grid.</p>' : ''}`;
      area.recScores = area.recScores || {};
      area.recScores[id] = html;
      if (out) out.innerHTML = html;
      status.recScore = { id, csi: Math.round(s.csi * 100) / 100, captured: Math.round(s.captured * 100) / 100 };
      return status.recScore;
    } catch (err) {
      if (out) out.innerHTML = `<p class="hint">Couldn't fetch the recorded outline: ${escapeHtml(err.message || String(err))}.</p>`;
      status.recScore = { id, error: String(err.message || err) };
      return status.recScore;
    }
  }
  // Calibrate: try river levels at the gauge (in the flood worker when the
  // analysis is resident there — see docs/worker-resident-analysis-design)
  // and keep the one whose flood best matches the recorded outline.
  async function calibrateAsync(a, s0, m, bed) {
    const scan = (tick) => F.calibrateLevels(a, s0, m, bed, (s, lv) => F.inundate(a, Object.assign({}, s, { gaugeLevel: lv }), { slim: 1 }), tick);
    const w = getWorker();
    if (!modelUnavailable && w && a.analysisKey != null && a.keyGen === workerGen) {
      try {
        return await new Promise((resolve, reject) => {
          const id = ++workerSeq;
          workerJobs.set(id, { resolve, reject });
          w.postMessage({ id, kind: 'calibrate', aKey: a.analysisKey, s0: Object.assign({}, s0), m: { near: m.near, flood: m.flood }, bed });
        });
      } catch (err) {
        say(`Calibrating on the main thread instead: ${err.message || err}`);
      }
    }
    return scan(nextFrame);
  }
  async function fitRecorded(id) {
    const area = state.areaKey && areaReg.get(state.areaKey);
    const rec = RECORDED.find((r) => r.id === id) || (area && (area.recorded || []).find((r) => r.id === id));
    const a = state.a;
    if (!rec || !area || !a || state.gauge < 0) return null;
    const out = $(`recOut-${id}`);
    if (out) out.innerHTML = '<p class="hint">Trying river levels against the recorded flood…</p>';
    try {
      const m = await recordedMask(rec);
      const s0 = scenario();
      const bed = a.dem[state.gauge];
      const best = await calibrateAsync(a, s0, m, bed);
      const lvR = Math.round(best.lv * 100) / 100;
      const html = `<p>Best match: river at <strong>${lvR.toFixed(2)} m</strong> at the gauge (${(lvR - bed).toFixed(1)} m above the river surface in the elevation data). ${scoreText(best.s, (a.cell * a.cell) / 1e6)}</p>
        <button type="button" class="btn small" data-use-level="${lvR}">Use this level</button>`;
      area.recScores = area.recScores || {};
      area.recScores[id] = html;
      if (out) {
        out.innerHTML = html;
        out.querySelector('[data-use-level]').addEventListener('click', () => {
          ctl.gaugeLevel.min = Math.min(parseFloat(ctl.gaugeLevel.min), Math.floor(lvR - 1));
          ctl.gaugeLevel.max = Math.max(parseFloat(ctl.gaugeLevel.max), Math.ceil(lvR + 2));
          ctl.gaugeLevel.value = lvR; ctl.extra.value = 0; ctl.floodType.value = ctl.floodType.value === 'flash' ? 'river' : ctl.floodType.value;
          state.base = null; syncOutputs(); runScenario();
        });
      }
      status.recFit = { id, level: lvR, csi: Math.round(best.s.csi * 100) / 100, captured: Math.round(best.s.captured * 100) / 100 };
      return status.recFit;
    } catch (err) {
      if (out) out.innerHTML = `<p class="hint">Couldn't compare: ${escapeHtml(err.message || String(err))}.</p>`;
      status.recFit = { id, error: String(err.message || err) };
      return status.recFit;
    }
  }
  busyClick($('recordedBtn'), 'Searching recorded floods…', () => findRecorded());
  window.__floodFindRecorded = findRecorded;
  window.__floodScoreRecorded = scoreRecorded;
  window.__floodFitRecorded = fitRecorded;

  /* ---------- levees and flood gates */
  // Levees and gates come from OpenStreetMap (and Victoria's coastal levees
  // where served), or are drawn by hand. They are burned into a copy of the
  // model's terrain (the original is kept as area.baseGrid), then the flow
  // analysis is rebuilt.
  let defenceLayer = null, drawing = null, breachFor = null;
  const defs = () => { const a = state.areaKey && areaReg.get(state.areaKey); if (!a) return null; return (a.defences = a.defences || { levees: [], gates: [], allFail: false }); };
  const lineKm = (pts) => { let k = 0; for (let i = 1; i < pts.length; i++) k += kmBetween(pts[i - 1], pts[i]); return k; };
  async function findDefences() {
    const d = defs(), g = state.geo;
    if (!d || !g) return null;
    $('defenceList').innerHTML = '<p class="hint">Looking for levees and flood gates…</p>';
    const bb = `${g.south},${g.west},${g.north},${g.east}`;
    const q = `[out:json][timeout:90];
      (way["man_made"~"^(dyke|levee|flood_wall)$"](${bb});way["barrier"~"^(flood_wall|levee)$"](${bb});way["levee"="yes"](${bb}););out tags geom qt;
      (nwr["waterway"~"^(sluice_gate|flood_gate|floodgate)$"](${bb});nwr["man_made"~"^(flood_gate|floodgate|sluice_gate)$"](${bb});nwr["flood_gate"="yes"](${bb});nwr["floodgate"="yes"](${bb}););out tags center qt;`;
    let found = 0, gates = 0, err = null;
    try {
      const osm = await overpass(q);
      for (const e of osm.elements || []) {
        const t = e.tags || {};
        if (e.type === 'way' && e.geometry && !/gate/.test(`${t.waterway || ''}${t.man_made || ''}`) && !t.flood_gate && !t.floodgate) {
          const id = `osm${e.id}`;
          if (d.levees.some((l) => l.id === id)) continue;
          const h = parseFloat(t.height);
          d.levees.push({ id, src: 'OpenStreetMap', name: t.name || (t.man_made === 'flood_wall' || t.barrier === 'flood_wall' ? 'Flood wall' : 'Levee'), pts: e.geometry.map((p) => [p.lat, p.lon]), height: Number.isFinite(h) ? h : null, failed: false, breaches: [] });
          found++;
        } else {
          const ll = e.center || (e.lat != null ? { lat: e.lat, lon: e.lon } : null);
          const id = `osm${e.type[0]}${e.id}`;
          if (!ll || d.gates.some((x) => x.id === id)) continue;
          d.gates.push({ id, name: t.name || 'Flood gate', lat: ll.lat, lon: ll.lon, failed: false });
          gates++;
        }
      }
    } catch (e2) { err = String(e2.message || e2); }
    // published levee lines collected by the build (NSW levee audit,
    // Victoria's coastal levees)
    try {
      if (!nat.levees) { const r = await fetch('data/levees.geojson', { cache: 'no-cache' }); nat.levees = r.ok ? (await r.json()).features || [] : []; }
      nat.levees.forEach((f, i) => {
        const pts = f.geometry.coordinates;
        if (!pts.some(([x, y]) => x >= g.west && x <= g.east && y >= g.south && y <= g.north)) return;
        const id = `pub${i}`;
        if (d.levees.some((l) => l.id === id)) return;
        const p = f.properties || {};
        d.levees.push({ id, src: p.source || 'published', name: p.name ? `${p.name} levee` : 'Levee', pts: pts.map(([x, y]) => [y, x]), height: null, failed: false, breaches: [] });
        found++;
      });
    } catch (e4) { /* no levee file */ }
    status.defences = { levees: d.levees.length, gates: d.gates.length, found, gatesFound: gates, error: err };
    await applyDefences();
    return status.defences;
  }
  function gridXY(lat, lon) { const g = state.geo, a = state.grid; return [((lon - g.west) / (g.east - g.west)) * a.W, ((g.north - lat) / (g.north - g.south)) * a.H]; }
  async function applyDefences() {
    const area = state.areaKey && areaReg.get(state.areaKey), d = defs();
    if (!area || !d || !state.grid || !state.geo) return;
    if (!area.baseGrid) area.baseGrid = state.grid;
    const base = area.baseGrid, lidar = state.areaMeta && state.areaMeta.lidarShare >= 0.2;
    const mask = new Uint8Array(base.W * base.H);
    const levees = d.levees.map((l) => {
      const cells = F.lineCells(l.pts.map(([la, lo]) => gridXY(la, lo)), base.W, base.H);
      cells.forEach((c) => { mask[c] = 1; });
      const breaches = (l.breaches || []).map(([la, lo]) => { const [x, y] = gridXY(la, lo); return Math.round(y) * base.W + Math.round(x); });
      // crest: the height set, else from LiDAR terrain, else assume 1.5 m
      const height = l.height != null ? l.height : lidar ? null : 1.5;
      return { cells, height, failed: l.failed || d.allFail, breaches };
    });
    state.leveeMask = levees.length ? mask : null;
    state.grid = levees.length ? F.burnDefences(base, { levees }) : base;
    setBusy(true, 'Rebuilding the model with its levees…');
    await reanalyse(false);
    setBusy(false);
    snapGates();
    state.base = null;
    runScenario();
    renderDefences();
    saveSessionSoon();
  }
  function snapGates() {
    const d = defs();
    state.gateCells = (d ? d.gates : []).filter((gt) => !gt.failed).map((gt) => {
      const c = latLngCell({ lat: gt.lat, lng: gt.lon });
      return c && state.a ? F.snapToStream(state.a, c.x, c.y, 3) : -1;
    }).filter((c) => c >= 0);
  }
  function renderDefences() {
    const d = defs(), box = $('defenceList');
    if (!box) return;
    if (!d) { box.innerHTML = ''; return; }
    $('allLeveesFail').checked = !!d.allFail;
    const lidar = state.areaMeta && state.areaMeta.lidarShare >= 0.2;
    box.innerHTML = d.levees.map((l, i) => `<div class="def-row"><span><strong>${escapeHtml(l.name)}</strong> <small>${escapeHtml(l.src)} · ${lineKm(l.pts).toFixed(2)} km${l.breaches.length ? ` · ${l.breaches.length} breach${l.breaches.length > 1 ? 'es' : ''}` : ''}</small></span>
        ${l.src === 'drawn' ? `<button type="button" class="icon-btn" data-lev-drop="${i}" aria-label="Remove this levee" title="Remove">×</button>` : '<span></span>'}
        <span class="def-ctl"><label>Crest <input type="number" step="0.1" min="0" data-lev-h="${i}" value="${l.height != null ? l.height : ''}" placeholder="${lidar ? 'terrain' : '1.5'}" aria-label="Crest height above ground in metres"> m above ground</label>
        <label class="check"><input type="checkbox" data-lev-fail="${i}"${l.failed ? ' checked' : ''}> Fails</label>
        <button type="button" class="btn small" data-lev-breach="${i}" aria-pressed="${breachFor === i}">${breachFor === i ? 'Tap the levee…' : 'Breach here'}</button>
        ${l.breaches.length ? `<button type="button" class="link-btn" data-lev-unbreach="${i}">clear breaches</button>` : ''}</span></div>`).join('')
      + d.gates.map((gt, i) => `<div class="def-row"><span><strong>${escapeHtml(gt.name)}</strong> <small>flood gate · OpenStreetMap</small></span><span></span>
        <span class="def-ctl"><label class="check"><input type="checkbox" data-gate-fail="${i}"${gt.failed ? ' checked' : ''}> Fails or left open</label></span></div>`).join('')
      + (d.levees.length || d.gates.length ? '' : '<p class="hint">No levees or flood gates added for this model yet.</p>');
    box.querySelectorAll('[data-lev-h]').forEach((el) => el.addEventListener('change', () => { const v = parseFloat(el.value); d.levees[+el.dataset.levH].height = Number.isFinite(v) ? v : null; applyDefences(); }));
    box.querySelectorAll('[data-lev-fail]').forEach((el) => el.addEventListener('change', () => { d.levees[+el.dataset.levFail].failed = el.checked; applyDefences(); }));
    box.querySelectorAll('[data-gate-fail]').forEach((el) => el.addEventListener('change', () => { d.gates[+el.dataset.gateFail].failed = el.checked; snapGates(); runScenario(); renderDefences(); saveSessionSoon(); }));
    box.querySelectorAll('[data-lev-breach]').forEach((el) => el.addEventListener('click', () => { breachFor = breachFor === +el.dataset.levBreach ? null : +el.dataset.levBreach; renderDefences(); }));
    box.querySelectorAll('[data-lev-unbreach]').forEach((el) => el.addEventListener('click', () => { d.levees[+el.dataset.levUnbreach].breaches = []; applyDefences(); }));
    box.querySelectorAll('[data-lev-drop]').forEach((el) => el.addEventListener('click', () => { d.levees.splice(+el.dataset.levDrop, 1); applyDefences(); }));
    status.defences = Object.assign(status.defences || {}, { levees: d.levees.length, gates: d.gates.length, failed: d.levees.filter((l) => l.failed).length + (d.allFail ? d.levees.length : 0), gateCells: (state.gateCells || []).length });
    drawDefenceLayer();
  }
  function drawDefenceLayer() {
    const d = defs(), L = window.L;
    if (!state.lmap || !L) return;
    if (!defenceLayer) defenceLayer = L.layerGroup().addTo(state.lmap);
    defenceLayer.clearLayers();
    if (!d) return;
    d.levees.forEach((l) => {
      const down = l.failed || d.allFail;
      L.polyline(l.pts, { color: down ? '#c62828' : '#5d4037', weight: 4, opacity: 0.9, dashArray: down ? '6 6' : null, interactive: false }).addTo(defenceLayer);
      l.breaches.forEach((b) => L.circleMarker(b, { radius: 6, color: '#c62828', weight: 3, fill: false, interactive: false }).addTo(defenceLayer));
    });
    d.gates.forEach((gt) => L.marker([gt.lat, gt.lon], { interactive: false, icon: L.divIcon({ className: '', html: `<span style="display:block;width:12px;height:12px;border:2px solid #fff;background:${gt.failed ? '#c62828' : '#2e7d32'};box-shadow:0 0 0 1px rgba(0,0,0,.4)"></span>`, iconSize: [12, 12], iconAnchor: [6, 6] }) }).addTo(defenceLayer));
    if (drawing && drawing.pts.length) L.polyline(drawing.pts, { color: '#5d4037', weight: 3, dashArray: '2 6', interactive: false }).addTo(defenceLayer);
  }
  // map taps while drawing a levee or placing a breach
  function defenceTap(latlng) {
    const d = defs();
    if (drawing) { drawing.pts.push([latlng.lat, latlng.lng]); $('drawLevee').textContent = `Finish levee (${drawing.pts.length} points)`; drawDefenceLayer(); return true; }
    if (breachFor != null && d && d.levees[breachFor]) {
      d.levees[breachFor].breaches.push([latlng.lat, latlng.lng]);
      breachFor = null;
      applyDefences();
      say('Breach added: the levee is lowered to the ground for about 60 m there.');
      return true;
    }
    return false;
  }
  function finishDrawing() {
    const d = defs();
    if (drawing && d && drawing.pts.length >= 2) {
      d.levees.push({ id: `drawn${Date.now()}`, src: 'drawn', name: 'Your levee', pts: drawing.pts, height: 1.5, failed: false, breaches: [] });
      drawing = null;
      $('drawLevee').setAttribute('aria-pressed', 'false');
      $('drawLevee').textContent = 'Draw a levee';
      applyDefences();
      return true;
    }
    drawing = null;
    $('drawLevee').setAttribute('aria-pressed', 'false');
    $('drawLevee').textContent = 'Draw a levee';
    drawDefenceLayer();
    return false;
  }
  busyClick($('findDefences'), 'Searching for levees and gates…', () => findDefences());
  $('drawLevee').addEventListener('click', () => {
    if (drawing) { finishDrawing(); return; }
    drawing = { pts: [] };
    $('drawLevee').setAttribute('aria-pressed', 'true');
    $('drawLevee').textContent = 'Tap along the levee, then here to finish';
    say('Tap points along the levee on the map, then press Finish levee.');
  });
  $('allLeveesFail').addEventListener('change', (e) => { const d = defs(); if (d) { d.allFail = e.target.checked; applyDefences(); } });
  window.__floodFindDefences = findDefences;
  window.__floodDrawLevee = (pts, h) => { const d = defs(); if (!d) return null; d.levees.push({ id: `drawn${Date.now()}`, src: 'drawn', name: 'Your levee', pts, height: h, failed: false, breaches: [] }); return applyDefences().then(() => status.defences); };
  window.__floodLeveesFail = (on) => { const d = defs(); if (!d) return null; d.allFail = on; return applyDefences().then(() => status.defences); };

  /* ---------- flood over time: when places flood, roads close, places are cut off */
  async function timelineAsync(a, s, opts) {
    const onMainThread = () => {
      if (F.engine !== 'rust') return Promise.reject(new Error('The flood model (WebAssembly) is unavailable in this browser.'));
      return nextFrame().then(() => F.floodTimeline(a, s, opts));
    };
    const w = getWorker();
    if (!w) return onMainThread();
    // when the analysis is resident in the worker (key + same generation),
    // send the key instead of cloning the whole grid into the message
    if (a.analysisKey != null && a.keyGen === workerGen) {
      try {
        return await new Promise((resolve, reject) => {
          const id = ++workerSeq;
          workerJobs.set(id, { resolve, reject, fallback: onMainThread });
          w.postMessage({ id, kind: 'timeline', aKey: a.analysisKey, s, opts });
        });
      } catch (err) {
        // a worker that lost the resident analysis asks for the full object
        if (!String(err && err.message).startsWith('__rekey__')) throw err;
      }
    }
    return new Promise((resolve, reject) => {
      const id = ++workerSeq;
      workerJobs.set(id, { resolve, reject, fallback: onMainThread });
      w.postMessage({ id, kind: 'timeline', a, s, opts });
    });
  }
  const hoursLabel = (h) => (h < 0 ? `${h} h` : `+${h} h`);
  // recorded floods at a gauge near this model's gauge
  function eventsHere() {
    if (!nat.events) ensureHistory();
    if (!nat.events || !state.a || state.gauge < 0 || !state.geo) return [];
    const [la, lo] = cellLatLng(state.gauge);
    return nat.events.filter((e) => e.gauge && kmBetween([e.gauge.lat, e.gauge.lon], [la, lo]) < 12);
  }
  function renderShapeChoices() {
    const sel = $('floodShape');
    if (!sel) return;
    const evs = eventsHere(), cur = sel.value;
    const key = evs.map((e) => e.id).join();
    if (sel.dataset.key !== key) {
      sel.innerHTML = '<option value="">Smooth rise and fall</option>' + evs.map((e) => `<option value="${e.id}">Recorded: ${escapeHtml(e.name)}</option>`).join('');
      sel.dataset.key = key;
      if (evs.some((e) => e.id === cur)) sel.value = cur;
    }
    const ev = evs.find((e) => e.id === sel.value);
    $('shapeRow').hidden = !!ev;
    // recorded floods with a nearby tide gauge use its real sea levels
    const rec = document.querySelector('#tideCycle option[value="recorded"]'), tc = $('tideCycle');
    if (rec && tc) {
      const has = !!(ev && ev.sea);
      rec.hidden = !has;
      if (has && tc.dataset.event !== ev.id) tc.value = 'recorded';
      if (!has && tc.value === 'recorded') tc.value = 'high';
      tc.dataset.event = ev ? ev.id : '';
      $('tideAmp').disabled = tc.value === 'recorded';
    }
    $('shapeNote').innerHTML = ev
      ? `${escapeHtml(ev.gauge.name)} gauge, peak ${ev.peak.level.toFixed(2)} m on its board at ${escapeHtml(fmtWhen(ev, ev.peak.hours))}. The recorded rise and fall is used with its peak lined up to this scenario's peak; to match the real flood's height, use <em>Check against recorded floods</em>, <em>Find the matching level</em> first.`
      : (nat.events && nat.events.length ? (evs.length ? '' : 'No recorded flood readings near this model\'s gauge yet.') : '');
  }
  function fmtWhen(ev, hours) {
    const d = new Date(new Date(ev.start).getTime() + hours * 3600e3);
    return d.toLocaleString('en-AU', { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric', hour: 'numeric', hour12: true });
  }
  function timeOpts() {
    const a = state.a, ev = eventsHere().find((e) => e.id === $('floodShape').value);
    return {
      baseLevel: a.dem[state.gauge] + 0.3,
      riseHours: Math.max(1, parseFloat($('riseH').value) || 24),
      fallHours: Math.max(1, parseFloat($('fallH').value) || 48),
      speedKmh: Math.max(0.5, parseFloat($('waveKmh').value) || 3),
      flatten: parseFloat($('flatten').value) || 0,
      route: $('flatten').value === 'route',
      tide: hasSea() && $('tideCycle').value && $('tideCycle').value !== 'recorded' ? { amp: Math.max(0, parseFloat($('tideAmp').value) || 0), atPeak: $('tideCycle').value } : null,
      sea: hasSea() && $('tideCycle').value === 'recorded' && ev && ev.sea ? ev.sea.series : null,
      hydro: ev ? ev.series : null,
      others: ev && ev.others ? otherGaugeCells(ev) : null,
      rating: gaugeRating(),
      release: releaseOpts(),
      eventId: ev ? ev.id : null,
    };
  }
  $('floodShape').addEventListener('change', renderShapeChoices);
  $('tideCycle').addEventListener('change', () => { $('tideAmp').disabled = $('tideCycle').value === 'recorded'; });
  // A dam release: as a share of the flood's peak flow, or in m³/s where the
  // gauge's rating gives the peak flow to compare with
  function peakFlowNow() {
    const rt = gaugeRating(), a = state.a;
    if (!rt || !a || state.gauge < 0) return null;
    const board = rt.hmed + (parseFloat(ctl.gaugeLevel.value) - (a.dem[state.gauge] + 0.3));
    return rt.a * Math.pow(Math.max(0, board - rt.h0), rt.b);
  }
  function releaseOpts() {
    const v = parseFloat($('relFlow').value) || 0;
    if (v <= 0) return null;
    let frac = v / 100;
    if ($('relUnit').value === 'm3s') { const q = peakFlowNow(); if (!q) return null; frac = v / q; }
    return { startHours: parseFloat($('relStart').value) || 0, hours: Math.max(1, parseFloat($('relHours').value) || 24), frac };
  }
  function buildRainSeries(seconds) {
    const raw = ($('inertialRainSeries').value || '').trim();
    if (!raw) return undefined;
    const vals = raw.split(/[,\s]+/).map((x) => parseFloat(x)).filter((x) => Number.isFinite(x));
    if (!vals.length) return undefined;
    const nH = Math.max(1, Math.ceil(seconds / 3600));
    const series = new Float64Array(nH);
    for (let h = 0; h < nH; h++) series[h] = Math.max(0, Math.min(1000, vals[Math.min(h, vals.length - 1)]));
    return series;
  }
  // Per-hour release series for the 2D solver (m³/s at the gauge cell).
  function buildInflowSeries(seconds) {
    const v = parseFloat($('relFlow').value) || 0;
    if (v <= 0) return undefined;
    let m3s = v;
    if ($('relUnit').value === 'pct') {
      const q = peakFlowNow();
      if (!q) return undefined;
      m3s = (v / 100) * q;
    }
    const startH = Math.max(0, parseFloat($('relStart').value) || 0);
    const durH = Math.max(1, parseFloat($('relHours').value) || 24);
    const nH = Math.max(1, Math.ceil(seconds / 3600));
    const series = new Float64Array(nH);
    for (let h = 0; h < nH; h++) if (h >= startH && h < startH + durH) series[h] = m3s;
    return series;
  }
  function renderReleaseNote() {
    const note = $('relNote');
    if (!note || !state.a || state.gauge < 0) return;
    const [la, lo] = cellLatLng(state.gauge), q = peakFlowNow();
    const dams = nat.data ? nat.data.storages.map((f) => ({ f, km: kmBetween([f.geometry.coordinates[1], f.geometry.coordinates[0]], [la, lo]) }))
      .filter((x) => x.km < 150).sort((x, y) => x.km - y.km).slice(0, 4) : [];
    note.innerHTML = (q ? `The flood's peak flow at this gauge is about ${q >= 100 ? Math.round(q / 10) * 10 : Math.round(q)} m³/s (from its rating). ` : 'This gauge has no measured rating, so give the release as a share of the peak flow. ')
      + (dams.length ? `Dams within 150 km: ${dams.map((x) => { const fl = storageFill(x.f.properties); return `${escapeHtml(x.f.properties.name)} (${Math.round(x.km)} km${fl != null ? `, ${Math.round(fl * 100)}% full` : ''})`; }).join('; ')}. A release takes hours to days to reach the gauge; set when it arrives.` : 'No Bureau-listed dams within 150 km.');
    if ($('relUnit').value === 'm3s' && !q) $('relUnit').value = 'pct';
  }
  $('releaseBox').addEventListener('toggle', renderReleaseNote);
  $('relUnit').addEventListener('change', renderReleaseNote);

  // the measured level-to-flow rating of the Bureau gauge at the model's
  // gauge (within 2 km), from the build's fit to Water Data Online records
  function gaugeRating() {
    if (!nat.ratings || !nat.data || state.gauge < 0) return null;
    const [la, lo] = cellLatLng(state.gauge);
    let best = null;
    for (const f of nat.data.gauges) {
      const r = nat.ratings[f.properties.station];
      if (!r) continue;
      const [x, y] = f.geometry.coordinates, km = kmBetween([y, x], [la, lo]);
      if (km < 2 && (!best || km < best.km)) best = { km, ...r, depth: r.hmed - r.h0 };
    }
    return best;
  }
  window.__floodRatingHere = async () => {
    await ensureHistory();
    const r = gaugeRating(), evs = eventsHere();
    return { rating: r && { name: r.name, b: r.b, depth: +r.depth.toFixed(2), km: +r.km.toFixed(2) }, ratings: nat.ratings ? Object.keys(nat.ratings).length : null,
      events: evs.map((e) => ({ id: e.id, others: (e.others || []).length, inModel: otherGaugeCells(e).length })) };
  };
  // other gauges with readings for the same flood, snapped to the river
  // (the biggest channel within about 1 km, as for the main gauge)
  function otherGaugeCells(ev) {
    const a = state.a, out = [];
    for (const o of ev.others || []) {
      const c = cellOf(o.lat, o.lon);
      if (c < 0 || !o.series) continue;
      const col = c % a.W, row = Math.floor(c / a.W), R = Math.max(3, Math.round(1000 / a.cell));
      let big = 0;
      for (let dy = -R; dy <= R; dy++) for (let dx = -R; dx <= R; dx++) {
        const x = col + dx, y = row + dy;
        if (x < 0 || y < 0 || x >= a.W || y >= a.H) continue;
        const i = y * a.W + x;
        if (a.stream[i] && a.acc[i] > big) big = a.acc[i];
      }
      const cell = F.snapToStream(a, col, row, R, big * 0.3);
      if (cell >= 0) out.push({ cell, hydro: o.series, name: o.name });
    }
    return out;
  }
  // tides: only for models that reach the sea; the rise above mean sea level
  // defaults to the nearest Queensland port's high spring tide
  function hasSea() {
    const a = state.a;
    if (!a || !a.ocean) return false;
    // the river below the gauge has to reach real sea (several metres of
    // it, not a blank edge of the elevation tile)
    const g = state.gauge >= 0 ? state.gauge : a.mainOutlet;
    if (a.hasSeaFrom !== g) {
      a.hasSeaFrom = g; a.hasSea = false;
      let n = 0;
      for (let c = g; c >= 0 && n < 50; c = a.rec[c]) if (a.ocean[c] && a.dem[c] < -0.5) n++;
      a.hasSea = n >= 3;
    }
    return a.hasSea;
  }
  window.__floodSeaInfo = () => {
    const a = state.a;
    if (!a) return null;
    let oc = 0, po = 0, pmin = Infinity, last = -1;
    for (let c = 0; c < a.N; c++) if (a.ocean[c]) oc++;
    for (let c = state.gauge >= 0 ? state.gauge : a.mainOutlet; c >= 0; c = a.rec[c]) { last = c; if (a.ocean[c]) { po++; pmin = Math.min(pmin, a.dem[c]); } }
    return { hasSea: hasSea(), oceanCells: oc, cells: a.N, pathOcean: po, pathMin: Number.isFinite(pmin) ? +pmin.toFixed(2) : null, outletDem: last >= 0 ? +a.dem[last].toFixed(2) : null };
  };
  function renderTideRow() {
    const row = $('tideRow');
    if (!row) return;
    row.hidden = !hasSea();
    const p = tidePort(), key = state.areaKey || '';
    if (!row.hidden && row.dataset.key !== `${key}:${tideGrid ? 1 : 0}`) {
      row.dataset.key = `${key}:${tideGrid ? 1 : 0}`;
      $('tideAmp').value = p ? Math.max(0.1, p.mhws).toFixed(1) : '0.8';
      $('tideAmp').title = p ? `High spring tide at ${p.name}: ${p.mhws.toFixed(2)} m above mean sea level (${tideSource(p)})` : 'Typical spring tide; set it for this coast';
    }
  }
  async function runTimeline(eventId) {
    const key = state.areaKey, area = key && areaReg.get(key), a = state.a;
    if (!area || !a || state.gauge < 0) return null;
    const seq = ++timelineSeq;
    const current = () => timelineSeq === seq && state.areaKey === key && state.a === a && areaReg.get(key) === area;
    await ensureHistory();
    if (!current()) return null;
    if (eventId !== undefined) { renderShapeChoices(); $('floodShape').value = eventId || ''; renderShapeChoices(); }
    const box = $('timelineBox');
    box.innerHTML = '<p class="hint">Working out the flood hour by hour…</p>';
    renderTideRow();
    const s = scenario(), opts = timeOpts();
    if (!opts.hydro && s.gaugeLevel <= opts.baseLevel + 0.1) { box.innerHTML = '<p class="hint">Set a peak above the river\'s normal level first.</p>'; return null; }
    if (area.impact == null) await countImpact();   // roads and buildings for closures
    if (!current()) return null;
    let tl;
    try { tl = await timelineAsync(a, Object.assign({}, s, { controls: s.controls }), opts); } catch (err) {
      if (!current()) return null;
      box.innerHTML = `<p class="hint">Couldn't run the flood over time: ${escapeHtml(err.message || String(err))}.</p>`;
      return null;
    }
    if (!current()) return null;
    // decompress per-step depth frames (transferred deflated) once, here
    if (tl && tl.depthFramesCompressed && tl.depthFrames && typeof DecompressionStream !== 'undefined') {
      try {
        const ds = new DecompressionStream('deflate');
        const w = ds.writable.getWriter();
        w.write(tl.depthFrames); w.close();
        const r = ds.readable.getReader();
        const chunks = []; let total = 0;
        while (true) { const { done, value } = await r.read(); if (done) break; chunks.push(value); total += value.length; }
        const out = new Uint8Array(total);
        let off = 0;
        for (const c of chunks) { out.set(c, off); off += c.length; }
        tl.depthFrames = out;
        tl.depthFramesCompressed = false;
      } catch (e) { /* keep compressed; showTimeStep falls back to the live path */ }
    }
    tl.opts = opts; tl.s = s;
    tl.event = opts.eventId ? nat.events.find((e) => e.id === opts.eventId) : null;
    if (tl.event) tl.boardShift = s.gaugeLevel - tl.event.peak.level;
    tl.wave = F.waveSetup(a, s, opts);
    tl.access = timelineAccess(tl, area.impact);
    area.timeline = tl;
    state.timeStep = tl.gauge.indexOf(Math.max(...tl.gauge));
    renderTimeline();
    showTimeStep(state.timeStep);
    const ac = tl.access;
    const R = tl.wave.routed;
    status.timeline = { steps: tl.steps, step: tl.step, event: opts.eventId,
      routed: R ? { reaches: R.reaches.length, km: +(R.reaches[R.reaches.length - 1] || { km: 0 }).km.toFixed(1), peakFrac: +R.peakAt(R.flows.length - 1).frac.toFixed(2), lagHours: Math.round(R.peakAt(R.flows.length - 1).hours - R.peakAt(0).hours), tributaries: R.tributaries } : null,
      release: tl.wave.release ? +tl.wave.release.rise.toFixed(2) : null, tide: tl.wave.tide || 0, seaRecorded: !!tl.wave.seaRecorded, rated: !!(R && R.rated), upGauges: tl.wave.up ? tl.wave.up.gauges : 0, firstRoad: ac ? ac.firstClose : null, maxIsolated: ac ? ac.maxIso : null, longestHours: ac ? ac.longest : null, roadsClosed: ac ? new Set(ac.roads.map((r) => r.name)).size : null };
    return status.timeline;
  }
  // Roads and isolation through time, from when each spot is over 0.3 m deep
  function timelineAccess(tl, d) {
    if (!d || d.error || !d.net || !d.net.lat.length) return null;
    const a = state.a, net = d.net, nN = net.lat.length, K = tl.steps, g = state.geo;
    const at = (bits, c, k) => c >= 0 && !!(bits[k * tl.wordsPerStep + (c >>> 5)] & (1 << (c & 31)));
    const deepAt = (c, k) => at(tl.deepBits, c, k);
    const wetAt = (c, k) => at(tl.wetBits, c, k);
    const nodeCell = new Int32Array(nN);
    for (let n = 0; n < nN; n++) nodeCell[n] = cellOf(net.lat[n], net.lon[n]);
    // Keep the sampled cells, then test each edge at the current step.
    // A road can reopen between successive river or tidal peaks.
    const edgeCells = net.edges.map(([u, v]) => {
      const cells = new Set();
      for (let t = 0; t <= 4; t++) {
        const f = t / 4;
        const c = cellOf(net.lat[u] + (net.lat[v] - net.lat[u]) * f, net.lon[u] + (net.lon[v] - net.lon[u]) * f);
        if (c >= 0) cells.add(c);
      }
      return Array.from(cells);
    });
    const edgeClosed = new Uint8Array(net.edges.length), roads = new Map();
    // exits: dry road nodes at the edge of the model area
    const mx = ((g.east - g.west) / a.W) * 3, my = ((g.north - g.south) / a.H) * 3;
    const exit = new Uint8Array(nN);
    for (let n = 0; n < nN; n++) exit[n] = net.lat[n] < g.south + my || net.lat[n] > g.north - my || net.lon[n] < g.west + mx || net.lon[n] > g.east - mx ? 1 : 0;
    const adj = Array.from({ length: nN }, () => []);
    net.edges.forEach(([u, v], k) => { adj[u].push([v, k]); adj[v].push([u, k]); });
    // nearest road node per building (grid hash ~ 200 m)
    const hs = 0.002, hash = new Map();
    for (let n = 0; n < nN; n++) { const key = `${Math.floor(net.lat[n] / hs)},${Math.floor(net.lon[n] / hs)}`; (hash.get(key) || hash.set(key, []).get(key)).push(n); }
    const nB = d.bx.length, bNode = new Int32Array(nB).fill(-1), bCell = new Int32Array(nB);
    for (let i = 0; i < nB; i++) {
      bCell[i] = cellOf(d.by[i], d.bx[i]);
      const ky = Math.floor(d.by[i] / hs), kx = Math.floor(d.bx[i] / hs);
      let bd = Infinity;
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) for (const n of hash.get(`${ky + dy},${kx + dx}`) || []) {
        const dd = (net.lat[n] - d.by[i]) ** 2 + ((net.lon[n] - d.bx[i]) * 0.9) ** 2;
        if (dd < bd) { bd = dd; bNode[i] = n; }
      }
    }
    // places whose roads never reach the edge, even when dry, don't count
    const dryReach = new Uint8Array(nN), q0 = [];
    for (let n = 0; n < nN; n++) if (exit[n]) { dryReach[n] = 1; q0.push(n); }
    for (let h = 0; h < q0.length; h++) for (const [m] of adj[q0[h]]) if (!dryReach[m]) { dryReach[m] = 1; q0.push(m); }
    const isoSteps = new Int16Array(nB), firstIso = new Int16Array(nB).fill(-1);
    const isoRun = new Int16Array(nB);
    let longest = 0;
    const isoCount = new Int32Array(K), floodCount = new Int32Array(K), closedCount = new Int32Array(K);
    const reach = new Uint8Array(nN), q = new Int32Array(nN);
    for (let k = 0; k < K; k++) {
      reach.fill(0);
      const closedNames = new Set();
      let closed = 0;
      for (let e = 0; e < net.edges.length; e++) {
        edgeClosed[e] = edgeCells[e].some((c) => deepAt(c, k)) ? 1 : 0;
        if (!edgeClosed[e]) continue;
        closed++;
        const name = d.roads[net.edges[e][2]].name;
        if (name) closedNames.add(name);
      }
      closedCount[k] = closed;
      for (const name of closedNames) {
        const intervals = roads.get(name) || [];
        const last = intervals[intervals.length - 1];
        if (last && last.to === k - 1) last.to = k;
        else intervals.push({ name, from: k, to: k });
        roads.set(name, intervals);
      }
      let qt = 0;
      for (let n = 0; n < nN; n++) if (exit[n] && !deepAt(nodeCell[n], k)) { reach[n] = 1; q[qt++] = n; }
      for (let h = 0; h < qt; h++) for (const [m, e] of adj[q[h]]) {
        if (reach[m] || edgeClosed[e] || deepAt(nodeCell[m], k)) continue;
        reach[m] = 1; q[qt++] = m;
      }
      for (let i = 0; i < nB; i++) {
        if (wetAt(bCell[i], k)) { floodCount[k]++; isoRun[i] = 0; continue; }
        if (bNode[i] >= 0 && !reach[bNode[i]] && dryReach[bNode[i]]) {
          isoCount[k]++; isoSteps[i]++; isoRun[i]++;
          longest = Math.max(longest, isoRun[i]);
          if (firstIso[i] < 0) firstIso[i] = k;
        } else isoRun[i] = 0;
      }
    }
    const toH = (k) => Math.round(tl.t0 + k * tl.step);
    let maxIso = 0, maxIsoAt = 0;
    for (let k = 0; k < K; k++) if (isoCount[k] > maxIso) { maxIso = isoCount[k]; maxIsoAt = k; }
    const roadList = Array.from(roads.values()).flat().sort((x, y) => x.from - y.from);
    return {
      roads: roadList.map((r) => ({ name: r.name, closes: toH(r.from), reopens: toH(r.to + 1) })),
      firstClose: roadList.length ? toH(roadList[0].from) : null,
      maxIso, maxIsoAt: toH(maxIsoAt), longest: Math.round(longest * tl.step),
      isoCount, floodCount, closedCount, isoSteps, firstIso,
    };
  }
  // what routing did to the peak on its way down the river
  function routeNote(tl) {
    const R = tl.wave && tl.wave.routed, parts = [];
    if (R && R.flows.length > 1) {
      const end = R.peakAt(R.flows.length - 1), top = R.peakAt(0), km = R.reaches[R.reaches.length - 1].km;
      parts.push(`Routed ${km.toFixed(1)} km down the river to the model's edge: the peak gets there about ${Math.max(0, Math.round(end.hours - top.hours))} hours after the gauge, at ${Math.round(Math.min(1, end.frac) * 100)}% of the flow it would have if everything peaked together${R.tributaries ? `, with ${R.tributaries} tributar${R.tributaries === 1 ? 'y' : 'ies'} joining on the way` : ''}.`);
    }
    const rt = tl.opts && tl.opts.rating;
    if (R && R.rated && rt) {
      const board = tl.event ? tl.event.peak.level : rt.hmed + (tl.s.gaugeLevel - tl.opts.baseLevel);
      const q = rt.a * Math.pow(Math.max(0, board - rt.h0), rt.b);
      parts.push(`Flows from ${escapeHtml(rt.name || 'the gauge')}'s measured rating (Water Data Online daily records${board > rt.hmax ? ', extended above the highest daily level recorded' : ''}): about ${q >= 100 ? Math.round(q / 10) * 10 : Math.round(q)} m³/s at the peak.`);
    }
    if (tl.wave && tl.wave.release) parts.push(`Dam release: ${Math.round(tl.wave.release.frac * 100)}% of the peak flow from hour ${tl.opts.release.startHours} for ${tl.opts.release.hours} h, raising the gauge's highest level by ${fmt(Math.max(0, tl.wave.release.rise), 2)} m (to ${fmt(tl.wave.release.peakWith, 2)} m).`);
    if (tl.wave && tl.wave.up) parts.push(`Along the river the flood follows the recorded readings at ${tl.wave.up.gauges} more gauge${tl.wave.up.gauges === 1 ? '' : 's'}${tl.wave.up.below ? `, ${tl.wave.up.below} below this one` : ''}: ${escapeHtml(tl.wave.up.names.join(', '))}, blending between gauges along the way.`);
    if (tl.wave && tl.wave.seaRecorded && tl.event && tl.event.sea) parts.push(`Sea: the recorded level at the ${escapeHtml(tl.event.sea.station)} tide gauge (${Math.round(tl.event.sea.km)} km away; University of Hawaii Sea Level Center), tides and surge included, between ${tl.wave.seaRecorded.lo.toFixed(2)} and ${tl.wave.seaRecorded.hi.toFixed(2)} m above mean sea level.`);
    else if (tl.wave && tl.wave.tide) parts.push(`Tide: ${tl.opts.tide.atPeak === 'low' ? 'low' : 'high'} water at the peak, sea between ${(tl.s.bayLevel - 2 * tl.wave.tide).toFixed(2)} m and ${tl.s.bayLevel.toFixed(2)} m.`);
    return parts.length ? `<p class="hint">${parts.join(' ')}</p>` : '';
  }
  function renderTimeline() {
    const area = state.areaKey && areaReg.get(state.areaKey), box = $('timelineBox');
    if (!box) return;
    const tl = area && area.timeline;
    if (!tl) { box.innerHTML = ''; return; }
    const ac = tl.access, K = tl.steps;
    // small chart: gauge level, and buildings flooded / cut off
    const W = 300, H = 90, gmin = Math.min(...tl.gauge), gmax = Math.max(...tl.gauge);
    const x = (k) => (k / (K - 1)) * W;
    const gy = (v) => H - 8 - ((v - gmin) / Math.max(0.01, gmax - gmin)) * (H - 20);
    const line = Array.from(tl.gauge).map((v, k) => `${x(k).toFixed(1)},${gy(v).toFixed(1)}`).join(' ');
    let bars = '';
    if (ac) {
      const m = Math.max(1, ...ac.floodCount, ...ac.isoCount);
      for (let k = 0; k < K; k++) {
        const fh = (ac.floodCount[k] / m) * (H - 20), ih = (ac.isoCount[k] / m) * (H - 20);
        bars += `<rect x="${x(k) - 1}" y="${H - 8 - fh}" width="2" height="${fh}" fill="var(--accent)" opacity=".55"/>`;
        if (ih) bars += `<rect x="${x(k) - 1}" y="${H - 8 - fh - ih}" width="2" height="${ih}" fill="#ef6c00" opacity=".85"/>`;
      }
    }
    const n = (v) => Math.round(v).toLocaleString('en-AU');
    const whenH = (h) => (tl.event ? fmtWhen(tl.event, h) : hoursLabel(h));
    box.innerHTML = `<svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" role="img" aria-label="Gauge level and buildings affected over time">${bars}<polyline points="${line}" fill="none" stroke="var(--ink)" stroke-width="1.5"/><line id="tlCursor" x1="0" x2="0" y1="0" y2="${H}" stroke="#c62828" stroke-width="1.5"/></svg>
      <p class="hint">Line: gauge level. Blue: buildings flooded. Orange: buildings cut off.</p>
      <div class="time-ctl"><span class="time-label" id="tlLabel"></span>
        <button type="button" class="btn small" id="tlPlay">Play</button>
        <input type="range" id="tlSlider" min="0" max="${K - 1}" step="1" value="${state.timeStep}" aria-label="Time"></div>
      ${routeNote(tl)}
      ${tl.event ? `<p class="hint">Recorded flood: ${escapeHtml(tl.event.name)}, ${escapeHtml(tl.event.gauge.name)} gauge (Water Data Online, Bureau of Meteorology and data owners). Hours count from ${escapeHtml(fmtWhen(tl.event, 0))}.</p>` : ''}
      ${ac ? `<p><strong>Roads:</strong> ${ac.roads.length ? `the first closes ${tl.event ? '' : 'at '}${whenH(ac.firstClose)} (${escapeHtml(ac.roads[0].name)})${!tl.event && ac.firstClose < 0 ? ', before the gauge starts rising: places upstream see the flood first' : ''}. ${ac.roads.slice(0, 8).map((r) => `${escapeHtml(r.name)} ${whenH(r.closes)} to ${whenH(r.reopens)}`).join('; ')}${ac.roads.length > 8 ? `; and ${ac.roads.length - 8} more` : ''}.` : 'no named road goes under more than 30 cm of water.'}</p>
        <p><strong>Cut off:</strong> ${ac.maxIso ? `up to ${n(ac.maxIso)} dry buildings have no dry road out, ${tl.event ? '' : 'at '}${whenH(ac.maxIsoAt)}; the longest any is cut off is about ${ac.longest} hours.` : 'no dry building loses its last dry road out.'}</p>`
    : '<p class="hint">Count what\'s affected to see road closures and places cut off.</p>'}`;
    const slider = $('tlSlider');
    // rAF-coalesce slider drags: showTimeStep does a full re-inundation
    slider.addEventListener('input', () => scheduleTimeStep(+slider.value));
    $('tlPlay').addEventListener('click', () => {
      if (state.timePlay) { clearInterval(state.timePlay); state.timePlay = 0; $('tlPlay').textContent = 'Play'; scheduleFine(); return; }
      $('tlPlay').textContent = 'Pause';
      state.timePlay = setInterval(() => {
        const k = (+slider.value + 1) % K;
        slider.value = k; showTimeStep(k);
        if (k === K - 1) { clearInterval(state.timePlay); state.timePlay = 0; $('tlPlay').textContent = 'Play'; scheduleFine(); }
      }, 350);
    });
    updateTimeLabel(state.timeStep);
  }
  function updateTimeLabel(k) {
    const area = state.areaKey && areaReg.get(state.areaKey), tl = area && area.timeline;
    if (!tl || !$('tlLabel')) return;
    const h = Math.round(tl.t0 + k * tl.step), g = tl.gauge[k], prev = tl.gauge[Math.max(0, k - 1)];
    const ac = tl.access;
    const when = tl.event ? fmtWhen(tl.event, h) : hoursLabel(h);
    const board = tl.event ? ` (${(g - tl.boardShift).toFixed(2)} m on the gauge board)` : '';
    $('tlLabel').textContent = `${when} · gauge ${g.toFixed(2)} m${board}, ${g > prev + 1e-3 ? 'rising' : g < prev - 1e-3 ? 'falling' : 'steady'}`
      + (ac ? ` · ${ac.floodCount[k].toLocaleString('en-AU')} buildings flooded, ${ac.isoCount[k].toLocaleString('en-AU')} cut off, ${ac.closedCount[k].toLocaleString('en-AU')} road sections closed` : '');
    const cur = document.getElementById('tlCursor');
    if (cur) { const xx = (k / (tl.steps - 1)) * 300; cur.setAttribute('x1', xx); cur.setAttribute('x2', xx); }
  }
  // Show the flood at one moment on the map (and in the counts)
  // one time step re-runs the model at full grid: coalesce slider events
  let timeRaf = 0, timePending = null;
  function scheduleTimeStep(k) {
    timePending = k;
    if (timeRaf) return;
    timeRaf = requestAnimationFrame(() => {
      timeRaf = 0;
      if (timePending != null) showTimeStep(timePending);
      timePending = null;
    });
  }
  function showTimeStep(k) {
    const area = state.areaKey && areaReg.get(state.areaKey), tl = area && area.timeline, a = state.a;
    if (!tl || !a) return;
    state.timeStep = k;
    const n = a.N;
    const wse = state.wseScratch && state.wseScratch.length === n ? state.wseScratch : (state.wseScratch = new Float64Array(n));
    wse.fill(NaN);
    const hasFrame = tl.depthFrames && tl.depthFrames.length >= (k + 1) * n && tl.depthFrameMax && tl.depthFrameMax.length > k;
    let run;
    if (hasFrame) {
      const maxD = tl.depthFrameMax[k] || 0;
      const frame = tl.depthFrames.subarray(k * n, (k + 1) * n);
      // scratch buffers reused across steps: three fresh ~N-cell arrays per
      // step used to churn the GC on large grids
      const depth = state.depthScratch && state.depthScratch.length === n ? state.depthScratch : (state.depthScratch = new Float32Array(n));
      const wet = state.wetScratch && state.wetScratch.length === n ? state.wetScratch : (state.wetScratch = new Uint8Array(n));
      const level = state.levelScratch && state.levelScratch.length === n ? state.levelScratch : (state.levelScratch = new Float32Array(n));
      wet.fill(0);
      depth.fill(0);
      level.fill(NaN);
      for (let c = 0; c < n; c++) {
        const q = frame[c];
        if (q > 0) { wet[c] = 1; depth[c] = (q / 255) * maxD; level[c] = a.dem[c] + depth[c]; wse[c] = level[c]; }
      }
      run = dryLowGround({ depth, wet, level, wse, onPath: new Uint8Array(n), vx: new Float64Array(n), vy: new Float64Array(n) }, state.base);
    } else {
      const t = tl.t0 + k * tl.step;
      F.waveSurface(a, tl.wave, t, wse);
      run = dryLowGround(F.inundate(a, Object.assign({}, tl.s, { wse, bayLevel: tl.wave.bayAt(t) }), { slim: 1 }), state.base);
    }
    state.run = run;
    state.timeView = true;
    drawMap();
    drawStats(tl.s);
    updateTimeLabel(k);
    clearTimeout(impactT);
    // impact recomputes are expensive (buildings + roads + census areas);
    // during playback the numbers are transient anyway, so refresh slower
    impactT = setTimeout(() => maybeRenderImpact(), state.timePlay ? 600 : 150);
  }
  busyClick($('runTimeline'), 'Running hour by hour…', () => runTimeline());
  window.__floodRunTimeline = runTimeline;
  window.__floodEventsHere = async () => { await ensureHistory(); return eventsHere().map((e) => e.id); };
  window.__floodTimeStep = (k) => { showTimeStep(k); return status.impact; };

  /* ---------- on-demand flood modelling */

  const windowBox = (lat, lon, halfKm) => {
    const dLat = (halfKm * 1000) / 110574;
    const dLon = (halfKm * 1000) / (111320 * Math.cos((lat * Math.PI) / 180));
    return [lon - dLon, lat - dLat, lon + dLon, lat + dLat];
  };

  // Read one GeoTIFF window from a GA elevation WCS.
  const wcsUrl = (base, box, W, H, crs, fmt) => {
    const [w, s, e, n] = box;
    return `${base}?service=WCS&version=1.0.0&request=GetCoverage&coverage=1&crs=${crs || 'EPSG:4326'}`
      + `&bbox=${w.toFixed(6)},${s.toFixed(6)},${e.toFixed(6)},${n.toFixed(6)}&width=${W}&height=${H}&format=${fmt || 'GeoTIFF'}`;
  };
  // one try at GA's elevation services gives up after this (a stalled
  // request otherwise leaves "Downloading elevation…" up for good)
  const RASTER_TIMEOUT_MS = 45000;
  async function fetchRaster(base, box, W, H, url0) {
    const direct = url0 || wcsUrl(base, box, W, H);
    // Preserve the broker path for browsers whose direct GA request is blocked
    // by CORS. Hosted builds can fall back to GA if the proxy is unavailable
    // or the raster exceeds Lambda's response limit.
    const proxy = BROKER ? `${BROKER}/v1/elev?url=${encodeURIComponent(direct)}` : direct;
    const urls = BROKER && !isTauri() ? [proxy, direct, proxy] : [proxy, proxy, proxy];
    // GA's service occasionally drops a request (its error replies carry no
    // CORS header, so the browser reports a network failure): try again
    let r = null;
    for (let attempt = 0; attempt < 3; attempt++) {
      if (attempt) await new Promise((ok) => setTimeout(ok, 1500 * attempt));
      try { r = await fetch(urls[attempt], { signal: AbortSignal.timeout(RASTER_TIMEOUT_MS) }); } catch (err) { r = null; if (attempt === 2) throw new Error(err && err.name === 'TimeoutError' ? 'the elevation service is not answering; try again shortly' : 'the elevation service could not be reached; try again shortly', { cause: err }); continue; }
      if (r.ok) break;
      if (r.status < 500 && !(BROKER && !isTauri())) break;
    }
    if (!r.ok) throw new Error(`the elevation service returned ${r.status}`);
    const type = r.headers.get('content-type') || '';
    if (!/tiff/i.test(type)) throw new Error('the elevation service did not return elevation data for this place');
    const buf = await r.arrayBuffer();
    let iw, ih, data, nd, tiffBounds;
    try {
      // GA's service leaves all-sea tiles out ("sparse" tiles); this reader
      // handles that, unlike the general GeoTIFF library
      const t = F.parseSimpleTiff(buf);
      iw = t.W; ih = t.H; data = t.data; nd = t.nodata; tiffBounds = t.bounds;
    } catch (err) {
      await loadGeoTiffLib();
      const img = await (await window.GeoTIFF.fromArrayBuffer(buf)).getImage();
      iw = img.getWidth(); ih = img.getHeight();
      data = (await img.readRasters({ samples: [0] }))[0];
      nd = img.getGDALNoData();
      try { tiffBounds = img.getBoundingBox(); } catch (e2) { tiffBounds = null; }
    }
    return { iw, ih, data, nd, tiffBounds };
  }

  async function fetchDemWindow(lat, lon, halfKm, cellM, opts = {}) {
    const [w, s, e, n] = windowBox(lat, lon, halfKm);
    const W = Math.round((2 * halfKm * 1000) / cellM), H = W;
    const { iw, ih, data, nd, tiffBounds } = await fetchRaster(DEMH_WCS, [w, s, e, n], W, H);
    const dem = new Float32Array(iw * ih), valid = new Uint8Array(iw * ih);
    let land = 0, gaps = 0;
    for (let i = 0; i < iw * ih; i++) {
      const v = data[i];
      if (!Number.isFinite(v) || v === nd || v < -1000 || v > 9000) { dem[i] = NaN; gaps++; }
      else { dem[i] = v; land++; }
      valid[i] = 1;
    }
    // DEM-H marks the sea as no data, but it has gaps inland too: sea stays
    // water just below sea level, inland gaps are filled from the land
    // around them (not left as pits for the model to fill as "normal water")
    if (gaps) {
      const g = classifyDemGaps(dem, iw, ih);
      for (let i = 0; i < iw * ih; i++) if (g.sea[i]) dem[i] = -1.5;
      land += g.filledCells;
    }
    // sea-only windows are fine for the 3D terrain stream (flat sea planes);
    // a flood model needs land to be interesting
    if (land < iw * ih * 0.05 && !(opts && opts.allowSea)) throw new Error('there is almost no land in the elevation data here');
    let bounds = [w, s, e, n];
    if (tiffBounds && tiffBounds.length === 4 && Math.abs(tiffBounds[0] - w) < 0.05 && Math.abs(tiffBounds[3] - n) < 0.05) bounds = tiffBounds;
    const cell = ((bounds[2] - bounds[0]) * 111320 * Math.cos((lat * Math.PI) / 180)) / iw;
    return { grid: { W: iw, H: ih, cell, dem, valid }, bounds };
  }

  // Geoscience Australia's 5 m bare-earth LiDAR elevation covers towns,
  // the coast and the Murray-Darling floodplains. Where it covers enough of
  // a model window it replaces DEM-H (gaps filled from DEM-H); it has no
  // buildings or trees in it, unlike the 30 m model.
  const LIDAR_WCS = 'https://services.ga.gov.au/gis/services/DEM_LiDAR_5m_2025/MapServer/WCSServer';
  const LIDAR_PREF = 'floodExplorer.lidar';
  let lidarVariant = null;
  const useLidar = () => { try { return localStorage.getItem(LIDAR_PREF) !== 'off'; } catch (e) { return true; } };
  // Fetch the LiDAR window (raw) — runs alongside the DEM-H download.
  async function fetchLidar(box, halfKm, demCell) {
    const cellL = halfKm <= 10 ? 20 : demCell;          // 20 m for 20 km models
    const midLat = (box[1] + box[3]) / 2;
    const W = Math.round((box[2] - box[0]) * 111320 * Math.cos((midLat * Math.PI) / 180) / cellL);
    const H = Math.round((box[3] - box[1]) * 110574 / cellL);
    return fetchLidarBox(box, W, H);
  }
  async function fetchLidarBox(box, W, H) {
    // the request format GA's LiDAR service accepts (GDA94 works), found once per visit
    const variants = [['EPSG:4283', null], [null, null]];
    let r = null, lastErr = null;
    const order = lidarVariant != null ? [lidarVariant] : variants.map((_, k) => k);
    for (const k of order) {
      try { r = await fetchRaster(LIDAR_WCS, box, W, H, wcsUrl(LIDAR_WCS, box, W, H, variants[k][0], variants[k][1])); lidarVariant = k; break; } catch (err) { lastErr = err; }
    }
    status.lidarVariant = lidarVariant;
    if (!r) throw lastErr || new Error('no LiDAR');
    return r;
  }
  // LiDAR where it has data, DEM-H (nearest cell) where it doesn't. A LiDAR
  // cell near sea level where DEM-H says the land is well above it is a gap
  // in the LiDAR mosaic (inland rivers came through near 0 m: a 170 m trench
  // at Wagga Wagga), not real ground, so DEM-H fills it too. Real LiDAR
  // well below DEM-H (a gorge DEM-H smooths over, as at Launceston) is kept.
  const LIDAR_DROP_MAX_M = 25, LIDAR_GAP_BELOW_M = 10;
  function mergeLidar(grid, r) {
    const { iw, ih, data, nd } = r;
    const N = iw * ih, dem = new Float32Array(N), valid = new Uint8Array(N);
    let have = 0, dropped = 0;
    for (let y = 0; y < ih; y++) {
      const yd = Math.min(grid.H - 1, Math.floor(((y + 0.5) / ih) * grid.H));
      for (let x = 0; x < iw; x++) {
        const k = y * iw + x, v = data[k];
        const xd = Math.min(grid.W - 1, Math.floor(((x + 0.5) / iw) * grid.W));
        const d = grid.dem[yd * grid.W + xd];
        const ok = Number.isFinite(v) && v !== nd && v > -100 && v < 9000;
        if (ok && !(v < LIDAR_GAP_BELOW_M && v < d - LIDAR_DROP_MAX_M)) { dem[k] = v; have++; } else {
          if (ok) dropped++;
          dem[k] = d;
        }
        valid[k] = 1;
      }
    }
    const share = have / N;
    status.lidarDropped = dropped;
    if (share < 0.2) return { grid, share, dropped };
    const cell = grid.cell * grid.W / iw;
    return { grid: { W: iw, H: ih, cell, dem, valid }, share, dropped };
  }


  async function modelHere(lat, lon, opts) {
    const o = Object.assign({ kind: 'river', name: 'This area' }, opts || {});
    const t0 = performance.now();
    if (nat.data) await ensureRiverGauges();
    setBusy(true, 'Downloading elevation for this area…');
    status.local = { started: true };
    try {
      // 20 km square at ~30 m; if the elevation file can't be read, try once
      // more at a slightly different size (the service occasionally returns
      // a file the reader rejects)
      let got = null, lastErr = null;
      const H0 = o.halfKm || 10, C0 = o.cellM || 30, [wlat, wlon] = o.center || [lat, lon];
      if (H0 > 10) setBusy(true, `Downloading elevation for a ${2 * H0} km area…`);
      // LiDAR downloads alongside DEM-H
      const lidarP = useLidar() && o.lidar !== false
        ? fetchLidar(windowBox(wlat, wlon, H0), H0, C0).catch(() => null) : Promise.resolve(null);
      for (const [half, cell] of [[H0, C0], [H0, Math.round(C0 * 1.07)], [H0 * 0.9, C0]]) {
        try { got = await fetchDemWindow(wlat, wlon, half, cell); break; } catch (err) {
          lastErr = err;
          if (/no land/.test(String(err.message))) break;
        }
      }
      if (!got) throw lastErr || new Error('no elevation data');
      let { grid } = got;
      const { bounds } = got;
      let lidarShare = 0;
      // the 5 m LiDAR comes from a separate, slower service: wait a little
      // longer for it, then go ahead with DEM-H
      setBusy(true, 'Downloading LiDAR elevation for this area…');
      let lidLate = false;
      const lid = await Promise.race([lidarP, new Promise((ok) => setTimeout(() => { lidLate = true; ok(null); }, 20000))]);
      if (lidLate) say('The LiDAR elevation service is slow right now, so this model uses the 30 m elevation (DEM-H).');
      if (lid) {
        const l = mergeLidar(grid, lid);
        lidarShare = l.share;
        if (l.share >= 0.2) grid = l.grid;
      } else if (useLidar() && o.lidar !== false) lidarShare = -1;   // service unavailable: DEM-H
      setBusy(true, 'Working out how water flows here…');
      await nextFrame();
      const col = Math.round(((lon - bounds[0]) / (bounds[2] - bounds[0])) * grid.W);
      const row = Math.round(((bounds[3] - lat) / (bounds[3] - bounds[1])) * grid.H);
      if (col < 0 || row < 0 || col >= grid.W || row >= grid.H) throw new Error('the gauge fell outside the elevation window');
      if (o.replaceKey) removeArea(o.replaceKey, { quiet: true });   // extending: the new window replaces the old
      const key = `local-${++localCount}`;
      state.areaMeta = {
        id: 'local', areaKey: key, local: true, kind: o.kind, name: o.name, bounds_lonlat: bounds, reportId: o.reportId || null, presetId: o.presetId || null, pinN: o.pinN != null ? o.pinN : null,
        keepN: o.keepN != null ? o.keepN : null, halfKm: o.halfKm || 10, gaugeLatLon: [lat, lon], centerLatLon: o.center || [lat, lon],
        gauge: { col, row }, streamAreaKm2: o.streamAreaKm2 || Math.max(0.5, Math.min(4, (grid.W * grid.H * grid.cell * grid.cell) / 1e6 * 0.004)),
        lidarShare,
        source: lidarShare >= 0.2
          ? `Terrain: Geoscience Australia 5 m LiDAR elevation (bare earth) for ${Math.round(lidarShare * 100)}% of this area, resampled to ${Math.round(grid.cell)} m, with the 1-second DEM-H filling the rest; CC BY 4.0, read live from GA.`
          : 'Terrain: Geoscience Australia 1-second (about 30 m) hydrologically enforced elevation model (DEM-H), CC BY 4.0, read live from GA. No LiDAR covers this area.',
      };
      addModelledOption(key, o.name);
      $('area').value = key;
      await useGrid(grid, 'local', { events: false });
      if (o.kind === 'coast') {
        ctl.bayLevel.value = 1.5;
        if (state.gauge >= 0) ctl.gaugeLevel.value = Math.max(parseFloat(ctl.gaugeLevel.min), Math.round((state.a.dem[state.gauge] + 0.5) * 20) / 20);
        state.base = null;
        syncOutputs();
        runScenario();
      }
      status.local = { ok: true, key, W: grid.W, H: grid.H, cell: Math.round(grid.cell), ms: Math.round(performance.now() - t0), kind: o.kind, km: 2 * (o.halfKm || 10), lidar: Math.round(lidarShare * 100) / 100 };
      openPanel('panel-scenario');
      if (!o.replaceKey && !o.quiet) say(o.kind === 'coast'
        ? 'Coastal model ready. Set the bay level and sea-level rise in Scenario.'
        : 'River model ready. Set the peak level at the gauge in Scenario.');
      return true;
    } catch (err) {
      status.local = { ok: false, error: String(err.message || err) };
      say(`Couldn’t model this area: ${err.message || err}.`, { error: true });
      return false;
    } finally {
      setBusy(false);
    }
  }
  window.__floodModelHere = modelHere;

  /* ---------- study an area: drag a box, pull in everything inside */
  // Opens reports for every gauge and dam in the box, covers the whole box
  // with flood models (each run from a gauge where there is one, or from a
  // pinned spot), and switches on the state flood layer.
  let suppressClickUntil = 0;
  const STUDY_CONFIRM_MODELS = 12;   // ask before building more than this
  status.study = null;

  function setStudyMode(on) {
    const m = state.lmap;
    if (!m) { say('Open the Australia map first.'); return; }
    $('studyArea').setAttribute('aria-pressed', String(on));
    $('studyHint').hidden = !on;
    $('lmap').classList.toggle('selecting', on);
    if (on) { m.dragging.disable(); m.closePopup(); } else m.dragging.enable();
    studyDrag.on = on;
  }
  const studyDrag = { on: false, start: null, rect: null };
  function studyPoint(e) { return state.lmap.mouseEventToLatLng(e); }
  function wireStudy() {
    const el = $('lmap');
    el.addEventListener('pointerdown', (e) => {
      if (!studyDrag.on || e.button > 0) return;
      e.preventDefault(); e.stopPropagation();
      el.setPointerCapture(e.pointerId);
      studyDrag.start = studyPoint(e);
      studyDrag.rect = window.L.rectangle([studyDrag.start, studyDrag.start], { color: '#0d5f8c', weight: 2, dashArray: '6 4', fillOpacity: 0.08, interactive: false }).addTo(state.lmap);
    }, true);
    el.addEventListener('pointermove', (e) => {
      if (!studyDrag.on || !studyDrag.rect) return;
      e.preventDefault();
      studyDrag.rect.setBounds(window.L.latLngBounds(studyDrag.start, studyPoint(e)));
    }, true);
    el.addEventListener('pointerup', (e) => {
      if (!studyDrag.on || !studyDrag.rect) return;
      const b = window.L.latLngBounds(studyDrag.start, studyPoint(e));
      state.lmap.removeLayer(studyDrag.rect);
      studyDrag.rect = null;
      suppressClickUntil = Date.now() + 500;
      const px = state.lmap.latLngToContainerPoint(b.getNorthEast()).subtract(state.lmap.latLngToContainerPoint(b.getSouthWest()));
      if (Math.abs(px.x) < 12 || Math.abs(px.y) < 12) { say('Drag to draw a box over the area.'); return; }
      setStudyMode(false);
      studyArea(b);
    }, true);
  }
  $('studyArea').addEventListener('click', () => setStudyMode(!studyDrag.on));
  $('studyCancel').addEventListener('click', () => setStudyMode(false));
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && studyDrag.on) setStudyMode(false); });

  const kmBetween = (a, b) => {
    const dy = (a[0] - b[0]) * 110.574, dx = (a[1] - b[1]) * 111.32 * Math.cos(((a[0] + b[0]) / 2) * Math.PI / 180);
    return Math.hypot(dx, dy);
  };

  // Studied areas stay on the map as lettered boxes, are listed in Places,
  // and are saved in this browser so they come back next visit (their
  // models are rebuilt on demand with the run button).
  const STUDY_KEY = 'floodExplorer.studies.v1';
  const studies = [];
  let selectedStudy = null;
  const ICON_RUN = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M20 12a8 8 0 1 1-2.3-5.6"/><path d="M20 4v5h-5"/></svg>';
  function saveStudies() {
    try {
      localStorage.setItem(STUDY_KEY, JSON.stringify(studies.map((x) => ({ letter: x.letter, bounds: x.bounds, name: x.name, created: x.created, summary: x.summary, nums: x.nums || [] }))));
    } catch (e) { /* storage unavailable: studies last for this visit */ }
  }
  function nextLetter() {
    const used = new Set(studies.map((x) => x.letter));
    for (let i = 0; ; i++) {
      const l = i < 26 ? String.fromCharCode(65 + i) : `A${i - 25}`;
      if (!used.has(l)) return l;
    }
  }
  function drawStudy(st) {
    const L = window.L, m = state.lmap;
    if (!m || st.rect) return;
    const [S, W, N, E] = st.bounds;
    st.rect = L.rectangle([[S, W], [N, E]], { color: '#0d5f8c', weight: 1.5, dashArray: '8 6', fill: false, interactive: false }).addTo(m);
    st.label = L.marker([N, W], {
      icon: L.divIcon({ className: 'study-label', html: `<span>${st.letter}</span>`, iconSize: [26, 26], iconAnchor: [0, 0] }),
      keyboard: false, zIndexOffset: 700,
    }).addTo(m);
    st.label.bindTooltip(`Study area ${st.letter}: ${st.name}`, { direction: 'top', offset: [13, 0] });
    st.label.on('click', () => selectStudy(st.letter));
  }
  function loadStudies() {
    if (studies.length) return;
    try {
      const saved = JSON.parse(localStorage.getItem(STUDY_KEY) || '[]');
      // a study whose places are still here needs no rebuild: they come back with the other places
      saved.forEach((x) => { if (Array.isArray(x.bounds) && x.bounds.length === 4) studies.push(Object.assign({ nums: [] }, x, { loaded: false })); });
    } catch (e) { /* nothing saved */ }
    studies.forEach(drawStudy);
    renderPlaces();
  }
  function addStudy(b) {
    const bounds = [b.getSouth(), b.getWest(), b.getNorth(), b.getEast()];
    const c = [(bounds[0] + bounds[2]) / 2, (bounds[1] + bounds[3]) / 2];
    const near = nearestNamed(c[0], c[1], 60);
    const st = { letter: nextLetter(), bounds, name: near ? `Around ${near.f.properties.name}` : `${c[0].toFixed(2)}, ${c[1].toFixed(2)}`, created: new Date().toISOString(), summary: null, loaded: false, nums: [] };
    studies.push(st);
    drawStudy(st);
    saveStudies();
    return st;
  }
  function selectStudy(letter) {
    const st = studies.find((x) => x.letter === letter);
    if (!st || !state.lmap) return;
    const [S, W, N, E] = st.bounds;
    state.lmap.fitBounds([[S, W], [N, E]], { padding: [30, 30] });
    studies.forEach((x) => x.rect && x.rect.setStyle({ weight: x === st ? 3 : 1.5 }));
    selectedStudy = letter;
    setPlacesCollapsed(false);
    renderPlaces();
  }
  function studySize(st) {
    const [S, W, N, E] = st.bounds;
    return `${Math.round((E - W) * 111.32 * Math.cos(((S + N) / 2) * Math.PI / 180))} × ${Math.round((N - S) * 110.574)} km`;
  }
  // the study's own places that are still on the map
  const studyMembers = (st) => {
    const have = new Set([...reports.map((r) => r.n), ...Array.from(areaReg.values()).map((a) => a.n), ...pins.map((p) => p.n)]);
    return (st.nums || []).filter((n) => have.has(n)).sort((a, b) => a - b);
  };
  function studiesHtml() {
    if (!studies.length) return '';
    const rows = studies.map((st) => {
      const sm = st.summary, members = studyMembers(st);
      const models = members.filter((n) => areaByNumber(n)).length;
      const state0 = st.running ? 'building…' : members.length ? `${models} flood model${models === 1 ? '' : 's'}${sm && sm.stopped ? ' (stopped part-way)' : ''}` : st.loaded ? 'no places left' : 'saved: run to load it';
      const tags = [studySize(st), sm ? `${sm.gauges} gauge${sm.gauges === 1 ? '' : 's'}, ${sm.dams} dam${sm.dams === 1 ? '' : 's'}` : null, state0].filter(Boolean).join(' · ');
      const toggle = members.length ? `<button type="button" class="link-btn study-toggle" data-study-open="${st.letter}" aria-expanded="${!!st.open}">${st.open ? 'Hide' : 'Show'} its ${members.length} place${members.length === 1 ? '' : 's'}</button>` : '';
      const list = st.open && members.length ? `<ul class="places study-members">${members.map(placeRowHtml).join('')}</ul>` : '';
      return `<li class="place study-row${selectedStudy === st.letter ? ' on' : ''}">
        <button type="button" class="place-main" data-study="${st.letter}" title="Show study area ${st.letter}">
          <span class="pin-num study-badge">${st.letter}</span>
          <span class="place-text"><span class="place-name">${escapeHtml(st.name)}</span><span class="place-tags">${tags}</span></span>
        </button>
        <button type="button" class="icon-btn" data-study-run="${st.letter}" aria-label="${st.loaded ? 'Run again' : 'Run'}: load its gauges, dams and flood models" title="${st.loaded ? 'Run again' : 'Run study'}">${ICON_RUN}</button>
        <button type="button" class="icon-btn" data-study-zoom="${st.letter}" aria-label="Zoom to study area ${st.letter}" title="Zoom to">${ICON_ZOOM}</button>
        <button type="button" class="icon-btn" data-study-drop="${st.letter}" aria-label="Remove study area ${st.letter}" title="Remove">×</button>
        ${toggle ? `<div class="study-more">${toggle}</div>` : ''}${list}
      </li>`;
    }).join('');
    return `<h3 class="places-sub">Studied areas</h3><ul class="places">${rows}</ul>`;
  }
  function wireStudyRows(box) {
    box.querySelectorAll('[data-study]').forEach((b) => b.addEventListener('click', () => selectStudy(b.dataset.study)));
    box.querySelectorAll('[data-study-zoom]').forEach((b) => b.addEventListener('click', () => selectStudy(b.dataset.studyZoom)));
    box.querySelectorAll('[data-study-open]').forEach((b) => b.addEventListener('click', () => {
      const st = studies.find((x) => x.letter === b.dataset.studyOpen);
      if (st) { st.open = !st.open; renderPlaces(); }
    }));
    box.querySelectorAll('[data-study-run]').forEach((b) => b.addEventListener('click', () => {
      const st = studies.find((x) => x.letter === b.dataset.studyRun);
      if (st) { const [S, W, N, E] = st.bounds; studyArea(window.L.latLngBounds([S, W], [N, E]), st); }
    }));
    box.querySelectorAll('[data-study-drop]').forEach((b) => b.addEventListener('click', () => {
      const i = studies.findIndex((x) => x.letter === b.dataset.studyDrop);
      if (i < 0) return;
      const st = studies[i], members = studyMembers(st);
      if (members.length && !window.confirm(`Remove study area ${st.letter} and its ${members.length} place${members.length === 1 ? '' : 's'} (reports and flood models)?`)) return;
      if (st.running) st.stop = true;
      members.forEach(dropPlace);
      [st.rect, st.label].forEach((l) => l && state.lmap && state.lmap.removeLayer(l));
      studies.splice(i, 1);
      if (selectedStudy === st.letter) selectedStudy = null;
      saveStudies();
      renderPlaces();
    }));
  }
  window.__floodStudies = () => studies.map((x) => ({ letter: x.letter, name: x.name, bounds: x.bounds, loaded: x.loaded, summary: x.summary }));

  async function studyArea(b, existing) {
    const study = existing || addStudy(b);
    if (study.running) return status.study;
    selectedStudy = study.letter;
    study.nums = study.nums || [];
    const claim = (n) => { if (n != null && !study.nums.includes(n)) study.nums.push(n); };
    if (!nat.data) await loadNationalData();
    const S = b.getSouth(), N = b.getNorth(), Wl = b.getWest(), E = b.getEast();
    const midLat = (S + N) / 2;
    const wKm = (E - Wl) * 111.32 * Math.cos(midLat * Math.PI / 180), hKm = (N - S) * 110.574;
    // the finest model size that covers the box in a handful of windows;
    // bigger boxes use the largest size and as many windows as they need
    let size = null, nx = 0, ny = 0;
    for (const [half, cell] of MODEL_SIZES) {
      size = [half, cell];
      nx = Math.max(1, Math.ceil(wKm / (2 * half) - 0.05)); ny = Math.max(1, Math.ceil(hKm / (2 * half) - 0.05));
      if (nx * ny <= 4) break;
    }
    const inBox = (f) => { const [lo, la] = f.geometry.coordinates; return la >= S && la <= N && lo >= Wl && lo <= E; };
    const rank = { forecast: 0, information: 1, tide: 2, river: 3 };
    const gauges = nat.data.gauges.filter(inBox).sort((x, y) => (rank[x.properties.kind] ?? 9) - (rank[y.properties.kind] ?? 9));
    const dams = nat.data.storages.filter(inBox);
    // tiles, each modelled from the best gauge inside it
    const tiles = [];
    const dLat = (N - S) / ny, dLon = (E - Wl) / nx;
    for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) {
      const t = { s: S + j * dLat, n: S + (j + 1) * dLat, w: Wl + i * dLon, e: Wl + (i + 1) * dLon };
      t.c = [(t.s + t.n) / 2, (t.w + t.e) / 2];
      const inside = gauges.filter((f) => { const [lo, la] = f.geometry.coordinates; return la >= t.s && la <= t.n && lo >= t.w && lo <= t.e && f.properties.kind !== 'tide'; });
      inside.sort((x, y) => ((rank[x.properties.kind] ?? 9) - (rank[y.properties.kind] ?? 9))
        || kmBetween([x.geometry.coordinates[1], x.geometry.coordinates[0]], t.c) - kmBetween([y.geometry.coordinates[1], y.geometry.coordinates[0]], t.c));
      t.gauge = inside[0] || null;
      t.tide = gauges.find((f) => f.properties.kind === 'tide' && (() => { const [lo, la] = f.geometry.coordinates; return la >= t.s && la <= t.n && lo >= t.w && lo <= t.e; })()) || null;
      tiles.push(t);
    }
    // skip parts already covered by a model on the map
    const covered = (t) => Array.from(areaReg.values()).some((a) => {
      const bb = a.areaMeta && a.areaMeta.bounds_lonlat;
      return bb && bb[0] <= t.w && bb[2] >= t.e && bb[1] <= t.s && bb[3] >= t.n;
    });
    const todo = tiles.filter((t) => !covered(t));
    if (todo.length > STUDY_CONFIRM_MODELS
      && !window.confirm(`This box needs ${todo.length} flood models (${2 * size[0]} km each), which takes a while and a lot of memory. Build them all?`)) {
      status.study = { ok: false, error: 'cancelled', models: todo.length };
      return status.study;
    }
    const summary = { ok: true, km: 2 * size[0], tiles: tiles.length, models: 0, reports: 0, gauges: gauges.length, dams: dams.length, layers: [] };
    status.study = Object.assign({ running: true }, summary);
    study.running = true; study.stop = false;
    const progress = (text) => { $('studyProgressText').textContent = `Study area ${study.letter}: ${text}`; $('studyProgress').hidden = false; };
    $('studyStop').onclick = () => { study.stop = true; progress('stopping after this step…'); };
    renderPlaces();
    state.lmap.fitBounds(b, { padding: [30, 30] });
    // state flood layers for the states in the box
    const states = new Set([...gauges, ...dams].map((f) => f.properties.state).filter(Boolean));
    for (const st of states) {
      const sl = stateLayerFor(st);
      if (sl && sl.layer && !state.lmap.hasLayer(sl.layer)) { sl.layer.userOn = true; sl.layer.addTo(state.lmap); summary.layers.push(sl.name); }
    }
    if (summary.layers.length) { syncLayerLists(); renderOverlayLegend(); }
    // reports for every gauge and dam in the box, tile gauges first
    const want = [...tiles.map((t) => t.gauge || t.tide).filter(Boolean), ...dams, ...gauges];
    const seen = new Set();
    progress(`opening ${want.length} gauge and dam reports…`);
    for (const f of want) {
      const id = `${f.properties.kind}:${f.properties.id}`;
      if (seen.has(id)) continue;
      seen.add(id);
      const isNew = !reports.some((r) => r.id === id);
      if (isNew) summary.reports++;
      openReport(f, { select: false });
      if (isNew) { const r = reports.find((x) => x.id === id); if (r) claim(r.n); }   // places that were already here stay where they are
    }
    renderPlaces();   // the last report was listed before it was claimed
    // models, one per tile
    summary.models = tiles.length - todo.length;   // already covered
    for (const [k, t] of todo.entries()) {
      if (study.stop) { summary.stopped = true; break; }
      progress(`building flood model ${k + 1} of ${todo.length} (${2 * size[0]} km)…`);
      setBusy(true, `Modelling part ${k + 1} of ${todo.length} of the area…`);
      const src = t.gauge || t.tide;
      let ok;
      if (src) {
        const [lo, la] = src.geometry.coordinates, p = src.properties;
        const r = reports.find((x) => x.id === `${p.kind}:${p.id}`);
        if (r && areaForReport(r)) { summary.models++; continue; }
        ok = await modelHere(la, lo, { kind: p.kind === 'tide' ? 'coast' : 'river', name: p.name, reportId: r ? r.id : null, halfKm: size[0], cellM: size[1], center: t.c });
      } else {
        const pin = addPin(t.c[0], t.c[1]);
        claim(pin.n);
        ok = await modelHere(t.c[0], t.c[1], { kind: 'river', name: pin.name, pinN: pin.n, halfKm: size[0], cellM: size[1], center: t.c });
      }
      if (ok) summary.models++;
    }
    setBusy(false);
    $('studyProgress').hidden = true;
    study.running = false;
    status.study = summary;
    study.summary = { gauges: summary.gauges, dams: summary.dams, models: summary.models, km: summary.km, stopped: !!summary.stopped };
    study.loaded = true;
    if (!studies.includes(study)) { status.study = Object.assign(summary, { removed: true }); return summary; }   // removed while it ran
    saveStudies();
    renderPlaces();
    const first = tiles.map((t) => t.gauge || t.tide).find(Boolean);
    say(`Area study${summary.stopped ? ' (stopped: the models built so far are kept)' : ''}: ${summary.models} flood model${summary.models === 1 ? '' : 's'} (${summary.km} km each), ${summary.gauges} gauge${summary.gauges === 1 ? '' : 's'} and ${summary.dams} dam${summary.dams === 1 ? '' : 's'} inside${summary.layers.length ? `; ${summary.layers.join(', ')} on` : ''}.`);
    if (first) { const r = reports.find((x) => x.id === `${first.properties.kind}:${first.properties.id}`); if (r) selectPlace(r.n); }
    state.lmap.fitBounds(b, { padding: [30, 30] });
    return summary;
  }
  window.__floodStudyArea = (s0, w0, n0, e0) => studyArea(window.L.latLngBounds([s0, w0], [n0, e0]));

  /* --------------------------------------------------------- panels */
  const isPhone = () => window.matchMedia('(max-width: 760px)').matches;

  // On wide screens the Scenario panel always shows under Places and
  // collapses to its header; on phones it is a bottom sheet like the rest.
  function setScenarioCollapsed(collapsed) {
    const p = $('panel-scenario');
    p.classList.toggle('collapsed', collapsed);
    $('scenarioCollapse').setAttribute('aria-expanded', String(!collapsed));
    $('scenarioCollapse').setAttribute('aria-label', collapsed ? 'Expand the flood scenario' : 'Collapse the flood scenario');
    status.scenarioOpen = !collapsed;
    syncPanels();
  }
  window.__floodSetScenarioCollapsed = setScenarioCollapsed;
  $('scenarioCollapse').addEventListener('click', () => setScenarioCollapsed(!$('panel-scenario').classList.contains('collapsed')));
  $('scenarioToggle').addEventListener('click', (e) => {
    if (isPhone() || e.target.closest('button, a')) return;
    setScenarioCollapsed(!$('panel-scenario').classList.contains('collapsed'));
  });

  /* ---------- property check: one spot, every answer the app has */

  // Road edges under more than 0.3 m of water in the current run
  function closedEdges(d) {
    const run = state.run, a = state.a;
    if (state.routeCache && state.routeCache.run === run && state.routeCache.d === d) return state.routeCache.closed;
    const net = d.net, closed = new Uint8Array(net.edges.length);
    const deep = (c) => c >= 0 && run.wet[c] && !(a.ocean && a.ocean[c]) && run.depth[c] >= 0.3;
    net.edges.forEach(([u, v], k) => {
      for (let t = 0; t <= 4 && !closed[k]; t++) {
        const f = t / 4;
        if (deep(cellOf(net.lat[u] + (net.lat[v] - net.lat[u]) * f, net.lon[u] + (net.lon[v] - net.lon[u]) * f))) closed[k] = 1;
      }
    });
    state.routeCache = { run, d, closed };
    return closed;
  }
  const EVAC = 'Evacuation centre';
  // The shortest dry route by road from a spot to the edge of the model and
  // to the nearest dry evacuation centre (Dijkstra over the road network)
  function routeOut(lat, lon) {
    const area = state.areaKey && areaReg.get(state.areaKey), d = area && area.impact, a = state.a, g = state.geo;
    if (!d || d.error || !d.net || !d.net.lat.length) return null;
    const net = d.net, nN = net.lat.length, closed = closedEdges(d), run = state.run;
    const nodeWet = (n) => { const c = cellOf(net.lat[n], net.lon[n]); return c >= 0 && run.wet[c] && run.depth[c] >= 0.3 && !(a.ocean && a.ocean[c]); };
    const km = (u, v) => Math.hypot((net.lon[v] - net.lon[u]) * 111.32 * Math.cos((net.lat[u] * Math.PI) / 180), (net.lat[v] - net.lat[u]) * 110.574);
    let start = -1, best = Infinity;
    for (let n = 0; n < nN; n++) {
      const dd = (net.lat[n] - lat) ** 2 + ((net.lon[n] - lon) * Math.cos((lat * Math.PI) / 180)) ** 2;
      if (dd < best) { best = dd; start = n; }
    }
    const startKm = Math.sqrt(best) * 111;
    if (start < 0 || startKm > 0.5) return { none: true };
    const adj = Array.from({ length: nN }, () => []);
    net.edges.forEach(([u, v, ri], k) => { if (!closed[k]) { adj[u].push([v, ri]); adj[v].push([u, ri]); } });
    const mx = ((g.east - g.west) / a.W) * 3, my = ((g.north - g.south) / a.H) * 3;
    const isExit = (n) => net.lat[n] < g.south + my || net.lat[n] > g.north - my || net.lon[n] < g.west + mx || net.lon[n] > g.east - mx;
    // evacuation centres: their nearest road node
    const centres = d.sites.filter((x) => x.kind === EVAC).map((x) => {
      let nb = -1, bd = Infinity;
      for (let n = 0; n < nN; n++) { const dd = (net.lat[n] - x.lat) ** 2 + (net.lon[n] - x.lon) ** 2; if (dd < bd) { bd = dd; nb = n; } }
      return { ...x, node: nb, flooded: (() => { const c = cellOf(x.lat, x.lon); return c >= 0 && run.wet[c] && run.depth[c] >= 0.15; })() };
    });
    const centreAt = new Map(centres.filter((x) => !x.flooded && x.node >= 0).map((x) => [x.node, x]));
    const dist = new Float64Array(nN).fill(Infinity), prev = new Int32Array(nN).fill(-1), via = new Int32Array(nN).fill(-1);
    const heap = new F._internal.MinHeap(net.edges.length * 2 + 4);
    if (!nodeWet(start)) { dist[start] = 0; heap.push(0, start); }
    let exitNode = -1, centreNode = -1;
    while (heap.n) {
      const u = heap.pop();
      if (exitNode < 0 && isExit(u)) exitNode = u;
      if (centreNode < 0 && centreAt.has(u)) centreNode = u;
      if (exitNode >= 0 && (centreNode >= 0 || !centreAt.size)) break;
      for (const [v, ri] of adj[u]) {
        if (nodeWet(v)) continue;
        const nd = dist[u] + km(u, v);
        if (nd < dist[v]) { dist[v] = nd; prev[v] = u; via[v] = ri; heap.push(nd, v); }
      }
    }
    const path = (t) => {
      if (t < 0) return null;
      const pts = [], names = [];
      for (let n = t; n >= 0; n = prev[n]) {
        pts.push([net.lat[n], net.lon[n]]);
        const nm = via[n] >= 0 && d.roads[via[n]] ? d.roads[via[n]].name : '';
        if (nm && names[names.length - 1] !== nm) names.push(nm);
      }
      return { km: dist[t], pts: pts.reverse(), via: names.reverse().slice(0, 4) };
    };
    return { startKm, toExit: path(exitNode), toCentre: centreNode >= 0 ? Object.assign(path(centreNode), { name: centreAt.get(centreNode).name }) : null,
      centres: centres.length, centresFlooded: centres.filter((x) => x.flooded).length };
  }
  function drawRoute(r) {
    const L = window.L;
    if (state.routeLayer) state.routeLayer.clearLayers(); else if (state.lmap) state.routeLayer = L.layerGroup().addTo(state.lmap);
    if (!r || !state.routeLayer) return;
    if (r.toExit) L.polyline(r.toExit.pts, { color: '#1b7837', weight: 4, opacity: 0.9, dashArray: '8 6' }).bindTooltip('Dry route out of the model area').addTo(state.routeLayer);
    if (r.toCentre) L.polyline(r.toCentre.pts, { color: '#1b7837', weight: 5, opacity: 0.95 }).bindTooltip(`Dry route to ${r.toCentre.name}`).addTo(state.routeLayer);
  }
  // The gauge level at which this spot first gets wet (binary search)
  function floodsAtLevel(c) {
    const a = state.a;
    if (state.gauge < 0 || ctl.floodType.value === 'flash') return null;
    const base = scenario(), lo0 = a.dem[state.gauge] + 0.3, hi0 = parseFloat(ctl.gaugeLevel.max) || lo0 + 10;
    const wetAt = (L) => { const r = dryLowGround(F.inundate(a, withRiverBelow(a, Object.assign({}, base, { gaugeLevel: L }), state.areaMeta), { slim: 1 }), state.base); return r.wet[c] && !(a.ocean && a.ocean[c]) && !(state.base && state.base.wet[c]); };
    if (wetAt(lo0)) return { level: lo0, always: true };
    if (!wetAt(hi0)) return { above: hi0 };
    let lo = lo0, hi = hi0;
    for (let k = 0; k < 12 && hi - lo > 0.02; k++) { const m = (lo + hi) / 2; if (wetAt(m)) hi = m; else lo = m; }
    return { level: hi, rise: hi - lo0 };
  }
  async function councilAt(lat, lon) {
    const out = [];
    await Promise.all(COUNCIL_OVERLAYS.filter((o) => o.type === 'feature' && o.test && kmBetween(o.test, [lat, lon]) < 150).map(async (o) => {
      try {
        const p = new URLSearchParams({ geometry: `${lon},${lat}`, geometryType: 'esriGeometryPoint', inSR: '4326', spatialRel: 'esriSpatialRelIntersects', outFields: '*', returnGeometry: 'false', f: 'json' });
        const j = await (await fetch(`${o.url}/query?${p}`)).json();
        for (const f of j.features || []) {
          const at = f.attributes || {};
          const text = ['RISK', 'OVL2_DESC', 'CAT_DESC', 'DESCRIPTION', 'LAYER'].map((k) => at[k]).find((v) => v && String(v).trim());
          out.push(`${o.name.replace(/ \(council\)$/, '')}${text ? `: ${text}` : ''}`);
        }
      } catch (err) { /* service down */ }
    }));
    return out;
  }
  async function checkProperty(lat, lon, label) {
    openPanel('panel-property');
    const box = $('propertyBox');
    const L = window.L, ll = L.latLng(lat, lon), hit = areaAt(ll);
    const name = label || `${Math.abs(lat).toFixed(4)}° S, ${lon.toFixed(4)}° E`;
    if (!hit) {
      box.innerHTML = `<p><strong>${escapeHtml(name)}</strong></p><p>No flood model covers this spot yet.</p><div class="link-row"><button type="button" class="btn small" id="propModel">Model flooding here</button></div>`;
      busyClick($('propModel'), 'Building the flood model…', () => modelHere(lat, lon, { name: label || 'This area' }));
      status.property = { inModel: false };
      rememberPropertyCheck(lat, lon, name);
      return status.property;
    }
    if (hit.key !== state.areaKey) activateArea(hit.key);
    await state.ready;
    const a = state.a, cc = latLngCell(ll), area = areaReg.get(state.areaKey);
    if (!a || !cc) return null;
    const c = cc.i, run = state.run;
    if (state.inertial && run) {
      const wet = run.wet[c] && !(a.ocean && a.ocean[c]);
      const hz = wet ? hazardNow() : null, cls = hz ? hz.cls[c] : 0;
      box.textContent = `Experimental 2D final depth: ${fmt(run.depth[c], 2)} m on a ${Math.round(state.inertial.cell)} m grid${wet ? `, hazard class H${cls || 6} from that cell's depth and water speed` : ''}. Gauge-level thresholds don't apply to this model.`;
      status.property = { inModel: true, depth: run.depth[c], hazard: wet ? (cls || 6) : null, model: 'local-inertial' };
      rememberPropertyCheck(lat, lon, name);
      return status.property;
    }
    box.innerHTML = `<p><strong>${escapeHtml(name)}</strong> · in ${hit.n}. ${escapeHtml(hit.name)}</p><p class="hint">Working it out…</p>`;
    if (area.impact == null) { try { await countImpact(); } catch (err) { /* counted without roads */ } }
    const d = area.impact && !area.impact.error ? area.impact : null;
    const wet = run.wet[c] && !(a.ocean && a.ocean[c]), depth = wet ? run.depth[c] : 0;
    const hz = wet ? hazardNow() : null, cls = hz ? hz.cls[c] : 0;
    // the nearest mapped building, for water over the floor
    let bi = -1;
    if (d) { let bd = Infinity; for (let i = 0; i < d.bx.length; i++) { const dd = (d.by[i] - lat) ** 2 + ((d.bx[i] - lon) * Math.cos((lat * Math.PI) / 180)) ** 2; if (dd < bd) { bd = dd; bi = i; } } if (Math.sqrt(bd) * 111000 > 30) bi = -1; }
    const noFloorHere = $('floorUnknown') && $('floorUnknown').checked;
    const floorH = noFloorHere ? null : parseFloat($('floorHeight').value);
    const lines = [];
    lines.push(wet
      ? `<strong>In this scenario:</strong> ${fmt(depth, 2)} m of water${bi >= 0 && floorH != null ? (depth > floorH ? `, about <strong>${fmt(depth - floorH, 2)} m over the floor</strong> of the building here (floor ${fmt(floorH, 1)} m up)` : ', below the floor of the building here') : (bi >= 0 ? ', floor height not surveyed (set it under What\u2019s affected to see water over the floor)' : '')}; hazard <strong>H${cls}</strong> (${HAZARD_TEXT[cls - 1]}).`
      : `<strong>In this scenario:</strong> dry${bi >= 0 ? ' (a mapped building is here)' : ''}.`);
    const lvl = floodsAtLevel(c);
    if (lvl) {
      lines.push(lvl.always ? 'Wet even at the river\'s normal level (a channel, lake or low spot).'
        : lvl.above ? `Stays dry up to the highest level the slider allows (${fmt(lvl.above, 2)} m at the gauge).`
          : `<strong>Floods when the gauge reaches about ${fmt(lvl.level, 2)} m</strong>, ${fmt(lvl.rise, 2)} m above its normal level.`);
      status.propertyLevel = lvl.level || null;
    }
    // flood over time, if run: when it gets wet, and when it is cut off
    const tl = area.timeline;
    let arrivalText = null, offlineText = null;
    if (tl && tl.wetBits) {
      let k0 = -1;
      for (let k = 0; k < tl.steps; k++) if (tl.wetBits[k * tl.wordsPerStep + (c >>> 5)] & (1 << (c & 31))) { k0 = k; break; }
      const toH = (k) => Math.round(tl.t0 + k * tl.step), when = (h) => (tl.event ? fmtWhen(tl.event, h) : hoursLabel(h));
      const iso = bi >= 0 && tl.access && tl.access.firstIso ? tl.access.firstIso[bi] : -1;
      arrivalText = k0 >= 0 ? `water arrives ${when(toH(k0))}` : 'stays dry';
      offlineText = iso >= 0 ? `cut off from ${when(toH(iso))} for about ${Math.round(tl.access.isoSteps[bi] * tl.step)} h` : null;
      lines.push(`<strong>Over time:</strong> ${arrivalText}${offlineText ? `; ${offlineText}` : ''}.`);
    }
    // roads out
    const route = d ? routeOut(lat, lon) : null;
    drawRoute(route);
    if (route && !route.none) {
      const r1 = route.toExit, r2 = route.toCentre;
      lines.push(r1 ? `<strong>Road out:</strong> a dry route leaves the model area after ${fmt(r1.km, 1)} km${r1.via.length ? ` (${escapeHtml(r1.via.join(', '))})` : ''} (dashed green).`
        : '<strong>Road out:</strong> <strong>cut off</strong>: no dry road leaves the model area in this scenario.');
      if (route.centres) lines.push(r2 ? `<strong>Evacuation centre:</strong> ${escapeHtml(r2.name)}, ${fmt(r2.km, 1)} km by dry roads (solid green).${route.centresFlooded ? ` ${route.centresFlooded} of ${route.centres} mapped centres here are flooded.` : ''}`
        : `<strong>Evacuation centre:</strong> none of the ${route.centres} mapped here can be reached by dry roads.`);
      else lines.push('<span class="hint">No evacuation centres are mapped in OpenStreetMap in this area; check your council\'s disaster dashboard.</span>');
    }
    box.innerHTML = `<p><strong>${escapeHtml(name)}</strong> · in ${hit.n}. ${escapeHtml(hit.name)}</p>${lines.map((x) => `<p>${x}</p>`).join('')}<p class="hint" id="propSlow">Checking recorded floods and council maps…</p>`;
    status.property = { inModel: true, depth: +depth.toFixed(2), hazard: cls, floodsAt: lvl && lvl.level ? +lvl.level.toFixed(2) : null,
      route: route && !route.none ? { exitKm: route.toExit ? +route.toExit.km.toFixed(2) : null, centre: route.toCentre ? route.toCentre.name : null, centres: route.centres } : null,
      arrival: arrivalText, offline: offlineText };
    // slower: recorded flood outlines and council layers
    const extra = [];
    try {
      if (!area.recorded) await findRecorded();
      for (const rec of area.recorded || []) {
        try { const m = await recordedMask(rec); if (m.flood[c]) extra.push(`Inside the recorded ${escapeHtml(rec.name)}.`); } catch (err) { /* skip */ }
      }
      if (area.recorded && area.recorded.length && !extra.length) extra.push(`Outside the ${area.recorded.length} recorded flood outline${area.recorded.length === 1 ? '' : 's'} found here.`);
    } catch (err) { /* no recorded floods */ }
    const council = await councilAt(lat, lon);
    if (council.length) extra.push(`Council maps: ${council.map(escapeHtml).join('; ')}.`);
    const slow = $('propSlow');
    if (slow) slow.outerHTML = extra.length ? extra.map((x) => `<p>${x}</p>`).join('') : '<p class="hint">No recorded flood outlines or council flood maps cover this spot in the sources the app knows.</p>';
    status.property.recorded = extra.filter((x) => x.startsWith('Inside')).length;
    status.property.council = council.length;
    rememberPropertyCheck(lat, lon, name);
    return status.property;
  }
  window.__floodCheckProperty = checkProperty;

  // Versions: this app's build, and the broker's (its /health page): which
  // commit each runs, so a report says what it was seen on.
  const REPO = 'https://github.com/ghedwards/flood-explorer';
  const commitLink = (sha) => (/^[0-9a-f]{7,40}$/.test(String(sha)) ? `<a href="${REPO}/commit/${escapeHtml(sha)}" target="_blank" rel="noopener">${escapeHtml(String(sha).slice(0, 8))}</a>` : escapeHtml(String(sha || 'dev')));
  async function checkBroker() {
    if (!BROKER) return null;
    try {
      const r = await fetch(`${BROKER}/health`, { cache: 'no-store', signal: AbortSignal.timeout(15000) });
      brokerInfo = r.ok ? await r.json() : { error: `HTTP ${r.status}` };
    } catch (err) { brokerInfo = { error: err && err.name === 'TimeoutError' ? 'timed out' : String(err && err.message || err) }; }
    brokerInfo.checkedAt = new Date().toISOString();
    renderVersions();
    return brokerInfo;
  }
  function renderVersions() {
    const box = $('versionInfo');
    if (!box) return null;
    const app = `App ${commitLink(APP_BUILD)}${APP_BUILT_AT ? `, built ${escapeHtml(when(APP_BUILT_AT))}` : ''}`;
    let brk;
    if (!BROKER) brk = 'no live data broker set for this build';
    else if (!brokerInfo) brk = 'Broker: checking…';
    else if (brokerInfo.error) brk = `Broker: not answering (${escapeHtml(brokerInfo.error)})`;
    else {
      const rd = brokerInfo.readings || {};
      const from = { 's3-gz': 'started from the stored zipped copy', s3: 'started from the stored copy (zipped again on start)', refresh: 'fetched them itself' }[rd.loadedFrom];
      brk = `Broker ${commitLink(brokerInfo.version)}${rd.fetched ? `, readings fetched ${escapeHtml(when(rd.fetched))}` : ''}${from ? ` (${escapeHtml(from)})` : ''}`;
    }
    box.innerHTML = `${app}. ${brk}. Readings on this map: ${escapeHtml((typeof nat !== 'undefined' && nat.readingsSource) === 'runtime' ? (nat.readingsSaved ? 'saved from your last visit, checking for newer' : 'live, from the broker') : "the site build's copy")}.`;
    status.versions = { app: APP_BUILD, builtAt: APP_BUILT_AT || null, broker: brokerInfo ? (brokerInfo.version || null) : null, brokerError: brokerInfo ? (brokerInfo.error || null) : null, loadedFrom: brokerInfo && brokerInfo.readings ? brokerInfo.readings.loadedFrom : null };
    return status.versions;
  }
  // once the page has settled (it also wakes the broker if it's asleep)
  setTimeout(() => { renderVersions(); checkBroker(); }, 4000);
  window.__floodVersions = async () => { await checkBroker(); return renderVersions(); };

  // The live data, source by source: when the broker last fetched each part
  // and the newest reading in it (recorded time), with the refresh's errors.
  function liveSourcesHtml() {
    const r = nat.readings;
    if (!r || nat.readingsSource !== 'runtime') return '';
    const newest = (kind) => {
      let best = null;
      for (const x of Object.values(r.level || {})) if (x && x.latestKind === kind && x.latest) { const t = Date.parse(x.latest[0]); if (Number.isFinite(t) && (!best || t > best.t)) best = { t, iso: x.latest[0] }; }
      return best;
    };
    const count = (kind) => Object.values(r.level || {}).filter((x) => x && x.latestKind === kind).length;
    const src = (k) => (r.sources && r.sources[k]) || null;
    const row = (name, key, fetched, extra) => {
      const s = src(key);
      const good = (s && s.lastGood) || fetched;
      const err = s && s.errorCount ? ` · ${s.errorCount} error${s.errorCount === 1 ? '' : 's'}${s.lastError ? ` (${escapeHtml(String(s.lastError).slice(0, 120))})` : ''}` : '';
      return `<li><strong>${escapeHtml(name)}</strong> <span class="hint">${good ? `last good ${escapeHtml(when(good))}` : 'not fetched yet'}${extra ? ` · ${extra}` : ''}${err}</span></li>`;
    };
    const nr = (kind) => { const b = newest(kind); return b ? `${count(kind).toLocaleString('en-AU')} gauges, newest reading ${escapeHtml(when(b.iso))}` : 'none'; };
    const errs = (r.errors || []).slice(0, 4);
    const rows = [
      row('Bureau river levels (FTP, hourly)', 'floodclass', r.floodclassFetched || r.fetched, nr('bureau')),
      row('Queensland live levels', 'qld', r.fetched, nr('realtime')),
      row('Water Data Online levels', 'wdo', r.wdoFetched || r.fetched, `${nr('hourly')}; daily: ${count('daily').toLocaleString('en-AU')} gauges`),
      row('Flood warnings (Bureau)', 'warnings', r.warningsFetched, `${((r.warnings && r.warnings.warnings) || []).length} current`),
      row('Flood warning areas (Bureau)', 'warningAreas', r.warningsFetched, `${((r.warnings && r.warnings.warnings) || []).filter((w) => (w.polygons || []).length).length} with outlines`),
      row('Flood classes (Bureau)', 'floodclass', r.floodclassFetched, `${Object.keys(r.floodclass || {}).length.toLocaleString('en-AU')} gauges`),
      row('Rain forecast (Open-Meteo)', 'rain', r.rainFetched, `${Object.keys(r.rain || {}).length.toLocaleString('en-AU')} gauges`),
      row('Storm tide (Qld)', 'sea', r.seaFetched, `${Object.keys(r.sea || {}).length} gauges`),
    ];
    return `<p class="hint"><strong>Live data</strong> (the broker, every 15 minutes): last fetch ${escapeHtml(when(r.fetched))}.</p><ul class="data-status">${rows.join('')}</ul>${errs.length ? `<p class="hint">Problems in the last fetch: ${errs.map(escapeHtml).join('; ')}</p>` : ''}<p class="hint"><strong>Site build</strong></p>`;
  }

  // What each data source returned in the latest build (data/status.json)
  async function renderDataStatus() {
    const box = $('dataStatus');
    if (!box) return null;
    // the live part needs no network: show it at once, then the build's
    // status file (at most 8 s: a stalled request mustn't leave "Loading…")
    let live;
    try { live = liveSourcesHtml(); } catch (e) { live = `<p class="hint">Live data: couldn't list it (${escapeHtml(String(e && e.message || e))}).</p>`; }
    box.innerHTML = `${live}<p class="hint">Loading the site build's status…</p>`;
    let st, why = '';
    try {
      const r = await fetch('data/status.json', { cache: 'no-cache', signal: AbortSignal.timeout(8000) });
      st = r.ok ? await r.json() : null;
      if (!r.ok) why = `HTTP ${r.status}`;
    } catch (err) { st = null; why = err && err.name === 'TimeoutError' ? 'it took too long; try again' : String(err && err.message || err); }
    if (!st || !st.sources) { box.innerHTML = `${live}<p class="hint">The site build's status couldn't be loaded${why ? ` (${escapeHtml(why)})` : ''}.</p>`; return null; }
    const label = { ok: 'OK', cached: 'From an earlier build', problem: 'Problem', missing: 'Not available' };
    const when = (iso) => (iso ? new Date(iso).toLocaleString('en-AU', { day: 'numeric', month: 'short', year: 'numeric', hour: 'numeric', minute: '2-digit' }) : '');
    const engine = F.engine === 'rust' ? 'Rust, compiled to WebAssembly' : (F.engine === 'error' ? 'WebAssembly failed to load (the flood model is unavailable)' : 'WebAssembly');
    box.innerHTML = `${liveSourcesHtml()}<p class="hint">Built ${escapeHtml(when(st.built))}. Flood model running in ${engine}.</p>${st.sources.map((s) => `<li class="st-${escapeHtml(s.state)}">
      <strong>${escapeHtml(s.name)}</strong> <span class="st-badge">${escapeHtml(label[s.state] || s.state)}</span><br>
      <span class="hint">${escapeHtml(s.summary)}${s.fetched ? ` · data from ${escapeHtml(when(s.fetched))}` : ''} · for ${escapeHtml(s.feeds)}</span></li>`).join('')}</ul>`;
    status.dataStatus = st.sources.map((s) => `${s.name}: ${s.state}`);
    return status.dataStatus;
  }
  $('dataStatusBox').addEventListener('toggle', () => { if ($('dataStatusBox').open) renderDataStatus(); });
  window.__floodDataStatus = renderDataStatus;
  function openPanel(id) {
    if (id === 'panel-forecast' && typeof renderWatch === 'function' && nat.readings) renderWatch();   // your places may have changed
    const target = $(id);
    if (!target) return;
    if (id === 'panel-scenario') target.classList.remove('collapsed');
    document.querySelectorAll('[data-panel]').forEach((p) => {
      if (p === target) return;
      if (isPhone() || p.dataset.side === target.dataset.side) p.hidden = true;
    });
    target.hidden = false;
    syncPanels();
    if (id === 'panel-profile' && state.run) drawProfile(scenario());
  }

  function closePanel(id) {
    if (id === 'panel-scenario' && !isPhone()) { setScenarioCollapsed(true); return; }
    $(id).hidden = true;
    syncPanels();
  }
  // keyboard: Escape closes the open (non-scenario) panel
  window.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    const open = Array.from(document.querySelectorAll('[data-panel]')).find((p) => !p.hidden && p.id !== 'panel-scenario');
    if (open) { closePanel(open.id); e.preventDefault(); }
  });
  // timeline keyboard: space plays/pauses, arrows step
  const tlSlider = $('tlSlider');
  if (tlSlider) {
    tlSlider.addEventListener('keydown', (e) => {
      if (e.key === ' ') {
        e.preventDefault();
        const btn = $('playTimeline');
        if (btn) btn.click();
      }
    });
  }

  function syncPanels() {
    if (!isPhone()) $('panel-scenario').hidden = false;
    document.querySelectorAll('.tool[data-open]').forEach((b) => {
      const p = $(b.dataset.open);
      b.setAttribute('aria-pressed', String(!p.hidden && !p.classList.contains('collapsed')));
    });
    document.body.classList.toggle('sheet-open', !!document.querySelector('[data-panel]:not([hidden])'));
  }

  document.querySelectorAll('[data-open]').forEach((b) => {
    b.addEventListener('click', () => {
      const id = b.dataset.open;
      const shown = !$(id).hidden && !$(id).classList.contains('collapsed');
      if (b.classList.contains('tool') && shown) closePanel(id);
      else openPanel(id);
    });
  });
  document.querySelectorAll('[data-close]').forEach((b) => {
    b.addEventListener('click', () => closePanel(b.closest('[data-panel]').id));
  });
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    const open = Array.from(document.querySelectorAll('[data-panel]:not([hidden])'));
    const right = open.find((p) => p.dataset.side === 'right');
    const target = right || (isPhone() ? open[0] : null);
    if (target) closePanel(target.id);
  });
  window.__floodOpenPanel = openPanel;
  window.__floodCouncilLayers = () => COUNCIL_OVERLAYS.map((o) => ({ name: o.name, test: o.test, minZoom: o.minZoom }));

  let sayT = 0;
  // The toast: gone after ~6 s; a failure (opts.error) stays until the next
  // message or a tap
  function say(text, opts) {
    const r = $('readout');
    r.textContent = text;
    r.hidden = !text;
    const bad = !!(opts && opts.error);
    r.classList.toggle('error', bad);
    if (bad) logProblem('message', text);
    clearTimeout(sayT);
    if (!bad) sayT = setTimeout(() => { r.hidden = true; }, 6000);
  }
  $('readout').addEventListener('click', () => { $('readout').hidden = true; });

  $('legendToggle').addEventListener('click', () => {
    const t = $('legendToggle'), shown = t.getAttribute('aria-expanded') === 'true';
    t.setAttribute('aria-expanded', String(!shown));
    if (shown) $('overlayLegend').hidden = true; else renderOverlayLegend();
    renderModeLegend();
  });

  // Phone sheets open at ~45 % of the screen so the map stays in view; the
  // grip drags them taller or shorter, a tap toggles tall.
  function addSheetGrips() {
    document.querySelectorAll('.sheet').forEach((sheet) => {
      const g = document.createElement('button');
      g.type = 'button'; g.className = 'sheet-grip'; g.setAttribute('aria-label', 'Resize panel');
      sheet.insertBefore(g, sheet.firstChild);
      let y0 = 0, h0 = 0, moved = false;
      g.addEventListener('pointerdown', (e) => { y0 = e.clientY; h0 = sheet.getBoundingClientRect().height; moved = false; g.setPointerCapture(e.pointerId); });
      g.addEventListener('pointermove', (e) => {
        if (!g.hasPointerCapture(e.pointerId)) return;
        const dy = y0 - e.clientY;
        if (Math.abs(dy) > 4) moved = true;
        if (moved) { sheet.classList.remove('tall'); sheet.style.height = `${Math.max(window.innerHeight * 0.25, Math.min(window.innerHeight - 140, h0 + dy))}px`; }
      });
      g.addEventListener('pointerup', () => { if (!moved) { sheet.style.height = ''; sheet.classList.toggle('tall'); } });
    });
  }

  /* -------------------------------------------------------------- start */

  (async function start() {
    ctl.bayLevel.value = 1.0;
    ctl.grad.value = 0.3;
    ctl.extra.value = 0;
    ctl.gaugeLevel.value = 4.46;
    syncOutputs();
    setPlacesCollapsed(isPhone());
    if (isPhone()) {
      $('panel-scenario').hidden = true;
      $('legendToggle').setAttribute('aria-expanded', 'false');   // the key starts collapsed on phones
      renderModeLegend();
    }
    addSheetGrips();
    syncPanels();
    renderPlaces();
    const areas = await listAreas();
    await loadFloodHub();
    await loadArea(areas[0].id);
    await restoreOnStart();
  })();
})();
