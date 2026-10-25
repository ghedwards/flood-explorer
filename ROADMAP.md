# Flood Explorer roadmap

Ideas for future refinement, roughly in order of value. Each says what it
would add, how it could be built from open data, and what to watch for.

## Needs an owner decision or access

- **Bureau of Meteorology flood warnings and flood class levels.** The app
  already shows them (Warnings panel, report flood classes, "Minor /
  Moderate / Major" buttons in Scenario), but the Bureau's website refuses
  requests from GitHub's servers (HTTP 403) and the warning files are not on
  its anonymous FTP server. Options:
  - a small scheduled job on a home or office computer (not a cloud
    server) that runs `flood floodinfo` and commits
    `floodclass.json` and `warnings.json` to the repo, or
  - a Bureau registered-user data feed, if one can be obtained.
- **Google Flood Hub forecasts.** Built in; add the API key as the repo
  secret `FLOOD_FORECASTING_API_KEY`.
- **Repository name.** Renaming to `flood-explorer` (Settings → General)
  moves the site to `ghedwards.github.io/flood-explorer/`. Repo links
  redirect; the old Pages address does not. Saved places carry over (same
  origin).

## Modelling

### Tsunami: data, coastal coupling and dispersive waves (25 Oct 2026)

The Rust/WASM prototype has two linear propagation methods and a separate
nonlinear local wetting/drying solver. Its bundled terrain, reference labels
and display overlays are described in [the prototype notes](docs/tsunami-prototype.md).
The present local pulse is hypothetical; offshore-to-estuary coupling is not
implemented. The following work is proposed, not completed:

1. **Verify terrain and water references.** Prefetch finer coastal LiDAR and
   nearshore/channel bed surveys, retain source coverage and uncertainty, and
   reconcile vertical datums before applying tide levels. Evaluate GA regional
   bathymetry and the [CSIRO Queensland estuary composite](https://doi.org/10.25919/1xzm-pw88), including their
   modelled rather than surveyed channel depths. Replace the single Manning
   resistance with supported land-cover classes only where resolution permits.
2. **Defined offshore forcing, tides and river flow.** Use identified
   [GA PTHA18 scenarios](https://www.ga.gov.au/scientific-topics/community-safety/data-and-products/ptha)
   or validated historical waveforms; drive local coastal boundaries with
   consistent time series instead of an arbitrary local dipole. Add tide levels
   with a verified datum conversion, upstream discharge and observed gauge
   series for validation. Preserve scenario IDs and distinguish illustrative
   runs from hazard estimates.
3. **Finer grids where needed.** Evaluate nested/coastal refinement with
   conservative exchange between offshore and estuary domains, plus a higher
   order, well-balanced, positivity-preserving nonlinear scheme to reduce
   numerical damping. [GeoClaw](https://www.clawpack.org/geoclaw.html) provides
   a useful reference for dry/wet shorelines and adaptive grids. Keep the
   browser worker responsive with bounded step batches and memory use.
4. **Optional dispersive-wave method — research, not started.** Dispersion
   means different wavelengths travel at different speeds, so a pulse can
   spread and change shape. The current shallow-water methods omit this
   wavelength-dependent physics; numerical diffusion in a solver is a
   different effect. Evaluate a Boussinesq-type solver in Rust/WASM alongside
   the existing methods, using [JAGURS](https://github.com/jagurs-admin/jagurs)
   and published formulations as references. It may improve shorter-wave
   propagation and waveform detail within its valid depth/wavelength range;
   it does not automatically improve inundation, terrain accuracy or source
   reconstruction. Document the extra computational cost and the formulation's
   limitations before exposing it as an experimental picker option.
5. **Sensitivity runs.** Compare bounded ensembles of source strength, water
   level, friction and terrain uncertainty. Report ranges of arrival time,
   water depth and speed, with their assumptions. Parameter sweeps alone do
   not supply hazard probabilities.

**Acceptance for a dispersive option:** recover the long-wave limit; check
phase speed and pulse spreading against an appropriate analytical dispersion
relation within the formulation's stated validity range; compare arrival time,
waveform and energy behaviour with published benchmarks; retain water balance
and non-negative depth at the coastal coupling; define how dispersion is
handled near breaking and wet/dry cells; measure browser runtime and memory.
Validate the baseline coastal solver first using
[NOAA benchmark cases](https://nctr.pmel.noaa.gov/benchmark/Analytical/index.html).
A future solver option must state which physical effects it adds and remain
labelled experimental until its own checks pass.


### On-demand Copernicus GLO-30 + hydrology (proposed)
- **Goal:** Let the on-demand model (20 km squares) optionally use Copernicus GLO-30 with the full hydrology pipeline (breach, fill, D8, flow accumulation, streams, HAND) instead of only DEM-H.
- **Why:** GLO-30 covers areas DEM-H doesn't, and matches the detailed Brisbane pipeline; consistent tooling across detailed and on-demand models.
- **Challenges:**
  - Hydrology tools (Whitebox) must run in the browser; ship `whitebox-wasm` to the client and run breach/fill/D8/flow-acc in a worker.
  - Download and mosaic GLO-30 tiles client-side (CORS, tile size, memory for 20 km squares at 30 m).
  - GLO-30 is a surface model (buildings/trees), so results differ from bare-earth DEM-H; document this.
  - Performance: hydrology on a ~667x667 grid in WASM must stay interactive.
- **Steps:**
  1. Prototype downloading one GLO-30 tile and running D8 in the browser.
  2. Port `flood hydrology` stages to a browser worker using `whitebox-wasm`.
  3. Add a toggle in the on-demand flow: DEM-H (default) vs GLO-30 + hydrology.
  4. Cache intermediate rasters in IndexedDB; fall back to DEM-H on failure.
  5. Update tests (parity between pipeline and browser hydrology) and docs.
- **Status:** Not started. Large effort; consider as a major release item.


- **Flood routing, further.** Below the gauge the flood is routed
  (Muskingum–Cunge) with tributary inflows, measured ratings where the
  gauge has flow records, and tides; recorded floods follow other gauges
  upstream. Still simple: tributary floods copy the gauge's shape, places
  above the gauge without a recorded gauge are only shifted in time, and
  floodplain storage and dam releases aren't modelled. Ratings come from
  daily means, so they are extrapolated above the highest daily level.
- **Tides from predictions.** Recorded floods use recorded sea levels from
  Maritime Safety Queensland's or UHSLC's tide gauges within 150 km;
  scenarios use a 12.4-hour sine at spring-tide height. NSW's ocean tide
  records (Manly Hydraulics Laboratory) aren't open downloads, so NSW
  floods use Fort Denison. Tide predictions would allow "this week's
  highest tide".
  Some recent Maritime Safety Queensland yearly files (Cairns 2023,
  Mooloolaba 2022) download empty from the state portal; Cairns 2023 gets
  its sea level once they are fixed.
- **Design rainfall from the Bureau.** Storm mode currently offers example
  storms and links to the Bureau's design rainfall (IFD) tool. Fetching the
  IFD table for the model's location would give real "1% annual chance"
  storms; the Bureau's site blocks automated requests, so this needs a
  permitted access route (see above) or a pre-built national grid.
- **Stormwater, further.** Pipes take one typical rate of runoff from
  built-up land; council pipe network data (where published) and the
  local design storm would replace the single rate.
- **More levee data.** Levees come from OpenStreetMap and whatever
  `flood levees` collects. The NSW levee audit (about 130
  datasets listed on data.nsw.gov.au) is found, but SEED refuses the
  downloads from GitHub's servers (HTTP 403), and Victoria's open map
  server has no levee layer. Options: run the script from a home or office
  computer and commit `levees.geojson`, or ask DCCEEW NSW for an open
  service. Levee crest heights from surveys would beat crests read from
  the terrain. Overtopping fills the protected area to the river level
  without a volume limit, so short overtopping is overstated.
- **Recorded floods hour by hour.** `config/events.json` lists 17 floods;
  the build fetches hourly gauge readings from Water Data Online for those
  with a nearby station holding a level series for the dates. Lismore
  2022 and Rockhampton 2017 have no such station (their flood gauges
  aren't on Water Data Online); the Bureau's flood-warning gauge archive
  would fill them, through the same access route as above.
- **More recorded floods for the accuracy check.** Queensland flood lines,
  Brisbane City Council outlines and Victoria's flood history are built in.
  New South Wales doesn't publish recorded outlines as an open service
  (Northern Rivers 2022 would be the priority); Digital Earth Australia's
  satellite-observed water for specific flood dates is another option.
- **Victoria's statewide flood extent** (1% chance), if it becomes
  available as an open map service.

- **Hazard, further.** Flow speeds are estimated from depth and slope with
  fixed roughness; a two-dimensional model (or council hazard mapping
  where published, now shown for Rockhampton) would be better.
- **Dam operations.** Releases are entered by hand; reading published
  release schedules (Seqwater, WaterNSW) during an event would automate it.
- **Climate, further.** Storm rainfall uplift follows the draft ARR rates;
  the matching loss adjustments and per-region warming projections could
  be added.

## Impact

Done: buildings, people, roads, key sites, water above floor (with a floor
height setting), daytime workplaces, places cut off from a dry road out,
and when roads close and how long places stay cut off (flood over time).

- **Daytime counts, further.** Workers come from the ABS place-of-work
  counts by SA2; destination zones (much smaller) would be sharper, but
  their counts are only in TableBuilder, not an open download.
- **Evacuation centres.** OpenStreetMap has few mapped; councils publish
  lists on their disaster dashboards (often as PDFs or web pages). Open
  map services of designated centres would make routes far more useful.
- **Measured floor heights.** NSW councils publish floor level surveys for
  some flood studies on the NSW flood data portal (SEED), which refuses
  GitHub's servers; collecting them needs the home-computer route. Others
  aren't published openly.
- **Australian damage curves.** Damage uses the EU JRC global curve for
  Oceania homes. The NSW residential damage curves (2007 guideline) and
  Geoscience Australia's vulnerability functions are used in flood
  studies but not published as open numbers; worth adopting if they are.

## Data coverage

### Additional open data sources to consider
- **Council stormwater pipe networks** (Brisbane, Melbourne, SA, Victoria publish pipe data under the open council data standard): could replace the single typical pipe rate in storm mode, per-council like flood maps.
- **Geoscience Australia Geofabric** (national surface hydrology / stream network): could improve routing beyond D8 derived from the DEM.
- **Australian Flood Studies Database (AFRIP)**: catalogue of flood studies; could link recorded-flood outlines and help calibrate more models.
- **ELVIS LiDAR**: already a user-supplied option; a build step could fetch LiDAR DEMs for target areas.
- **NSW floor-level surveys**: patchy, council-specific, no bulk download; data-blocked for a national tool.
- **Bureau IFD design rainfall**: blocked by automated access (needs a permitted route).

- **More council flood maps.** Now Brisbane, Gold Coast, Moreton Bay,
  Sunshine Coast, Logan, Rockhampton and Livingstone. Redland's city plan
  service needs a login; Ipswich, Townsville and Cairns publish maps only
  as PDFs or in their own map viewers. Check periodically for new open
  services, and for NSW and Victorian councils.
- **Rain radar detail.** RainViewer's free tier stops at zoom 7; a
  higher-resolution open radar source would help storm mode.

## Reliability and usability

- **Offline, further.** The site installs and works offline from what has
  been used. It could also save a chosen area in advance (pre-fetch its
  tiles and terrain) before heading somewhere without signal, and show
  how much is stored.
- **Real-phone testing**, especially iOS Safari, for panels, scrolling,
  the area-study box and touch gestures.
- **Accessibility, further.** Done: keyboard use of the map (Enter acts at
  the map centre), focusable numbered places, announced status messages,
  colours that differ by lightness. Still to do: a screen-reader summary of
  the flood map itself (beyond the counts), and an audit with a real
  screen reader.
- **Faster first load, further.** Scripts are minified, the flood-network
  gauges load first (the other 2,400 river gauges follow once the map is
  drawn), and flood history loads with the first model.

## Build and testing

- **Preset audit.** The live check lists which Bureau gauge each river
  preset is anchored to; review any presets that aren't anchored or sit
  far from their gauge.
- **Hydrology inside `flood` (implemented).** Production uses `flood hydrology`
  with six RustGIS tools pinned to whitebox-wasm commit f0076c2 and an
  archive dependency patch in `rust/vendor/wbraster`. The original integration
  matched all six Brisbane rasters from GeoLibre 1.6.0 exactly.
  The comparison workflow retains that runner under `tests/geolibre` and
  fails on raster or metadata differences. Keep `rust/Cargo.lock` and the
  pinned `rust-toolchain.toml` for reproducible builds. Release builds with LTO take over
  ten minutes; a lighter pipeline build profile remains worth investigating.
- **The model inside RustGIS.** `rust/flood-core` has no dependencies and
  builds to WebAssembly; it could be offered to RustGIS as a tool working
  on a DEM and D8 opened there.
- **Faster single runs.** In the browser one inundation costs about the
  same in Rust as in JavaScript, because the results are copied out of
  WebAssembly memory. Returning only what the map draws (or sharing
  memory) would make interactive updates quicker; analysis, storms and
  flood timelines are already 1.2–2.6× faster.

## Desktop (offline-first) version (proposed)

**Goal:** Ship Flood Explorer as a desktop app (Windows/macOS/Linux) that
bundles the cache, storage, data fetching and processing, so it runs with no
cloud backend and no per-request cost. Motivation: the web app depends on the
Lambda broker (compute + S3 storage) and is subject to CORS, cold starts and
rate limits; a desktop build removes all of that.

**Why Tauri (not Electron):** the backend is already Rust (`flood-broker`,
`flood-feeds`) and the frontend is already a web app (`viewer/`); Tauri
wraps the webview around a Rust core, ships a small binary, and reuses the
existing crates. Electron would duplicate the backend in Node.

**Shape of the work:**
1. **Local mode in `flood-broker`.** Add a storage backend switch: when
   `FLOOD_STORAGE=local` (or a `--data-dir` flag), read/write the readings
   document to `~/.flood-explorer/readings.json` (and a gz copy) instead of
   S3, and run the refresh loop on a tokio timer instead of via EventBridge.
   The fetch/parse logic is unchanged. This keeps web and desktop on one
   binary.
2. **Tauri shell.** New `desktop/` crate: Tauri app whose webview loads
   `viewer/index.html` (built by Vite), with the broker as a sidecar
   process started on launch and stopped on quit. Configure the webview's
   `FLOOD_BROKER_URL` to `http://127.0.0.1:<port>`. Reuse the existing
   CORS handling (the local broker sets the right headers).
3. **Elevation proxy.** Route Geoscience Australia elevation requests
   through the local broker (a `/v1/elev` or passthrough) so the webview
   never hits CORS and offline-cached tiles work. The broker already caches
   tiles in `ELEV`/`TERRAIN`.
4. **National data.** Either bundle `viewer/data/national/*` in the
   installer (~tens of MB) or download on first run into the data dir with a
   progress screen. Subsequent runs use the cached copy; the build pipeline
   (`flood-pipeline`) is unchanged.
5. **Offline-first.** The service worker already caches tiles/terrain/live
   readings; on desktop the broker's local store replaces S3, so the app
   works fully offline after the first data fetch. Add an "offline" badge
   using the existing `nat.readingsSource` plumbing.
6. **Distribution.** Tauri produces `.msi`/`.dmg`/`.AppImage`. Code signing
   and notarisation (macOS) are the main cost; the Tauri updater
   (signed update manifests) gives in-app auto-update from a GitHub
   Releases host. No server-side hosting needed.

**What it replaces / saves:**
- Lambda broker + S3 + API Gateway (the only cloud cost) → $0.
- No cold starts; refreshes run on the user's machine.
- No CORS workarounds; the elevation proxy removes the last one.

**What it costs:**
- Two release artefacts to maintain (web + desktop), though they share
  `viewer/` and `rust/flood-feeds`.
- Installers, code signing, notarisation and the updater signing key.
- Users must download ~50-100 MB and update periodically for new data
  (the Bureau's annual gauge list changes).

**Suggested phasing:**
1. Local mode in `flood-broker` + a tiny `desktop/` Tauri shell that
   launches it (proof of life, ~3-5 days).
2. Elevation proxy + bundled national data + offline badge (~1 week).
3. Auto-updater + signed installers for the three platforms (~1 week).
4. Drop the cloud broker from the web build once the desktop is proven
   (or keep both: web stays, desktop is the "full" version).

**Open questions:**
- Should the desktop build be the *primary* product (web becomes a
  preview) or a companion? Keeping both doubles the release surface.
- Data refresh cadence on desktop: the scheduler's 15 min is fine, but a
  laptop that sleeps won't refresh; resume on wake.
- Whether to gate heavy features (2D inertial model, LiDAR) behind a
  "desktop only" flag, since they're the parts that benefit most from
  native memory.

**Status:** Not started. Large effort; treat as a major release item. Start
with phase 1 (local mode + Tauri shell) once the web app's current roadmap
items settle.

## Rendering pipeline in Rust (WASM for web, native for desktop) (proposed)

**Goal:** Move the flood raster rendering (depth → colour, hazard bands, terrain
shading, stream lines) out of JavaScript and into Rust, so the web app calls
it through WebAssembly and the desktop app calls it natively. One source of
truth for colours and depth bands; faster (Rust loops over ~445k cells beat
JS); and the desktop build gets the same rendering for free.

**What's already Rust:** the flood model itself (`flood-core`, `flood-wasm`).
**What's still JS:** `composeWater()` (depth/hazard → RGBA), the terrain
relief base, stream-channel tinting, the `floodPixels` count, and the
canvas `putImageData` upload. That is the thing to move.

**Shape of the work:**
1. **Extract `composeWater` into `flood-wasm`.** A new export, e.g.
   `compose_water(depth: &[f32], wet: &[u8], hazard: &[u8], base: &[u8],
   terrain: &[u8], params) -> Vec<u8>` returning an RGBA buffer, with the
   depth bands, hazard colours, stream threshold and relief alpha encoded as
   parameters (or a small config struct). The JS side keeps only the
   `putImageData` upload and the overlay positioning. Add a parity test:
   the WASM output must byte-match the current JS output for a fixed grid.
2. **Wire the web app to it.** Replace the `composeWater()` body with a call
   into the WASM module; keep `cellLatLng`, `area.polygon` masking and the
   `floodPixels` count in JS (or move the mask into WASM too). Measure the
   speedup (target: under 16 ms for a 667x667 grid so it stays interactive
   during timeline playback).
3. **Desktop reuse.** The desktop build (ROADMAP "Desktop version") calls
   the same Rust function natively — no WASM overhead, and it can render
   directly to a texture/surface if a GPU path is added later.
4. **(Optional) WebGL upload.** Once the RGBA buffer is produced in WASM,
   upload it as a `WebGLTexture` instead of `putImageData` + PNG blob. This
   is the bigger win for pan/zoom smoothness but is a separate change; the
   canvas path stays as the fallback.

**What it does not change:** the model (already Rust), the elevation fetch,
the map (Leaflet), or the UI. Only the colour-mapping step moves.

**Risks / things to watch:**
- The colour tables (`DEPTH_STOPS`, `HAZARD_COLORS`, `DEPTH_ALPHA`) and the
  relief/stream logic must be reproduced exactly; the parity test is the
  guard. Any drift shows up as a visible colour change.
- WASM ↔ JS data transfer for a 667x667x4 buffer (~1.8 MB) per render is
  fine but must reuse a single buffer (no per-frame allocation) to avoid GC
  pressure during timeline playback.
- `area.polygon` masking (just shipped) must be applied either in WASM or
  as a post-pass; doing it in WASM keeps one code path.

**Status:** Not started. Medium effort (~1 week for step 1-2). Pairs
naturally with the desktop version: do the WASM extraction first, then the
desktop build consumes it natively.

**Open questions:**
- Should the colour tables live in `flood-core` (shared by pipeline and
  browser) or in `flood-wasm` only? Putting them in `flood-core` lets the
  pipeline render comparison images too.
- WebGL upload (step 4) vs staying on canvas: canvas is simpler and already
  works; WebGL is faster but adds a shader + texture lifecycle. Decide
  after measuring step 2.
