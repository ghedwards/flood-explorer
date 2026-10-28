# Flash flooding by the 2D solver

## What the screening model does

Storm mode (`rust/flood-core/src/flash.rs`) does not move water. It gives every cell one downhill neighbour (D8: Whitebox flow-direction pointers when the
area has them, otherwise priority-flood depression filling then steepest descent), counts the cells draining through each, and turns that catchment into a depth
with formulas: creeks rise by the depth that carries their rational-method peak flow (Manning), spreading to connected lower land; cells whose own catchment gives
at least 10 cm of Manning depth on their slope are overland flow; filled depressions are filled to the level the runoff draining into them reaches; pipes take runoff from
built-up land first. Direction is fixed in advance, water never splits, and nothing depends on time.

## The 2D option

With the flood type set to Storm, *Method: 2D water movement (experimental)* runs the same storm through the local-inertial solver
(`rust/flood-core/src/inertial.rs`, Bates, Horritt and Fewtrell 2010), which moves water between cells from the slope of the water surface, so the direction
comes out of the terrain and the water already on it.

- **Rain.** `viewer/flash-2d.js` applies the screening model's two losses (initial and continuing) to each 10-minute step of the storm in turn and returns the effective rain in
  mm/h for each step, followed by zero steps so the water can drain (1, 2 or 4 hours; the page default is 2). The total runoff is exactly the screening model's excess rain
  (see the section on sub-hourly series below).
- **Deepest water.** The solver now records the deepest water each cell held (`Solver::peak`, returned with the final state as `peak`), and the map shows that, not the final
  depth: a flash flood drains away, so the final depth would show little. The result is labelled "deepest water over N hours" everywhere it is described, and files saved from it
  are named `2d-peak`.
- **Boundary.** Mapped sea cells are held at 0 m, so water that reaches the sea drains into it; an area with no sea cells has closed edges and water that reaches an edge stays there
  (the status line says which).
- **Grid.** The area's terrain is block-averaged to at most 96, 192 or 384 cells a side (`viewer/inertial-grid.js`; mixed valid and no-data blocks become walls).
- **Roughness.** One Manning n of 0.035 for the whole area (the screening model's overland value).

## Sub-hourly series, arrival times and hazard (added after the first version)

- **Series step.** `rain_series` and `inflow_series` were indexed by whole hours, so a 30-minute storm had to put all its rain in one hour and a dam-break hydrograph
  could not be represented. `Options::series_step_s` (default an hour) sets how long each entry lasts (1 s to 24 h). With a custom step the solver also shortens a time step
  to end exactly at a series boundary, so a short burst puts down exactly its volume (a test checks 36 mm/h for 10 minutes gives 6 mm, and a 0.2 m3/s inflow for
  10 minutes gives 120 m3). `viewer/flash-2d.js` now builds a series of 10-minute steps: the screening model's two losses are applied step by step, with continuing-loss
  capacity not used while the initial loss was soaking up the rain carried forward, so the total runoff is exactly the screening model's.
- **Arrival time.** `Solver::arrival` is the time from the start until each cell first held `arrival_depth` (default 10 cm, where flow becomes overland flow), -1 for a cell
  that never did; cells that start that deep arrive at 0. The map has a *time until flooded (2D storm)* colour mode (six bands from within 15 minutes to after 4 hours, darkest
  earliest, drawn by `render.rs` mode 3), the stats show when the first land cell floods, and "Check this property" says when water first reached 10 cm there.
- **Worst hazard.** At every step each wet cell (at least 1 cm, not a held sea cell) gets the AIDR 7-3 class of its depth and speed (`surface::hazard_class`, the same limits the
  rest of the app uses); `Solver::peak_class` keeps the worst and `peak_speed` the fastest flow. The hazard colour mode and its km2 per class use these for a storm run instead
  of the depth and speed at the end of the run, when the water has gone. The speed comes from the face discharges, so it is a cell-average of a slow-flow approximation.

## Limits

Stormwater pipes are not counted (the solver adds the same rain to every cell), nor are culverts, blockages or buildings as obstructions; rain is spread evenly in space and within each 10-minute step; the
terrain is the model's DEM, so features smaller than a cell are lost; the model has no advective momentum (it is a shallow, slow-flow approximation); and it is not validated against
recorded flash floods. Time is limited by a step budget of 200,000 steps and a run of up to 24 hours. About 5 seconds for 2,160 steps on a 95 x 95 grid, scaling with the number of cells.

## Tests

`inertial.rs` has a test that the peak is never below the final depth and is above it where water drained away, and that it starts at the initial water. `tests/flash-2d.test.js` checks the rain
series against the screening model's losses. `tests/impact-browser.js` runs a storm in the built bundle, in the real worker, and checks the run finishes, is labelled as a peak, conserves water, is dropped when
the storm changes, and that the screening model is restored.
