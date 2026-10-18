/* Flood Explorer background worker: runs the heavy flow analysis off the
 * page's main thread so building or reopening a model doesn't freeze it. */
import './runtime-paths.js';
import './flood-core.js';
import './flood-wasm.js';

self.onmessage = async (e) => {
  const { id, grid, opts, kind } = e.data;
  // the Rust model once it has loaded (the JavaScript one if it can't)
  if (self.FloodCoreReady) await self.FloodCoreReady;
  try {
    if (kind === 'timeline') {
      const tl = self.FloodCore.floodTimeline(e.data.a, e.data.s, opts);
      const bufs = [tl.firstWet, tl.lastWet, tl.firstDeep, tl.lastDeep, tl.wetCount, tl.gauge, tl.wetBits, tl.deepBits].map((x) => x.buffer);
      self.postMessage({ id, a: tl }, bufs);
      return;
    }
    const a = self.FloodCore.analyse(grid, opts);
    const transfer = new Set();
    for (const v of Object.values(a)) {
      if (ArrayBuffer.isView(v) && !transfer.has(v.buffer)) transfer.add(v.buffer);
    }
    self.postMessage({ id, a }, Array.from(transfer));
  } catch (err) {
    // tag wasm-engine problems so the app can show the unsupported card
    // instead of a per-area failure
    const engine = (self.FloodCore && self.FloodCore.engine) || 'error';
    let msg = String((err && err.message) || err);
    if (engine !== 'rust') msg = 'The flood model (WebAssembly) is not available: ' + msg;
    self.postMessage({ id, error: msg, engine });
  }
};
