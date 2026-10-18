# Storms replayed from recorded rainfall

## Problem

The timeline and the 2D solver are driven by constant, user-set inputs
(a gauge level, a constant mm/h rain). Real floods come from real
storms. IFD *design* rainfall is blocked to automation, but **recorded**
rain from actual events is open data on the same Water Data Online (WDO)
service the app already uses for river and tide readings.

## Research

- The page has **no live WDO client**: all BoM data is fetched at build
  time by the pipeline binary and shipped as static JSON —
  `flood national` writes `site/data/national/{gauges-*, storages.geojson,
  readings.json}` and `flood events` writes hour-by-hour recorded
  flood/sea readings (`.github/workflows/build.yml` ~115–150). Rainfall
  should ride the same path.
- WDO publishes **pluviograph (recording rain gauge) data**: the
  "Rainfall" sensor as hourly period sums for thousands of stations,
  via the same station/telemetry JSON endpoints the pipeline already
  uses for levels (same organisation/datasource structure). *Verify the
  exact sensor/duration codes against a live WDO query as the first
  implementation step.*
- Consumers of rain today:
  - the **2D solver** takes scalar `rain_mm_h` for the whole run
    (`rust/flood-core/src/inertial.rs` `opts.rain_mm_h`, validated
    0..=1000);
  - the **fast model** has flash/storm machinery (`stormUplift`,
    flash flooding) driven by constant rain + duration;
  - climate warming scaling exists (`stormUplift`, AR&R draft rates).

## Design

1. **Solver: rain time series.** Extend the 2D options with an optional
   per-hour rain series (`rain_mm_h: Vec<f64>` or keep scalar + add
   `rain_series: Option<Vec<f64>>`); the loop indexes
   `series[elapsed_hours.min(len-1)]`. Validation: each entry 0..=1000,
   length ≥ 1. Rust reference + wasm bridge + parity battery updated.
2. **Build-time storm snapshot.** Extend the pipeline (`flood storms`,
   sibling of `flood events`): for each configured storm event, download
   the hourly series of the pluviographs inside/near the catchment and
   ship `site/data/national/rain-storms.json` (event → station →
   mm/h). Static, cacheable, offline-friendly — consistent with how
   every other BoM input reaches the page. Storms to configure: the
   events already listed in `config/events.json` (2022 Feb, 2011 Jan…).
3. **Storm picker.** In the 2D controls: "Use a recorded storm" — list
   the snapshot's storms and their stations near the model area,
   preview the hyetograph (tiny inline bar chart), then run.
4. **Event alignment.** The timeline's `t0/step` convention already
   anchors hours to a recorded gauge peak; rain-driven runs anchor
   hours to the storm window start so timeline labels read naturally.
5. **Fast model** stays gauge-driven (it has no rain hydrology); the
   recorded-storm path is 2D-only. Flash scenarios keep their existing
   constant-rain entry point.

## Failure behaviour

- Station without rainfall data: filtered out at pipeline fetch time
  (logged in the build step like `flood national`'s warnings); the page
  only ever sees a clean snapshot.
- Snapshot missing/stale: the picker hides and the controls keep the
  constant-rain path — a data outage never blocks manual use.

## Test plan

- Rust: unit test the series indexing (short series clamps, zero pad);
  parity: a rain-series case in the checksum battery (wasm vs Rust).
- Node: picker list filtering; hyetograph preview math.

## Effort

L — spans Rust, wasm bridge, a picker UI and a data fetch; the payoff
is replaying actual events (2022 February, 2011 January) on the 2D
solver end-to-end.
