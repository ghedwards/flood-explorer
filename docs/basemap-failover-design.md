# Basemap failover prompt

## Problem

When the active imagery service throttles (Esri 429/504s), the map goes
dark except for the last loaded zoom. We surface a warning (tile-failure
notice); the user still has to know that other basemaps are on different
endpoints and go find the Layers panel.

## Research

- Per-basemap tile health is already tracked: `status.basemaps[name] =
  { loaded, errors, streak }` updated from `tileload`/`tileerror`
  (`viewer/app.js` ~1525).
- `setBasemap(m, layers, name)` exists and is the single switch point
  (~1675); basemaps are listed with radio inputs in `buildLayerLists`.
- Idle basemaps don't load tiles (they aren't on the map), so their
  `st.loaded` says nothing about health — a health signal needs a probe.

## Design

1. When the failure notice fires (streak === 8 on the active basemap),
   the notice becomes **actionable**: append a button "Switch to
   <healthiest alternative>" next to the message.
2. Picking the alternative: among the other basemaps, prefer ones known
   healthy (recently active with `loaded > 0` and low error rate);
   otherwise **probe** the top candidates by fetching one cheap, static
   tile each (a low-zoom tile URL from the same service) with a 3 s
   timeout, and pick the first that answers 200. Probes run only when
   the notice shows (a failure state), so the extra requests are rare.
3. Switching uses `setBasemap`, which also persists the choice; the
   notice then shows a "tried to switch — reloading tiles" line if the
   probe-selected basemap also fails (guard against ping-pong: at most
   one automatic probe per failure episode).
4. Never switch automatically on the user's stored preference — offer,
   don't override. The exception (explicitly by design): none.

## Failure behaviour

- All probes fail: keep the plain warning text (network is down, not
  the imagery service).

## Test plan

- Unit: streak/probe selection logic extracted pure (given basemap
  health map → pick).
- Manual: block `server.arcgisonline.com` in devtools, confirm the
  notice gains the button and switching works.
