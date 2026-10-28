/* A storm as the 2D solver takes it: the rain that does not soak in, hour by hour. The screening flash-flood model takes a storm's rain less an
 * initial loss and a continuing loss per hour; this applies the same two losses to each hour of the storm in turn, so the 2D run and the
 * screening run start from about the same runoff (they differ by under a millimetre where the continuing loss exceeds the rain left in an hour). */

export const MAX_RATE = 1000;   // mm/h, the solver's limit

/* { series, seconds, stormHours, rainMm, effectiveMm, capped }: `series[k]` is the effective rain (mm/h) for hour k, ending with zeros for `afterHours`
 * more hours so the water can drain, and `seconds` the whole run. A storm shorter than an hour has all its rain in the first hour (the solver takes
 * hourly rain). */
export function effectiveRainSeries({ rainMm, hours, initialLoss, contLoss }, afterHours = 2) {
  if (!(rainMm >= 0) || !Number.isFinite(rainMm)) throw new Error('The storm\'s rain must be a number of millimetres from 0.');
  if (!(hours > 0 && hours <= 24)) throw new Error('A storm lasts up to 24 hours.');
  if (!(afterHours >= 0 && afterHours <= 6)) throw new Error('The run can continue for up to 6 hours after the rain.');
  const stormHours = Math.ceil(hours), total = stormHours + Math.max(1, Math.round(afterHours)), series = new Float64Array(total);
  let initial = Math.max(0, initialLoss || 0), effective = 0, capped = false;
  for (let k = 0; k < stormHours; k++) {
    const overlap = Math.min(hours, k + 1) - k, rain = rainMm * overlap / hours;
    const absorbed = Math.min(rain, initial);
    initial -= absorbed;
    const soaked = Math.min(rain - absorbed, Math.max(0, contLoss || 0) * overlap);
    let eff = rain - absorbed - soaked;
    if (eff > MAX_RATE) { eff = MAX_RATE; capped = true; }
    series[k] = eff; effective += eff;
  }
  return { series, seconds: total * 3600, stormHours, rainMm, effectiveMm: effective, capped };
}

export const peakRate = (series) => Math.max(0, ...series);
