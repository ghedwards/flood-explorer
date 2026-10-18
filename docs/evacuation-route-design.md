# Dry route to evacuation centres

## Problem

"Check this property" says whether a building is cut off and names the
nearest evacuation centres (flooded ones in red on the map), but doesn't
answer the actual question: *how do I get there from here, staying dry?*

## Research (what exists)

- Impact data (`computeScenarioImpact`) already builds a road graph
  `net.edges` with nodes keyed by lat/lon, computes per-scenario
  `dryNode[]` (nodes whose road segment is under the depth threshold)
  and `net.dryReach` (nodes that reach the model-area edge over dry
  roads) — `viewer/app.js` ~4690–4720.
- **A second, per-step graph exists** in `timelineAccess` (~5334):
  `exit[]`/`adj`/`edgeClosed` with `isoSteps` per building. The route
  in this note uses the final-scenario graph; a "route at the peak"
  variant is a natural follow-on reusing that machinery.
- Evacuation centres are OSM sites with `kind === EVAC` ('Evacuation
  centre', ~6009), each with lat/lon and a flooded flag in
  `r.sitesHit`.
- The nearest-road-node hash (`hs = 0.002` grid) exists in the same
  sweep and is reusable for snapping the property and each centre to
  nodes.
- Reachability per node is already per-run cached on `d` like the rest
  of the impact sweep.

## Design

1. In the impact sweep, keep a **parent-pointer BFS** over dry edges
   from the model-area border inwards (the same traversal that computes
   `dryReach` today, storing each node's parent instead of only the
   reachable flag). Cost: one extra Int32Array(nN), no new traversal.
2. "Check this property": if the property's nearest dry node is NOT
   reachable (isolated), report that plainly. If it IS reachable, find
   the **nearest evacuation centre whose own nearest dry node is
   reachable**, and reconstruct the node chain property → centre via
   parents, drawing it as a dashed polyline on `roadsLayer` (start pin,
   end pin, distance and rough drive time at 30–50 km/h in the tooltip
   and in the property text).
3. Cache the route on the run like the rest of the sweep
   (`d.cache.route`), redrawn with the existing `impactDrawn` change
   detection.
4. If no evacuation centre is mapped in the area, fall back to "no
   mapped evacuation centre; nearest dry road out of the area is X km"
   (the border-reaching node is already known).

## Failure behaviour

- Route computation is pure graph work over data already fetched — no
  new network calls, nothing to fail beyond what impact already handles.
- If the road graph is missing (OSM gap), the property report keeps its
  current wording.

## Test plan

- Unit-test the parent-BFS route on a tiny synthetic graph (dry vs
  flooded edges, centre behind a flooded road).
- Viewer smoke (manual/CI): run a 2D or fast model at Rockhampton,
  check a property, assert the route polyline exists and the distance
  text is present.
