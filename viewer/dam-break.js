/* A dam failure on one of the map's dam models. The planning, the solver, the discharge and the mapping of the result back onto the area model are all in Rust
 * (rust/flood-core/src/dam.rs, run through the WebAssembly module: FloodCore.damStart / damStep / damFinish). This file only has the words and the shape of the
 * answer the page needs. See docs/dam-break.md for what it assumes. */

// How the dam fails: Froehlich's K is 1.4 for overtopping and 1.0 for piping. `code` is what the Rust side takes.
export const BREACH_MODES = {
  overtopping: { label: 'Overtopping: wider breach', code: 0 },
  piping: { label: 'Piping: narrower breach', code: 1 },
};

// The plan in one line, from the numbers damStart returns.
export const damText = (plan) => `${(plan.volume / 1e6).toFixed(plan.volume < 1e7 ? 2 : 1)} million m³ held at ${plan.depth.toFixed(1)} m deep behind a ${Math.round(plan.wallHeight)} m wall; breach ${Math.round(plan.breachWidth)} m wide, opening over ${Math.round(plan.breachSeconds / 60)} min`;

// What damFinish gives, as a flood run for the impact tools (the shape of the 2D solver's expanded run).
export function floodRun(result) {
  const n = result.depth.length;
  return {
    depth: result.depth, wet: result.wet, level: result.level, wse: Float64Array.from(result.level), onPath: new Uint8Array(n), vx: new Float64Array(n), vy: new Float64Array(n),
    arrival: result.arrival, peakHazard: { cls: result.cls, vel: result.vel, km2: result.km2 }, covered: result.covered, edge: result.edge, dam: true,
  };
}
