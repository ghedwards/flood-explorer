import './runtime-paths.js';
import './flood-wasm.js';
import { runDamBreak } from './dam-run.js';

// One dam failure per message: { plan, seconds }. Progress is posted while it runs; the answer is the run's extremes.
let stop = false;
self.onmessage = async ({ data }) => {
  if (data.type === 'cancel') { stop = true; return; }
  stop = false;
  try {
    await self.FloodCoreReady;
    if (!self.FloodCore.tsunamiStart) throw new Error('The dam-break model requires WebAssembly.');
    const result = runDamBreak(self.FloodCore, data.plan, { seconds: data.seconds, shouldStop: () => stop, onProgress: (progress) => self.postMessage({ progress }) });
    const { extremes } = result;
    self.postMessage({ result }, [extremes.peakDepth.buffer, extremes.peakSpeed.buffer, extremes.peakClass.buffer, extremes.arrival.buffer, result.water.buffer].filter((b, k, all) => all.indexOf(b) === k));
  } catch (error) {
    self.postMessage({ error: String(error.message || error) });
  }
};
