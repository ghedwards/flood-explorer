# Arrival times in the Places list

## Status: mostly built — polish only

The property report already reads the timeline's per-cell wet/offline
bits (`viewer/app.js` ~6146): when a timeline exists, "Check this
property" reports *water arrives …* and *cut off from … for about … h*,
derived by scanning `tl.wetBits` for the first step the cell is wet and
`tl.access.isoSteps` for isolation. The share-link round-trip persists
the property check.

## Remaining gaps

1. **Places list** — the Places panel shows the saved property with its
   last check, but the arrival/offline times aren't surfaced there; open
   the report to see them. Add them as a small line in the place card
   (they are already in the persisted status).
2. **No-timeline case** — without a timeline the property report says
   nothing about timing. Add one line to the impact copy pointing at the
   timeline ("run the flood over time to see when water arrives") when a
   timeline would apply (river fast model only — not the 2D model, which
   has no timeline).
3. **2D runs** — the 2D solver has no time series (final state only), so
   timing stays unavailable there; make sure the copy doesn't imply it
   exists.

## Test plan

- Existing viewer tests cover the property slices; add an assertion that
  the place card renders the timing line when `status.property` carries
  arrival data.
