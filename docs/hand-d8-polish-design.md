# Hydrology polish: HAND and D8 flat cells

## Problem

Known accuracy residue from the parity ports: the HAND computation
leaves 8,173 unresolved cells on the Brisbane reference raster, and D8
flow routing has 387 flat/tie cells that differ from the reference by
tie-breaking. Both are edge cases, not systemic.

## Research

- **HAND is not wired into the app.** `hand_simple` is defined and unit-tested
  in `rust/flood-core/src/hydro.rs` but is called nowhere in the wasm
  dispatch or the page — there is no HAND band in the UI (grep confirms
  no consumer). So the "HAND 98.86% parity" residue affects no user today.
- **D8 ties** happen when two neighbours have equal drop; the reference
  implementation picks by index order, our port matches 99.95% — the
  residue is where the reference's own tie order is data-dependent.
- Both matter for presentation (stray NaN in a HAND band) more than for
  the headline flood numbers.

## Design

1. **HAND: no action now.** Keep `hand_simple` defined and tested (it is
   ready for a future HAND band / floodplain-storage feature — see
   `floodplain-storage-design.md`). The chamfer fallback only earns its
   keep once a consumer exists; wiring it into `analyse` would change
   the parity battery's HAND checksums without any user-visible effect.
   Revisit when a HAND band ships.
2. **D8 ties: document, don't chase.** Record the tie-break rule in the
   wasm bridge docs and the parity note rather than bit-chasing the
   residue — the reference's own behaviour there is arbitrary. If a
   future reference pins a rule, adopt it.
3. **Parity battery**: keep the current acceptance thresholds and keep
   reporting the residue counts so the change is visible in CI output
   rather than silent.

## Test plan

- Parity battery unchanged (thresholds hold); new unit test for the
  chamfer fallback filling exactly the unresolved set.

## Effort

S (HAND fallback), D (docs-only for D8 ties).
