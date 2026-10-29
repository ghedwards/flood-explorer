/* Running a planned dam failure to the end on a FloodCore-like `F` (the worker's, or a test's): in batches, reporting progress, measuring the discharge out of the
 * reservoir (the fall in its volume over the last minute or so) as it goes, and finally collecting what the run saw at its worst (deepest water, fastest speed, worst hazard class, first arrival) from the solver,
 * which keeps these every step. */
import { solverGrid } from './dam-break.js';

export const STEPS_PER_BATCH = 25;
const DISCHARGE_WINDOW = 60;   // s: the discharge is the reservoir's fall in volume over about this long

// The run length for a plan: the breach's opening time, the start delay and an hour for the flood to pass through the window, in whole 10-minute steps, 1 to 6 hours.
export const runSeconds = (plan, extra = 3600) => Math.min(21600, Math.max(3600, Math.ceil((plan.breachStart + plan.breachSeconds + extra) / 600) * 600));

export function runDamBreak(F, plan, { onProgress = () => {}, shouldStop = () => false, seconds = plan.seconds } = {}) {
  F.tsunamiStart(solverGrid(plan));
  let frame = F.tsunamiStep(0), peakQ = 0, peakQAt = 0, last = 0;
  const started = Date.now(), cell2 = plan.cell * plan.cell, lake = [];
  for (let i = 0; i < plan.lake.length; i++) if (plan.lake[i]) lake.push(i);
  const held = (f) => { let v = 0; for (const i of lake) v += f.water[i]; return v * cell2; };
  const history = [{ time: frame.time, volume: held(frame) }];   // the reservoir's volume over the last minute or so
  while (frame.time < seconds) {
    if (shouldStop()) throw new Error('cancelled');
    frame = F.tsunamiStep(STEPS_PER_BATCH);
    history.push({ time: frame.time, volume: held(frame) });
    while (history.length > 2 && frame.time - history[1].time >= DISCHARGE_WINDOW) history.shift();
    const span = frame.time - history[0].time, q = span > 0 ? Math.max(0, (history[0].volume - history.at(-1).volume) / span) : 0;
    if (q > peakQ) { peakQ = q; peakQAt = frame.time; }
    if (Date.now() - last > 150) { last = Date.now(); onProgress({ fraction: Math.min(1, frame.time / seconds), seconds: frame.time, discharge: q, elapsed: last - started }); }
  }
  const final = F.tsunamiStep(1, true);
  return {
    extremes: { peakDepth: final.peakDepth, peakSpeed: final.peakSpeed, peakClass: final.peakClass, arrival: final.arrival },
    peakDischarge: peakQ, peakDischargeAt: peakQAt, seconds: final.time, volumeError: final.volumeError, water: final.water,
  };
}
