import './runtime-paths.js';
import './flood-core.js';
import './flood-wasm.js';

self.onmessage = async ({ data }) => {
  try {
    await self.FloodCoreReady;
    if (!self.FloodCore.tsunamiStart) throw new Error('The tsunami prototype requires WebAssembly.');
    if (data.type === 'start') self.FloodCore.tsunamiStart(data.grid);
    const frame = self.FloodCore.tsunamiStep(data.type === 'start' ? 0 : data.steps);
    // Aligned fields in the WASM output can share one backing buffer.
    const transfer = [...new Set([frame.eta, frame.peak, frame.water, frame.speed].filter(Boolean).map(v => v.buffer))];
    self.postMessage({ frame }, transfer);
  } catch (error) {
    self.postMessage({ error: String(error.message || error) });
  }
};
