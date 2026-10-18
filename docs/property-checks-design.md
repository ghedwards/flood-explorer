# Reported properties (property checks) — design

## Problem
`checkProperty()` renders everything about a property into a transient panel
and `status.property` (used only for data/status.json). Nothing is remembered:
no pin, no record, no place, and the share link / saved session do not keep
property checks. The only trace of a checked property is whatever transient
map layers it happened to draw (route lines, recorded-flood outlines).

## Design
Keep checked properties as first-class records, cheaply and additively:

1. `propertyChecks[]` in the viewer: one record per checked location,
   keyed by 1e-5-rounded lat/lon (re-checking the same spot updates it —
   latest result wins, `created`/`id` preserved on update only if absent).
   Record = `{ id, lat, lon, name, created, headline, snapshot }` where
   `snapshot` mirrors `status.property` (inModel, depth/hazard, floodsAt,
   route, recorded/council counts) and `headline` is a one-line summary.
2. Check finalisation paths all remember (`no model yet`, experimental 2D,
   full path after recorded-flood/council extras).
3. The Places card gains a **"Reported properties"** list (visible even when
   no places exist — a property check alone is enough reason to be there):
   open (re-run the check, zooming there), add as numbered place, rename,
   remove. These give visibility and management without touching the map.
4. Session/share persistence: `sessionState()` gains a `checks` array
   (additive, version stays 1); `restoreSession` re-inserts them without
   re-running the checks (snapshots are stored, not recomputed).
5. Out of scope: server-side storage, PDF export, editing the parent place —
   follow-ups if the list proves useful.

## Testing
- `node --check viewer/app.js`; `node --test tests/*.test.js` (49) stay green.
- Session round-trip via existing share/restore paths (manual + stored-state).
