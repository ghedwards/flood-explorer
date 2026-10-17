# Measured Floor Heights — Design

## Problem
Water-above-floor counts use a single typical floor height (0.3 m slab, more for
raised Queenslanders). NSW councils publish floor-level surveys for individual
buildings; using them would sharpen the "water over floor" counts.

## Goal
Replace the single typical floor height with per-building measured floor levels
where available, falling back to the typical value otherwise.

## Data sources
- NSW councils publish floor level surveys (often as CSV/points) for some LGAs.
- Queensland: limited open floor-level data.

## Implementation plan
- Build step: collect council floor-level points into `data/floorheights.geojson`
  (lon, lat, floor_m).
- Viewer: spatial index of floor points; for each building in the impact count,
  look up nearest floor point within ~20 m; use its floor_m, else typical.
- Add a toggle in the Scenario panel: "Use measured floor heights where available".

## Status
Not started. Data collection is the blocker.
