/* Off the main thread: the 5 m flood picture (fine-raster.js), so panning
 * at street zoom stays smooth while it's worked out. The Rust version runs
 * when the module loads in here; the JavaScript one is the fallback. */
import './runtime-paths.js';
import './flood-core.js';
import './flood-wasm.js';
import { fineRaster } from './fine-raster.js';

self.onmessage = async (e) => {
  const { id, p } = e.data;
  try {
    try { await self.FloodCoreReady; } catch (err) { /* no module: use the JavaScript version */ }
    const rust = self.FloodCore && self.FloodCore.engine === 'rust' && typeof self.FloodCore.fineRaster === 'function';
    const t0 = performance.now();
    const { rgba, have } = rust ? self.FloodCore.fineRaster(p) : fineRaster(p);
    self.postMessage({ id, rgba, have, ms: performance.now() - t0, engine: rust ? 'rust' : 'js' }, [rgba.buffer]);
  } catch (err) {
    self.postMessage({ id, error: String((err && err.message) || err) });
  }
};
