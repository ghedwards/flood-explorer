# Storms replayed from recorded rainfall

## Problem

The timeline and the 2D solver are driven by constant, user-set inputs
(a gauge level, a constant mm/h rain). Real floods come from real
storms. IFD *design* rainfall is blocked to automation, but **recorded**
rain from actual events is open data on the same Water Data Online (WDO)
service the app already uses for river and tide readings.

## Research

- WDO publishes **pluviograph (recording rain gauge) data**: the
  "Rainfall" sensor as hourly period sums for thousands of stations,
  via the same JSON station/telemetry endpoints the app's reading
  fetcher uses (same organisation/DSN structure as river levels).
- The app's gauge client (`viewer/app.js` ~3236 area, plus the build's
  `gaugeFile`/`readings.json` snapshot) already speaks that API for
  levels; adding a sensor type is a query change, not a new client.
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
2. **Storm picker.** In the 2D controls: "Use a recorded storm" — list
   pluviograph stations within the model area's bounding box (from the
   same national gauge index the app already loads), fetch the event
   window's hourly series, preview the hyetograph (tiny inline bar
   chart), then run.
3. **Event alignment.** The timeline's `t0/step` convention already
   anchors hours to a recorded gauge peak; rain-driven runs anchor
   hours to the storm window start so timeline labels read naturally.
4. **Fast model** stays gauge-driven (it has no rain hydrology); the
   recorded-storm path is 2D-only. Flash scenarios keep their existing
   constant-rain entry point.

## Failure behaviour

- Station without rainfall data: filtered out of the picker with the
  reason; fetch errors surface in the picker, not as a map error.

## Test plan

- Rust: unit test the series indexing (short series clamps, zero pad);
  parity: a rain-series case in the checksum battery (wasm vs Rust).
- Node: picker list filtering; hyetograph preview math.

## Effort

L — spans Rust, wasm bridge, a picker UI and a data fetch; the payoff
is replaying actual events (2022 February, 2011 January) on the 2D
solver end-to-end.
