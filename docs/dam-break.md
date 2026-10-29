# Dam failure (experimental)

A dam model (one started from a dam's report on the map) has a "Dam failure" section in the Scenario panel. The planning (reservoir, window, breach), the solver, the
discharge and the mapping of the result back onto the area model are all in Rust (`rust/flood-core/src/dam.rs`, run through the WebAssembly module as `damStart`, `damStep`
and `damFinish`); the page only passes the area model's arrays and the dam, and reports. It opens a breach through the dam wall and lets the
reservoir out over the terrain with the lab's nonlinear shallow-water solver (`rust/flood-core/src/inundation.rs`: wetting and drying, first-order Rusanov flux with
hydrostatic reconstruction), run in a worker (`viewer/dam-worker.js`). The result becomes the area's flood run, so the map, the counts of buildings, roads and people,
routes and the property check all use it, with hazard classes from the depth and speed the solver saw at their worst.

## What it assumes

- **The reservoir.** The elevation model shows a lake as a flat surface with no bed. The reservoir is the flat surface joined to the gauge (ground within 0.3 m of the
  lake level); it is given one level depth that holds the stored volume, capped by the wall's height. The volume offered is the dam's capacity times its latest reading
  (or full supply); you can change it. If the wall cannot hold that much, the model holds less and says so.
- **The wall.** The ground along the flow path from the reservoir's edge to the first cell 4 m or more below the lake (the same wall the river model finds).
- **The breach.** A straight cut through that wall, as wide as Froehlich's (1995) mean breach width `0.1803 K V^0.32 h^0.19` (K 1.4 for overtopping, 1.0 for piping),
  opening over his failure time `0.00254 V^0.53 h^-0.9` hours (V the volume in m3, h the depth of water above the breach bottom). The cut starts level with the lake
  (the water is at rest against it), then its bed is lowered linearly, from a minute into the run, to the lower of the reservoir bed and the ground below the wall. "Breach
  opens" scales the time by 0.5, 1 or 2.
- **The window.** At most 256 by 256 cells around the reservoir and 6 km of the way out, block-averaged to a coarser grid when that does not fit. A wall is thinner than a
  coarse cell, so the blocks touching the reservoir keep their highest ground until the breach cuts them. If the flood reaches the window's edge the result says so.
- **The run** is the breach's opening time plus an hour for the flood to pass, 1 to 6 hours. A 256 by 256 window runs at about 3.5 ms a step in WebAssembly.

## What it was checked against

- Ritter's dam-break discharge through a gap that opens at once: `q = (8/27) sqrt(g) h0^1.5` per metre, within 15% at first and second order
  (`inundation::tests::a_wall_that_gives_way_releases_ritters_discharge_and_records_the_worst_hazard`), and a slower opening gives a later, smaller peak.
- Water conservation (no boundary exchange): the volume error stays at rounding level through the run.
- Froehlich's peak outflow `0.607 V^0.295 h^1.24`: the solver's peak discharge (the reservoir's fall in volume over a minute) is shown beside it. On the test valley it was
  1.4 times Froehlich's figure; on the unit-test valley 0.8 to 2.5 times. Froehlich's own scatter is about that wide, so treat the solver's number as the same order, not a
  prediction.
- A reservoir on a coarse window does not leak before the breach opens.

## What it does not do

No dam-specific behaviour (spillways, gates, staged failure, a concrete dam's sudden collapse, a cascade of dams), no bed erosion or sediment, no bridges or culverts,
no friction beyond a single Manning n of 0.035, no sub-grid wall. The 30 m terrain smears the wall and the channel below it, and the first-order scheme smears the front
and under-predicts run-up. Treat arrival times, depths and the hazard classes as indicative: not a dam-break study, an emergency action plan or an evacuation guide.
