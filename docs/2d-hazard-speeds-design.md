# 2D Hazard Speeds — Design

## Problem
Hazard speeds are estimated from depth and slope with fixed Manning roughness
(surface.rs hazard()). The inertial 2D solver computes water movement but does
not expose velocities, so hazard classes use a screening estimate.

## Goal
Use velocities from the local-inertial 2D solver for hazard classification
where a 2D run exists, instead of the depth+slope estimate.

## Proposed model
- Track a velocity field (vx, vy) in inertial::Solver (donor-cell fluxes).
- Expose `velocities()` returning (vx, vy) arrays.
- In hazard(), if a 2D run is available, use |v| = sqrt(vx^2+vy^2) per cell
  instead of the Manning estimate; fall back to Manning otherwise.

## Implementation plan
- Rust: add velocity tracking to inertial.rs; expose in wasm.
- JS: mirror in viewer/inertial-grid.js / viewer/flood-core.js.
- viewer/app.js: pass 2D velocities to hazard rendering when available.

## Status
Not started. Design pending review.
