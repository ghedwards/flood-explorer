# Flood Explorer roadmap

Longer-term plans and modelling limitations. The [working checklist](docs/roadmap.md)
tracks outstanding work and links to design notes. Status reconciled against the
repository on 1 November 2026; implementation does not imply deployment or
validation against real events. Older design notes describe proposals and may
contain superseded status statements.

## Needs an owner decision or access

- **Feed configuration.** Google Flood Hub support is built in; confirm
  `FLOOD_FORECASTING_API_KEY` is configured before relying on forecasts.
  NSW road feeds similarly require `NSW_TRAFFIC_API_KEY`. Secret presence
  and live feed health were not checked in this reconciliation.
- **Desktop release setup.** The desktop app and updater are implemented;
  release signing, installer testing and publication follow
  [the desktop guide](desktop/README.md). Confirm signing configuration
  before preparing a release.
- **Data access.** Measured floor surveys, Bureau IFD rainfall and some
  levee/event archives still need a permitted data route or an open dataset.
  The old warnings/classes access blocker is resolved in code: the shared
  feed library reads Bureau FTP warnings and river-height pages, with
  warning geometry from ArcGIS. This does not provide every historical archive.

## Modelling

### Tsunami: data, coastal coupling and dispersive waves (25 Oct 2026)

The prototype now includes linear regional propagation, uniform- and
variable-depth linear dispersion, and a nonlinear local wetting/drying solver
with an optional second-order scheme. One-way forcing, uploaded wave series,
PTHA18 series import, experimental two-way nesting and a 250 m intermediate
grid are implemented. Regional recordings carry surface displacement and
transport into local boundaries. Local scenarios, sampled hazard extents,
arrival/maximum views and impact/share integration are available on the main
map. The [prototype notes](docs/tsunami-prototype.md) document the current
methods, numerical checks and limitations.

Remaining priorities:

1. **Terrain, datums and observations.** Validate channel/bathymetric data,
   reconcile terrain and tide datums, and compare the local solvers with
   observed tide-gauge events. PTHA18 deep-water series have a blind Tohoku
   DART comparison; that does not validate local inundation. Add supported
   river discharge and land-cover resistance where data/resolution permit.
2. **Source and tide sampling.** Extend the sampled source-zone/magnitude
   coverage and quantify sampling error. Tide-weighted runs and modelled
   extents exist, but omitted scenarios, bathymetry uncertainty and datum
   offsets still limit interpretation. Retain source IDs, rates and limits;
   sampled rates do not establish a validated hazard assessment.
3. **Nesting and shoreline validation.** Experimental two-way feedback is a
   relaxation rather than exact conservative flux exchange. Validate volume,
   boundary transport and refinement across more cases before adaptive grids
   or wider use. Synolakis run-up and Thacker moving-shoreline checks exist;
   further coastal benchmarks, including the conical island, remain.
4. **Dispersion.** Uniform-depth analytical dispersion and depth-ramp energy
   checks exist, alongside variable-depth regional implementation. Compare
   variable-depth waveforms, phase speed and energy with published benchmarks
   before nonlinear coastal dispersion. Specify validity ranges, breaking and
   wet/dry treatment, and retain long-wave, water-balance and non-negative-depth
   checks for any extension.
5. **Sensitivity and runtime.** Bracketing ensembles and worker execution are
   implemented. Extend uncertainty beyond uniform terrain shifts and source
   strength to source geometry and bathymetric error; profile browser memory
   and runtime for larger nested ensembles.


### On-demand Copernicus GLO-30 + hydrology (partially prototyped)

The [tile-download prototype](viewer/glo30-proto.html) exists, and
`rust/flood-core/src/hydro.rs` contains standalone hydrology helpers. The
on-demand viewer still uses GA DEM-H/LiDAR; a complete GLO-30 browser pipeline
is not exposed through the WASM dispatcher or integrated into the model flow.

Remaining work: check helper parity and flat handling, expose the required
hydrology operations to the worker, mosaic/reproject tiles, cache intermediate
rasters, and add the terrain selector with a DEM-H fallback. GLO-30 is a surface
model, so its buildings/trees and datum differences need explicit treatment.
The [original progress note](docs/client-glo30-progress.md) and
[port design](docs/hydrology-port-design.md) are historical context; their
"not started" descriptions predate the helpers now in the repository.


- **Flood routing, further.** Below the gauge the flood is routed
  (Muskingum–Cunge) with tributary inflows, measured ratings where the
  gauge has flow records, and tides; recorded floods follow other gauges
  upstream. Still simple: tributary floods copy the gauge's shape, places
  above the gauge without a recorded gauge are only shifted in time, and
  floodplain storage uses a local terrain-based approximation. Manual dam
  releases are supported, including hourly inflow in the 2D solver; automatic
  operating schedules remain outstanding. Ratings come from daily means,
  so they are extrapolated above the highest daily level.
- **Tides from predictions.** Recorded floods use recorded sea levels from
  Maritime Safety Queensland's or UHSLC's tide gauges within 150 km;
  scenarios use a 12.4-hour sine at spring-tide height. NSW's ocean tide
  records (Manly Hydraulics Laboratory) aren't open downloads, so NSW
  floods use Fort Denison. Tide predictions would allow "this week's
  highest tide".
  Some recent Maritime Safety Queensland yearly files (Cairns 2023,
  Mooloolaba 2022) download empty from the state portal; Cairns 2023 gets
  its sea level once they are fixed.
- **Recorded storms.** Manual hourly rainfall is wired into the 2D solver.
  Downloading historical station rainfall, a recorded-storm picker and
  event-time alignment remain outstanding; see the
  [design](docs/recorded-storm-design.md).
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
  the terrain. The fast model now limits carried water with a weir-discharge
  budget using a fixed 24-hour duration. Event-dependent duration, segment
  budgets and validation of short overtopping remain outstanding.
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

- **Hazard, further.** Hazard uses solver velocities for 2D runs and a
  depth/slope estimate otherwise. Validate velocities and roughness against
  observations or council hazard mapping where available.
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
- **Evacuation centre coverage.** Dry-route search and report/snapshot
  persistence are implemented. OpenStreetMap has few centres mapped; councils publish
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
  been used, including cached Overpass impact responses. It could also save a chosen area in advance (pre-fetch its
  tiles and terrain) before heading somewhere without signal, and show
  how much is stored.
- **Real-phone testing**, especially iOS Safari, for panels, scrolling,
  the area-study box and touch gestures.
- **Accessibility, further.** Done: keyboard use of the map (Enter acts at
  the map centre), focusable numbered places, announced status messages,
  colours that differ by lightness. Still to do: a screen-reader summary of
  the flood map itself (beyond the counts), and an audit with a real
  screen reader.
- **Faster first load, further.** Profile the current startup before choosing
  another optimisation. Scripts are minified, the flood-network
  gauges load first (the other 2,400 river gauges follow once the map is
  drawn), and flood history loads with the first model.

## Build and testing

- **Visual regression (implemented).** Five deterministic map scenes cover
  national gauges, river depth/hazard, impact roads and a timeline step. CI
  compares reviewed PNGs, rejects missing baselines, retains comparison images
  and verifies that hiding the flood overlay fails. Live smoke screenshots
  remain diagnostics. See the [baseline guide](tests/visual/README.md).
- **Preset audit (31 Oct 2026).** All 46 river presets have been checked
  against the published complete gauge catalogue: 44 have a matching river
  gauge within 8 km. Carnarvon and Launceston retain their preset points;
  Grantham uses Gatton, 7.8 km away. The selector now uses explicit river
  metadata and full watercourse names, avoiding tributary or reservoir
  matches based only on a basin. See [the audit](docs/preset-audit.md) and
  rerun `node scripts/audit-presets.js gauges.geojson` after catalogue changes.
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

## Desktop (implemented; release verification remains)

The Tauri app runs the local broker in-process, stores readings locally,
refreshes them on a timer, proxies elevation and bundles national data.
Settings support local traffic keys. Installer workflows cover macOS Apple
Silicon/Intel, Windows and Linux; signed self-update support is implemented.
See [desktop setup and releases](desktop/README.md).

Remaining work is operational: verify installers on real platforms, configure
and verify release signing/notarisation as appropriate, test update and offline
recovery, and publish reviewed releases. The repository alone does not establish
which releases or secrets are live. Keep the hosted web broker while both web
and desktop clients use it; retiring it is a separate product decision.

## Rendering and playback (implemented foundations; optimisation remains)

- **Rust water composition:** `flood-core::render::compose_water` is exposed
  through WASM and used by `composeWater()` with a JS fallback. Canvas upload
  and frontend orchestration remain in JS; the desktop viewer uses this same
  WASM path. A separate native texture renderer is still a proposal.
- **Timeline frames:** the worker transfers quantised depth frames, compressing
  them when supported; the viewer decompresses them before playback and
  decodes each step with a computation fallback. Bounded-memory/lazy decoding
  and profiling on large grids remain work, rather than implementing frames
  from scratch. See the [original design](docs/precomputed-frames-design.md).
- **Map render work:** legend/comparison writes have a change key. Layer-list
  updates still run directly on map events, and the key includes the timeline
  step. Profile before refining these guards or adopting a canvas mark renderer;
  see the [design](docs/map-render-path-design.md).
- **Further rendering:** measure allocation and WASM transfer costs before
  buffer reuse or a WebGL upload path. Native desktop rendering and WebGL
  require their own parity and lifecycle checks.
