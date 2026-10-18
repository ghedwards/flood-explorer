# Hydrology polish: HAND and D8 flat cells

## Problem

Known accuracy residue from the parity ports: the HAND computation
leaves 8,173 unresolved cells on the Brisbane reference raster, and D8
flow routing has 387 flat/tie cells that differ from the reference by
tie-breaking. Both are edge cases, not systemic.

## Research

- HAND (height above nearest drainage) needs, for every cell, the
  downstream cell where the stream network begins; unresolved cells sit
  in flats/depressions where the routing chain never reaches a stream
  cell before exhausting the chain buffer.
- D8 ties happen when two neighbours have equal drop; the reference
  implementation picks by index order, our port matches 99.95% — the
  residue is where the reference's own tie order is data-dependent.
- Both matter for presentation (stray NaN in the HAND band) more than
  for the headline flood numbers.

## Design

1. **HAND fallback**: for unresolved cells, fall back to the nearest
   resolved cell (chamfer distance pass, the util already in
   flood-core) and flag them; the HAND band then renders complete with
   a documented approximation for < 0.2% of cells.
2. **D8 ties**: document the tie-break rule in the wasm bridge docs and
   the parity note instead of chasing bit-exactness on the residue —
   the reference's own behaviour there is arbitrary. If a future
   reference pins a rule, adopt it.
3. **Parity battery**: keep the current acceptance thresholds and add
   the fallback flag as a reported count so the residue is visible in
   CI output rather than silent.

## Test plan

- Parity battery unchanged (thresholds hold); new unit test for the
  chamfer fallback filling exactly the unresolved set.

## Effort

S (HAND fallback), D (docs-only for D8 ties).
