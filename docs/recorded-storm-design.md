# Recorded-storm replay

Implemented pipeline and viewer support on 1 November 2026. Successful live
rainfall retrieval still needs verification: the public Water Data Online
parameter query returned `DatasourceError: Error connecting to WDP` during
implementation. No synthetic rainfall is published as observations.

## Data pipeline

```sh
flood storms config/events.json cache/rain-storms.json
```

For each configured event, the command searches stations within 50 km (optional
per-event `rainRadiusKm`, capped at 100 km), examines up to 12 nearby candidates
and retains up to three usable stations. It accepts rainfall series explicitly
labelled `HourlySum`, with units `mm`, preferring merged series. Raw/cumulative,
daily and unknown-unit series are rejected; they cannot safely be treated as
hourly rainfall. The successful provider response shape and actual availability
of qualifying series remain to be checked once the provider recovers.

Hourly sums are interpreted as intervals ending at their timestamps: a value at
01:00 applies to 00:00–01:00. Existing event date windows use fixed AEST, matching
`flood events`; explicit offsets are honoured and published times are UTC.
Off-hour timestamps, negative/missing values and conflicting duplicates do not
produce usable bins. Missing hours remain JSON `null`; they are never zero-filled
or replaced with daily means. Provider quality flags are not independently
interpreted, so observations may be provisional.

Output schema:

- `schemaVersion: 1`, `fetched`, `source`, `errors` and `events`.
- Events carry ID/name, location, UTC `start`/`end` and `stations`.
- Stations carry ID/name/location, `tsId`, `tsName`, `unit: "mm"`,
  `intervalSeconds: 3600`, `timestampConvention: "interval-end"` and `rainMm`.
- `rainMm[0]` is the hour beginning at the event's `start`. `0` is an actual
  dry observation; `null` means unavailable.

An all-failed/unsupported fetch exits unsuccessfully without replacing the last
good snapshot. The build restores a cached snapshot, tries again on a monthly
cache miss and publishes `data/national/rain-storms.json` when available. Source
failures do not block the site build or manual rainfall. Historical snapshots
remain useful when older; acquisition time is not an observation time.

## Viewer behaviour

Choose **Local-inertial 2D → Replay a recorded storm**. The picker loads lazily,
filters stations to within 50 km of the current model and offers:

1. Event and rain station.
2. An hourly start time within that event.
3. An explicit percentage of measured rain becoming runoff (0–100%). No loss
   calibration is supplied and no percentage is silently selected.
4. The existing run duration, limited to 24 hours by the solver.

The chart shows measured rainfall, selected hours in blue and missing hours in
red. The summary keeps observed rain and effective runoff separate. Missing-hour
windows and runs extending beyond the record fail before a worker starts.
Partial final hours use the corresponding hourly rate for the elapsed fraction.
The series has a zero tail so no final observed rate can extend indefinitely.

Effective rainfall is applied uniformly over the local model. This replays one
station's observations under user-selected losses; it does not reconstruct the
catchment's river flood, spatial rainfall, drainage or antecedent conditions.
Gauge inflow/initial water/roughness/boundary choices remain explicit controls.

Results show the selected event, station, runoff assumption and absolute start
and finish in AEST, alongside source volume and water balance. The current 2D
viewer shows final depth; this change does not add time-scrubbed 2D playback or
persist dynamic runs in share links. The fast-model recorded-gauge timeline is
unchanged. Missing/malformed snapshots or absent nearby stations leave manual
rainfall usable. Existing desktop packages do not yet bundle historical rainfall
unless the snapshot is included in their data build.

## Verification

- Rust tests cover end-of-interval alignment, time zones, dry vs missing hours,
  conflicting duplicates, series selection and last-good preservation on outage.
- JavaScript tests cover distance/units/schema filtering, window bounds,
  observed/effective totals, partial hours and missing-hour rejection.
- `npm run test:storms` exercises the built viewer and actual 2D worker with an
  explicitly synthetic fixture: selected rainfall, runoff volume and time labels,
  gap rejection, clearing back to manual, and absent-snapshot fallback.
- Browser checks run this regression after building the viewer. The fixture is
  only under `tests/fixtures/rainfall/`, not bundled as historical observations.

## Follow-up after the provider recovers

Query the [Water Data Online API](https://www.bom.gov.au/waterdata/services?request=getrequestinfo&service=kisters&type=queryServices)
with a normal identified client. Save a successful station/series/value fixture,
verify units, interval definition and timestamp convention against provider
metadata, and check which configured events have complete useful windows. If
hourly sums are not available, add a separately validated conversion for the
actual rainfall series rather than relabelling raw readings. See the Bureau's
[coverage, provisional-data and service-limit guidance](https://www.bom.gov.au/waterdata/wiski-web-public/faq.htm).
