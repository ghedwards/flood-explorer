# Working roadmap

Working checklist, reconciled against the repository on 1 November 2026.
[The main roadmap](../ROADMAP.md) holds the longer-term plans and limitations;
this file tracks implementation status. Completed means present in code, not
verified in a published release or validated against real floods. Historical
design and handoff notes can contain superseded status statements.

## Outstanding work

- [ ] **JavaScript dependency audit:** CI reports
  [GHSA-g3hv-75wg-m249](https://github.com/advisories/GHSA-g3hv-75wg-m249)
  in ESLint's transitive `minimatch` 10.2.6; the advisory identifies 11.0.1 as
  patched. Evaluate a compatible lint-toolchain update rather than forcing an
  unreviewed major transitive override. Lint/unit checks themselves pass.

- [ ] **Recorded rainfall live verification:** downloader, station/window picker,
  runoff assumptions and 2D event-time labels are implemented and fixture-tested.
  Verify successful provider metadata/data and event coverage after Water Data
  Online's `DatasourceError` recovers; no observed snapshot was generated here.
  [Status and verification steps](recorded-storm-design.md).
- [ ] **Offline preparation:** add an explicit area prefetch flow, cache/storage
  feedback and offline recovery checks. Overpass response caching is already
  implemented; this is the remaining field-mode UI and verification work.
  [Design](offline-field-design.md).
- [ ] **Accessibility follow-up:** provide a screen-reader map summary and
  audit with a real screen reader; check panel focus return, dialog semantics,
  timeline shortcuts and automated axe coverage against the original design.
  Keyboard map actions, live regions, Escape-to-close and Space-to-play exist.
  [Design](keyboard-a11y-design.md).
- [ ] **Real-phone checks:** verify iOS Safari panels, scrolling, study selection
  and touch gestures. See [reliability work](../ROADMAP.md#reliability-and-usability).
- [ ] **Playback memory and profiling:** measure large-grid memory/runtime;
  consider bounded or lazy frame decoding. Worker depth-frame generation,
  transfer compression and main-thread decode are already implemented.
  [Design](precomputed-frames-design.md).
- [ ] **Map rendering follow-up:** profile the legend/comparison change key
  (which includes the timeline step), direct layer-list updates and repeated
  marks. Coalesce or change renderers only where measurement supports it.
  [Design](map-render-path-design.md).
- [ ] **GLO-30 browser integration:** connect the tile prototype and standalone
  hydrology helpers to a parity-checked worker pipeline, tile mosaicking,
  reprojection, caching and a terrain selector. The viewer's WASM dispatcher
  does not yet expose this full pipeline.
  [Plan](../ROADMAP.md#on-demand-copernicus-glo-30--hydrology-partially-prototyped),
  [original port design](hydrology-port-design.md).
- [ ] **Model validation and refinements:** validate the terrain-based routing
  storage approximation and levee volume budget; replace the fixed 24-hour
  overtopping assumption with supported event duration/segment handling.
  [Storage design](floodplain-storage-design.md),
  [levee design](levee-overtopping-design.md).
- [ ] **Tsunami validation and extensions:** validate terrain/datums and local
  observations, broaden source/tide sampling, and check nesting conservation
  and variable-depth dispersion. One-way forcing, experimental two-way and
  intermediate-grid nesting, coastal benchmark cases and main-map impact
  integration are already implemented. [Current methods](tsunami-prototype.md).
  [Priorities and acceptance criteria](../ROADMAP.md#tsunami-data-coastal-coupling-and-dispersive-waves-25-oct-2026).
- [ ] **Desktop release verification:** test installers, signing, updates and
  offline recovery on supported platforms; follow the
  [release guide](../desktop/README.md). The app and release tooling exist;
  release publication and configured secrets were not checked here.

Further data coverage, rainfall design, tide predictions, damage curves and
performance ideas remain in [the main roadmap](../ROADMAP.md).

## Requires access or an owner decision

- [ ] Confirm forecast/traffic feed keys and live health where required;
  implementation alone does not establish configured credentials.
- [ ] Obtain a permitted source for measured floor surveys and Bureau IFD
  rainfall; reassess the access limitations recorded in the design notes before
  implementation. [Floor-height design](measured-floor-heights-design.md).
- [ ] Confirm desktop update signing and platform signing/notarisation setup
  before a release. [Setup](../desktop/README.md#one-time-signing-setup).

Bureau warnings/classes no longer belong on the implementation-blocked list:
FTP fetching is in `rust/flood-feeds`, with ArcGIS warning geometry. The Git
remote already uses `ghedwards/flood-explorer`, so repository renaming is no
longer a pending task. Historical archive access remains a separate concern.

## Deferred

- **HAND fallback:** revisit when a consumer is added; `hand_simple` exists
  without an app/WASM consumer. D8 scan-order tie handling is documented in
  `rust/flood-core/src/hydro.rs`; broader parity documentation can accompany
  future hydrology work. [Design](hand-d8-polish-design.md).
- **Native desktop textures / WebGL upload:** optional future rendering paths,
  subject to profiling; the existing desktop viewer uses WASM and canvas.

## Implemented

| Capability | Evidence | Original note |
|---|---|---|
| Arrival times in saved Places | `viewer/app.js`: arrival text in property snapshots and Places tags | [Design](arrival-times-design.md) |
| Dry routes to mapped evacuation centres | `routeOut`, `drawRoute`, report and snapshot persistence; centre coverage still needs work | [Design](evacuation-route-design.md) |
| Basemap failure prompt | `viewer/app.js`: tile error tracking and `basemapNotice` | [Design](basemap-failover-design.md) |
| Dam release input, including 2D hourly inflow | `buildInflowSeries` and solver wiring; automatic schedules remain open | [Design](dam-release-design.md) |
| Recorded-storm replay plumbing | `flood storms`, station/window picker, explicit losses and real-worker browser coverage; live source verification remains open | [Status](recorded-storm-design.md) |
| Manual hourly rain in 2D | `buildRainSeries`, `inertialRainSeries` input and Rust `rain_series` | [Design](recorded-storm-design.md) |
| Overpass offline response caching | `viewer/sw.js`: Overpass hosts routed to the API cache | [Design](offline-field-design.md) |
| Keyboard/accessibility foundations | Map keyboard actions, status live regions, panel Escape and timeline Space | [Design](keyboard-a11y-design.md) |
| Visual regression baselines and CI enforcement | Five deterministic map scenes, strict expected PNGs, failure artifacts and an intentional missing-overlay detection check | [Baseline guide](../tests/visual/README.md) |
| Timeline depth frames | Rust frame output, `viewer/flood-worker.js` compression, viewer decode/fallback | [Design](precomputed-frames-design.md) |
| Legend/comparison change guard | `viewer/app.js`: `scheduleMapChrome`; further profiling outstanding | [Design](map-render-path-design.md) |
| Rust water colour composition | `rust/flood-core/src/render.rs`, WASM dispatcher and viewer call with JS fallback | [Main roadmap](../ROADMAP.md#rendering-and-playback-implemented-foundations-optimisation-remains) |
| Initial floodplain storage / levee volume limits | `wave.rs` terrain storage coefficient and `surface.rs` fixed-duration weir budget | [Storage](floodplain-storage-design.md), [levees](levee-overtopping-design.md) |
| Hazard from 2D solver velocities | Solver velocity outputs and hazard consumption; depth/slope fallback remains | [Implementation note](hazard-velocity-wasm.md) |
| Desktop shell, broker, bundles and signed updater support | `desktop/`, installer workflow and updater tests | [Guide](../desktop/README.md) |
| River preset audit and delayed raster cleanup | Explicit river metadata, audit tool, guarded raster layers and regression tests | [Audit](preset-audit.md) |
