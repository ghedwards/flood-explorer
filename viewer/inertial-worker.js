import './runtime-paths.js';
import './flood-wasm.js';

self.onmessage = async ({ data }) => {
  try {
    await self.FloodCoreReady;
    const core = self.FloodCore;
    if (!core.inertialStart) throw new Error('The 2D model requires WebAssembly.');
    core.inertialStart(data.grid, data.opts);
    let result;
    do {
      result = core.inertialStep();
      if (result.done) {
        self.postMessage({ result }, [result.depth.buffer]);
      } else {
        self.postMessage({ progress: result.time / data.opts.seconds });
        await new Promise((resolve) => setTimeout(resolve, 0));
      }
    } while (!result.done);
  } catch (error) {
    self.postMessage({ error: String(error.message || error) });
  }
};
