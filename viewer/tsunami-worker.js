import './runtime-paths.js';
import './flood-core.js';
import './flood-wasm.js';
import { forcingFromRecording, forcingFromSeries, levelSeries } from './tsunami-coupling.js';

// Start a run, first computing any nested forcing. Returns what the page shows
// about the coupling, or null for an ordinary run.
function begin(data, report) {
  let grid = data.grid, coupling = null;
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
      report({ stage: 'regional' });
      const recording = self.FloodCore.tsunamiParent(parentGrid, plan.points, seconds);
      forcing = forcingFromRecording(plan, recording, { maxLocalSeconds: localSeconds });
      coupling = { source: 'regional', arrival: forcing.arrival, offset: forcing.offset, peak: forcing.peak, edges: forcing.edges, regionalSeconds: seconds, regionalPeak: Math.max(...recording.peak) };
    }
    grid = { ...grid, ...Object.fromEntries(Object.entries(forcing).filter(([key]) => key.startsWith('force'))), ...levelSeries(localSeconds, tide) };
    coupling.tide = tide || 0;
  }
  self.FloodCore.tsunamiStart(grid);
  return { coupling, batch: grid.method === 3 ? 16 : 200 };
}

const buffers = frames => [...new Set(frames.flatMap(frame => [frame.eta, frame.peak, frame.water, frame.speed]).filter(Boolean).map(v => v.buffer))];

self.onmessage = async ({ data }) => {
  try {
    await self.FloodCoreReady;
    if (!self.FloodCore.tsunamiStart) throw new Error('The tsunami prototype requires WebAssembly.');
    if (data.type === 'precompute') {
      // Run the whole simulation now, keeping evenly spaced frames, and report
      // progress so the page can show how far along it is.
      const { coupling, batch } = begin(data, progress => self.postMessage({ progress }));
      const frames = [self.FloodCore.tsunamiStep(0)];
      const interval = data.seconds / data.frames;
      let next = interval, current = frames[0], reported = 0;
      const started = Date.now();
      self.postMessage({ progress: { stage: 'local', fraction: 0, seconds: 0 } });
      while (current.time < data.seconds) {
        const steps = Math.max(1, Math.min(batch, Math.ceil((Math.min(next, data.seconds) - current.time) / current.dt)));
        current = self.FloodCore.tsunamiStep(steps);
        if (current.time >= Math.min(next, data.seconds) - 1e-9) {
          frames.push(current);
          while (next <= current.time) next += interval;
        }
        if (Date.now() - reported > 120) {
          reported = Date.now();
          self.postMessage({ progress: { stage: 'local', fraction: Math.min(1, current.time / data.seconds), seconds: current.time, elapsed: reported - started } });
        }
      }
      if (frames.at(-1) !== current) frames.push(current);
      self.postMessage({ frames, interval, coupling }, buffers(frames));
      return;
    }
    let coupling = null;
    if (data.type === 'start') coupling = begin(data, () => {}).coupling;
    const frame = self.FloodCore.tsunamiStep(data.type === 'start' ? 0 : data.steps);
    self.postMessage({ frame, coupling }, buffers([frame]));
  } catch (error) {
    self.postMessage({ error: String(error.message || error) });
  }
};
