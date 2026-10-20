/* Off the main thread: the 5 m flood picture (fine-raster.js), so panning
 * at street zoom stays smooth while it's worked out. */
import { fineRaster } from './fine-raster.js';

self.onmessage = (e) => {
  const { id, p } = e.data;
  try {
    const t0 = performance.now();
    const { rgba, have } = fineRaster(p);
    self.postMessage({ id, rgba, have, ms: performance.now() - t0 }, [rgba.buffer]);
  } catch (err) {
    self.postMessage({ id, error: String((err && err.message) || err) });
  }
};
