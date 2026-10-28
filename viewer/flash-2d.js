/* A storm as the 2D solver takes it: the rain that does not soak in, step by step. The screening flash-flood model takes a storm's rain less an
 * initial loss and a continuing loss per hour; this applies the same two losses to each short step of the storm in turn, so the 2D run and the
 * screening run start from the same runoff.
 * Steps are 10 minutes by default, so a 30-minute burst is three steps rather than all of its rain in an hour. */

export const MAX_RATE = 1000;      // mm/h, the solver's limit
export const STEP_SECONDS = 600;   // the length of one entry of the series

/* { series, seconds, stepSeconds, stormHours, rainMm, effectiveMm, capped }: `series[k]` is the effective rain rate (mm/h) for step k, ending with
 * zeros for `afterHours` more hours so the water can drain, and `seconds` the whole run. */
export function effectiveRainSeries({ rainMm, hours, initialLoss, contLoss }, afterHours = 2, stepSeconds = STEP_SECONDS) {
  if (!(rainMm >= 0) || !Number.isFinite(rainMm)) throw new Error('The storm\'s rain must be a number of millimetres from 0.');
  if (!(hours > 0 && hours <= 24)) throw new Error('A storm lasts up to 24 hours.');
  if (!(afterHours >= 0 && afterHours <= 6)) throw new Error('The run can continue for up to 6 hours after the rain.');
  if (!(stepSeconds >= 60 && stepSeconds <= 3600)) throw new Error('A series step is 1 to 60 minutes.');
  const stepHours = stepSeconds / 3600, stormSteps = Math.ceil(hours / stepHours - 1e-9);
  const after = Math.max(1, Math.round(afterHours / stepHours)), total = stormSteps + after, series = new Float64Array(total);
  // The ground can take its continuing loss from the start of the storm, so capacity not used while the initial loss was soaking up the rain is kept for
  // later steps; that makes the total loss the same as the screening model's (initial loss plus continuing loss times the storm's hours).
  let initial = Math.max(0, initialLoss || 0), bank = 0, effective = 0, capped = false;
  for (let k = 0; k < stormSteps; k++) {
    const overlap = Math.min(hours, (k + 1) * stepHours) - k * stepHours, rain = rainMm * overlap / hours;
    const absorbed = Math.min(rain, initial);
    initial -= absorbed;
    bank += Math.max(0, contLoss || 0) * overlap;
    const soaked = Math.min(rain - absorbed, bank);
    bank -= soaked;
    const mm = rain - absorbed - soaked;        // runoff in this step; the series entry holds for the whole step
    let rate = mm / stepHours;
    if (rate > MAX_RATE) { rate = MAX_RATE; capped = true; }
    series[k] = rate; effective += rate * stepHours;
  }
  return { series, seconds: total * stepSeconds, stepSeconds, stormHours: hours, rainMm, effectiveMm: effective, capped };
}

export const peakRate = (series) => Math.max(0, ...series);
