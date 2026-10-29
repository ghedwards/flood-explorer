/* Running a dam failure to the end on a FloodCore-like `F` (the worker's, or a test's), in batches of solver steps. The solver, the planning and the discharge are in Rust;
 * this only calls them in turn and reports. `area` is { W, H, cell, dem, valid, ocean } and `params` the dam (see rust/flood-core/src/dam.rs, `Params`). */
export const STEPS_PER_BATCH = 25;

export function runDamBreak(F, area, params, { onPlan = () => {}, onProgress = () => {}, shouldStop = () => false } = {}) {
  const plan = F.damStart(area, params);
  onPlan(plan);
  let step = { time: 0 }, last = 0;
  const started = Date.now();
  while (step.time < plan.seconds) {
    if (shouldStop()) throw new Error('cancelled');
    step = F.damStep(STEPS_PER_BATCH);
    if (Date.now() - last > 150) { last = Date.now(); onProgress({ fraction: Math.min(1, step.time / plan.seconds), seconds: step.time, discharge: step.discharge, elapsed: last - started }); }
  }
  return { plan, result: F.damFinish(), peakDischarge: step.peakDischarge, peakDischargeAt: step.peakDischargeAt, volumeError: step.volumeError, seconds: step.time };
}
