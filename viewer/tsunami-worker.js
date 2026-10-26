import './runtime-paths.js';
import './flood-core.js';
import './flood-wasm.js';
import { forcingFromRecording, forcingFromSeries, levelSeries } from './tsunami-coupling.js';

self.onmessage = async ({ data }) => {
  try {
    await self.FloodCoreReady;
    if (!self.FloodCore.tsunamiStart) throw new Error('The tsunami prototype requires WebAssembly.');
    let coupling = null;
    if (data.type === 'start') {
      let grid = data.grid;
      if (data.coupling) {
        const { plan, parentGrid, seconds, localSeconds, series, scene, tide } = data.coupling;
        let forcing;
        if (series) {
          // A supplied wave series replaces the regional model.
          forcing = forcingFromSeries(scene, series, { maxLocalSeconds: localSeconds });
          coupling = { source: 'series', arrival: forcing.arrival, offset: 0, peak: forcing.peak, edges: forcing.edges, rows: series.times.length };
        } else {
          // Regional run first (about a second), then the local model starts
          // with its recorded wave as boundary forcing.
          const recording = self.FloodCore.tsunamiParent(parentGrid, plan.points, seconds);
          forcing = forcingFromRecording(plan, recording, { maxLocalSeconds: localSeconds });
          coupling = { source: 'regional', arrival: forcing.arrival, offset: forcing.offset, peak: forcing.peak, edges: forcing.edges, regionalSeconds: seconds, regionalPeak: Math.max(...recording.peak) };
        }
        grid = { ...grid, ...Object.fromEntries(Object.entries(forcing).filter(([key]) => key.startsWith('force'))), ...levelSeries(localSeconds, tide) };
        coupling.tide = tide || 0;
      }
      self.FloodCore.tsunamiStart(grid);
    }
    const frame = self.FloodCore.tsunamiStep(data.type === 'start' ? 0 : data.steps);
    // Aligned fields in the WASM output can share one backing buffer.
    const transfer = [...new Set([frame.eta, frame.peak, frame.water, frame.speed].filter(Boolean).map(v => v.buffer))];
    self.postMessage({ frame, coupling }, transfer);
  } catch (error) {
    self.postMessage({ error: String(error.message || error) });
  }
};
