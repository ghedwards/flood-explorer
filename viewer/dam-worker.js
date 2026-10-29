import './runtime-paths.js';
import './flood-wasm.js';
import { runDamBreak } from './dam-run.js';

// One dam failure per message: { area, params }. The plan is posted as soon as it is made, then progress, then the run's extremes on the area model's cells.
self.onmessage = async ({ data }) => {
  try {
    await self.FloodCoreReady;
    if (!self.FloodCore.damStart) throw new Error('The dam-break model requires WebAssembly.');
    const out = runDamBreak(self.FloodCore, data.area, data.params, { onPlan: (plan) => self.postMessage({ planned: plan }), onProgress: (progress) => self.postMessage({ progress }) });
    const r = out.result;
    self.postMessage({ result: out }, [r.depth.buffer, r.wet.buffer, r.level.buffer, r.arrival.buffer, r.cls.buffer, r.vel.buffer].filter((b, k, all) => all.indexOf(b) === k));
  } catch (error) {
    self.postMessage({ error: String(error.message || error) });
  }
};
