/* Flood Explorer background worker: runs the heavy flow analysis off the
 * page's main thread so building or reopening a model doesn't freeze it. */
import './runtime-paths.js';
import './flood-core.js';
import './flood-wasm.js';

// Analyses this worker computed, kept resident: the wasm handle (created
// while the analysis was built) plus the small mask snapshots that scored
// checks need. The reply transfers the array buffers to the page, which
// detaches this side's copies — so the snapshots are taken before that.
let keySeq = 0;
const resident = new Map();   // key -> { h, W, H, cell, N, ocean, stream }

self.onmessage = async (e) => {
  const { id, grid, opts, kind } = e.data;
  // the Rust model once it has loaded; without it the app refuses to run
  if (self.FloodCoreReady) await self.FloodCoreReady;
  try {
    if (kind === 'timeline' && e.data.aKey != null && !resident.has(e.data.aKey)) {
      // the app still knows the key, but this worker doesn't (recreated); ask
      // it to post the full analysis object instead
      self.postMessage({ id, error: '__rekey__ resident analysis not found', engine: 'rust' });
      return;
    }
    if (kind === 'timeline' && e.data.aKey != null && resident.has(e.data.aKey)) {
      // no 30–45 MB analysis clone or re-upload: run against the handle
      const src = self.FloodCore.byHandle(resident.get(e.data.aKey).h);
      const tl = self.FloodCore.floodTimeline(src, e.data.s, opts);
      const bufs = [tl.firstWet, tl.lastWet, tl.firstDeep, tl.lastDeep, tl.wetCount, tl.gauge, tl.wetBits, tl.deepBits].map((x) => x.buffer);
      self.postMessage({ id, a: tl }, bufs);
      return;
    }
    if (kind === 'timeline') {
      // no resident copy (older build): full analysis object posted
      const tl = self.FloodCore.floodTimeline(e.data.a, e.data.s, opts);
      const bufs = [tl.firstWet, tl.lastWet, tl.firstDeep, tl.lastDeep, tl.wetCount, tl.gauge, tl.wetBits, tl.deepBits].map((x) => x.buffer);
      self.postMessage({ id, a: tl }, bufs);
      return;
    }
    if (kind === 'calibrate') {
      // the recorded-flood level fit: the whole ~40-run scan happens here
      const R = e.data.aKey != null ? resident.get(e.data.aKey) : null;
      if (!R) throw new Error('no resident analysis to calibrate against');
      const stub = self.FloodCore.byHandle(R.h);
      const best = self.FloodCore.calibrateLevels(R, e.data.s0, e.data.m, e.data.bed,
        (s0, lv) => self.FloodCore.inundate(stub, Object.assign({}, s0, { gaugeLevel: lv })));
      self.postMessage({ id, a: best });
      return;
    }
    const a = self.FloodCore.analyse(grid, opts);
    let key = null;
    if (self.FloodCore.engine === 'rust' && a && a.N && a.ocean && a.stream) {
      key = ++keySeq;
      resident.set(key, {
        h: self.FloodCore.handleOf(a), W: a.W, H: a.H, cell: a.cell, N: a.N,
        ocean: new Uint8Array(a.ocean),   // copied before the transfer detaches this side
        stream: new Uint8Array(a.stream),
      });
    }
    const transfer = new Set();
    for (const v of Object.values(a)) {
      if (ArrayBuffer.isView(v) && !transfer.has(v.buffer)) transfer.add(v.buffer);
    }
    self.postMessage({ id, a, key }, Array.from(transfer));
  } catch (err) {
    // tag wasm-engine problems so the app can show the unsupported card
    // instead of a per-area failure
    const engine = (self.FloodCore && self.FloodCore.engine) || 'error';
    let msg = String((err && err.message) || err);
    if (engine !== 'rust') msg = 'The flood model (WebAssembly) is not available: ' + msg;
    self.postMessage({ id, error: msg, engine });
  }
};
