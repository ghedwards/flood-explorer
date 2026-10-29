import './runtime-paths.js';
import './flood-wasm.js';
import { runMember, startRun } from './tsunami-runner.js';

const begin = (data, report) => startRun(self.FloodCore, data, report);

const buffers = (frames, extremes = {}) => [...new Set([...frames.flatMap(frame => [frame.eta, frame.peak, frame.water, frame.speed]), ...Object.values(extremes)].filter(Boolean).map(v => v.buffer))];

self.onmessage = async ({ data }) => {
  try {
    await self.FloodCoreReady;
    if (!self.FloodCore.tsunamiStart) throw new Error('The tsunami prototype requires WebAssembly.');
    if (data.type === 'ensemble') {
      // Run each member to completion in turn, reporting each as it finishes.
      const cache = new Map(), started = Date.now();
      for (let index = 0; index < data.members.length; index++) {
        const member = data.members[index];
        const result = runMember(self.FloodCore, member, {
          ...data, cache, onProgress: progress => self.postMessage({ progress: { ...progress, index, count: data.members.length, elapsed: Date.now() - started, overall: (index + (progress.fraction || 0)) / data.members.length } }),
        });
        self.postMessage({ result: { id: member.id, ...result }, index });
      }
      self.postMessage({ done: true });
      return;
    }
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
      // what the run saw at its worst, kept by the solver every step (not just in the frames)
      const { peakValue, peakTime, peakSpeed, peakClass, arrival } = self.FloodCore.tsunamiStep(0, true), extremes = { peakValue, peakTime, peakSpeed, peakClass, arrival };
      self.postMessage({ frames, interval, coupling, extremes }, buffers(frames, extremes));
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
