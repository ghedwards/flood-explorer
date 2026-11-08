import './runtime-paths.js';
import './flood-wasm.js';

self.onmessage = async ({ data }) => {
  try {
    await self.FloodCoreReady;
    const core = self.FloodCore;
    if (!core.inertialStart) throw new Error('The 2D model requires WebAssembly.');
    const started = core.inertialStart(data.grid, data.opts);
    if (Number.isFinite(started.driftMeanRainMm) || Number.isFinite(started.radarSeconds)) self.postMessage({ started });
    const total = Number.isFinite(started.radarSeconds) ? started.radarSeconds : data.opts.seconds;
    let result;
    do {
      result = core.inertialStep();
      if (result.done) {
        self.postMessage({ result }, [result.depth.buffer, ...['peak', 'peakSpeed', 'peakClass', 'arrival', 'snapDepth', 'snapTimes'].filter((k) => result[k]).map((k) => result[k].buffer)]);
      } else {
        self.postMessage({ progress: result.time / total });
        await new Promise((resolve) => setTimeout(resolve, 0));
      }
    } while (!result.done);
  } catch (error) {
    self.postMessage({ error: String(error.message || error) });
  }
};
