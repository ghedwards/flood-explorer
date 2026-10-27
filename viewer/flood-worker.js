/* Flood Explorer background worker: runs the heavy flow analysis off the
 * page's main thread so building or reopening a model doesn't freeze it. */
import './runtime-paths.js';
import './flood-wasm.js';

// Analyses this worker computed, kept resident: the wasm handle (created
// while the analysis was built) plus the small mask snapshots that scored
// checks need. The reply transfers the array buffers to the page, which
// detaches this side's copies — so the snapshots are taken before that.
let keySeq = 0;
const resident = new Map();   // key -> { h, W, H, cell, N, ocean, stream }

// Tell the page whether the model actually loaded in here. In dev the
// bundled `?url` import can fail; without this the app used to wait for a
// reply that never came (a silent hang). Any job posted before this
// settles still waits for FloodCoreReady below — that await must never
// throw past the try block, or the page would hang too.
self.FloodCoreReady.then(() => {
  if (self.FloodCore.engine !== 'rust') throw new Error(self.FloodCore.engine === 'error' ? 'the model failed to load in the worker' : `engine ${self.FloodCore.engine}`);
  self.postMessage({ workerStatus: 'ready', engine: 'rust' });
}).catch((e) => {
  self.postMessage({ workerStatus: 'error', error: String((e && e.message) || e) });
});

self.onmessage = async (e) => {
  const { id, grid, opts, kind } = e.data;
  // the Rust model once it has loaded; without it the app refuses to run.
  // Wrapped so a failed load rejects THIS job instead of wedging silently.
  try {
    if (self.FloodCoreReady) await self.FloodCoreReady;
  } catch (err) {
    self.postMessage({ id, error: `The model worker could not load WebAssembly: ${err && err.message ? err.message : err}` });
    return;
  }
  try {
    if (kind === 'timeline' && e.data.aKey != null && !resident.has(e.data.aKey)) {
      // the app still knows the key, but this worker doesn't (recreated); ask
      // it to post the full analysis object instead
      self.postMessage({ id, error: '__rekey__ resident analysis not found', engine: 'rust' });
      return;
    }
    async function postTimeline(id, tl) {
      // compress the per-step depth frames for transfer (~10x smaller on
      // mostly-empty water fields); deflate is available in every worker
      if (typeof CompressionStream !== 'undefined' && tl.depthFrames && tl.depthFrames.length) {
        const cs = new CompressionStream('deflate');
        const w = cs.writable.getWriter();
        w.write(tl.depthFrames); w.close();
        const r = cs.readable.getReader();
        const chunks = []; let total = 0;
        while (true) { const { done, value } = await r.read(); if (done) break; chunks.push(value); total += value.length; }
        const out = new Uint8Array(total);
        let off = 0;
        for (const c of chunks) { out.set(c, off); off += c.length; }
        tl.depthFrames = out;
        tl.depthFramesCompressed = true;
      } else {
        tl.depthFramesCompressed = false;
      }
      const bufs = [tl.firstWet, tl.lastWet, tl.firstDeep, tl.lastDeep, tl.wetCount, tl.gauge, tl.wetBits, tl.deepBits, tl.depthFrames, tl.depthFrameMax]
        .filter((x) => x && x.buffer).map((x) => x.buffer);
      self.postMessage({ id, a: tl }, bufs);
    }
    if (kind === 'timeline' && e.data.aKey != null && resident.has(e.data.aKey)) {
      // no 30–45 MB analysis clone or re-upload: run against the handle
      const src = self.FloodCore.byHandle(resident.get(e.data.aKey).h);
      const tl = self.FloodCore.floodTimeline(src, e.data.s, opts);
      await postTimeline(id, tl);
      return;
    }
    if (kind === 'timeline') {
      // no resident copy (older build): full analysis object posted
      const tl = self.FloodCore.floodTimeline(e.data.a, e.data.s, opts);
      await postTimeline(id, tl);
      return;
    }
    if (kind === 'calibrate') {
      // the recorded-flood level fit: the whole ~40-run scan happens here
      const R = e.data.aKey != null ? resident.get(e.data.aKey) : null;
      if (!R) throw new Error('no resident analysis to calibrate against');
      const stub = self.FloodCore.byHandle(R.h);
      const best = await self.FloodCore.calibrateLevels(stub, e.data.s0, e.data.m, e.data.bed,
        (s0, lv) => self.FloodCore.inundate(stub, Object.assign({}, s0, { gaugeLevel: lv }), { slim: 1 }));
      self.postMessage({ id, a: best });
      return;
    }
    const a = self.FloodCore.analyse(grid, opts);
    let key = null;
    if (self.FloodCore.engine === 'rust' && a && a.N && a.ocean && a.stream
      && typeof self.FloodCore.handleOf === 'function' && typeof self.FloodCore.byHandle === 'function') {
      key = ++keySeq;
      // `a` below is the lifetime anchor: the wasm analysis is dropped when
      // this worker-side object is collected (FinalizationRegistry), so the
      // resident entry must hold it or later keyed runs hit a freed handle
      resident.set(key, {
        h: self.FloodCore.handleOf(a), a, W: a.W, H: a.H, cell: a.cell, N: a.N,
        ocean: new Uint8Array(a.ocean),   // copied before the transfer detaches this side
        stream: new Uint8Array(a.stream),
      });
      while (resident.size > 4) resident.delete(resident.keys().next().value);
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
