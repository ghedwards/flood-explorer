# Backwater Curve Water Surface — Design

## Problem
The water surface along the river is linear between control points (gauge,
level points, bay). Real flood profiles bend around constrictions, expansions
and tributary junctions, so the linear assumption misplaces inundation at
bends and narrows.

## Goal
Replace the linear stage-distance interpolation with a standard-step
gradually-varied-flow profile, so the water surface bends realistically
while still honouring the gauge/level-point/bay boundary conditions.

## Proposed model
Standard step method between cross-sections (one per grid cell along the
main stem):
  h_{i+1} = h_i + (S_f,i + S_f,i+1)/2 * dx + (V_{i+1}^2 - V_i^2)/(2g)
where S_f is friction slope (Manning) and V is mean velocity. Solve
iteratively for h at each section given Q (from the scenario's gauge level
via the rating curve or a wide-channel assumption).

Boundary conditions:
- Downstream end: h = bay level (or tide level).
- Upstream end / gauge: h = gauge level (or level point).
- Tributaries: junction as a downstream boundary with the tributary's
  computed stage.

## Implementation plan
- Rust: new module `backwater` in flood-core (or extend surface.rs):
  `stream_surface` calls `backwater_profile(a, s, sections)` instead of
  linear interpolation. Keep linear as fallback when data is missing.
- JS: mirror in viewer/flood-core.js.
- Cross-sections: derive from DEM along the main stem (width = channel
  cells at each chainage; area from depth).
- Update tests: water level at gauge/mouth still matches; monotonic flooding.

## Validation
- Hand-calc a simple rectangular channel (Manning) and compare.
- Parity Rust/JS.

## Status
Not started. Design pending review.
