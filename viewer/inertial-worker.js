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
        const buffers = Array.from(new Set(
          ['depth', 'peak', 'peakSpeed', 'peakClass', 'arrival', 'vx', 'vy', 'snapDepth', 'snapTimes']
            .filter((k) => result[k] && result[k].buffer)
            .map((k) => result[k].buffer),
        ));
        self.postMessage({ result }, buffers);
      } else {
        self.postMessage({ progress: result.time / total });
        await new Promise((resolve) => setTimeout(resolve, 0));
      }
    } while (!result.done);
  } catch (error) {
    self.postMessage({ error: String(error.message || error) });
  }
};
