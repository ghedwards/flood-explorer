/* Off the main thread: the 5 m flood picture (rust/flood-core/src/fine.rs), so panning
 * at street zoom stays smooth while it's worked out. If the module does not load in here, the
 * job fails and the pool falls back to the main thread. */
import './runtime-paths.js';
import './flood-wasm.js';

self.onmessage = async (e) => {
  const { id, p } = e.data;
  try {
    await self.FloodCoreReady;
    if (!self.FloodCore || self.FloodCore.engine !== 'rust' || typeof self.FloodCore.fineRaster !== 'function') throw new Error('the flood module did not load in the worker');
    const t0 = performance.now();
    const { rgba, have } = self.FloodCore.fineRaster(p);
    self.postMessage({ id, rgba, have, ms: performance.now() - t0, engine: 'rust' }, [rgba.buffer]);
  } catch (err) {
    self.postMessage({ id, error: String((err && err.message) || err) });
  }
};
