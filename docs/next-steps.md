# Next steps (handoff, 21 Oct 2026)

Where Flood Explorer stands, how the live-data side fits together, the
conventions and traps learned the hard way, and designs for the next pieces
of work. Written so another agent can pick any item up cold.

## State of play (main at `fbe5ea41`)

Live at https://ghedwards.github.io/flood-explorer/ with `DATA_SOURCE=runtime`:
the map's readings come from the broker (Rust, AWS Lambda, Sydney), with the
site build's copy as the fallback.

Shipped this round:

- **Broker reliability**: readings stored pre-zipped (`readings.json.gz`) so a
  cold start doesn't zip 2 MB on a 128 MB Lambda; the page retries every 45 s
  if the first fetch times out and switches to live when it arrives.
- **Elevation**: downloads time out (45 s per try), LiDAR gets 20 s past DEM-H
  then the model goes ahead on DEM-H; inland DEM-H gaps are filled
  (`viewer/dem-voids.js`); LiDAR cells near 0 m under high DEM-H are treated
  as gaps (Wagga and Gundagai had 170-200 m of "normal water").
- **River below the gauge**: the normal surface is held up by the bed's lower
  quarter downstream, never below normal depth over the local median bed
  (Maitland 2.67 -> 1.42 m, Wagga 3.09 -> 2.17 m; see `riverBelow`).
- **Warnings**: on the map ("Flood warning areas (BoM)") with the Bureau's own
  flood warning catchments (fetched by the broker), "View on map" and
  "Bureau page" buttons, and **Model the forecast peak**
  (`viewer/warn-peaks.js` reads "may peak near 3.40 m" from the text).
- **Hourly record**: the broker keeps every gauge's level hourly for 7 days
  (`readings-history.json.gz`), `/v1/history?site=`, drawn in gauge reports.
- **Versions** in the information panel (app commit, broker commit from
  `/health`) and in "Copy for reporting".

## How the live side fits together

- `rust/flood-feeds`: all feed code shared by the broker and the build
  (Water Data Online/KiWIS, Qld WMIP, Bureau FTP: CAP warnings, river height
  pages -> flood classes and Bureau levels, storm tide CSV, Open-Meteo rain,
  watch list).
- `rust/flood-broker`: `readings.rs` (the refresh: stages with timings,
  carries old values when a stage fails, S3 store), `history.rs`, `lib.rs`
  (HTTP: `/v1/readings`, `/v1/levels`, `/v1/history`, `/health`), `lambda.rs`
  (runtime API loop; events `{"flood_broker":"refresh"|"probe"}`), `s3.rs`
  (SigV4, reusable for other AWS APIs via `s3::authorization`).
- Deploy: `.github/workflows/broker-deploy.yml` (OIDC role, env vars set
  there, not in the stack). Stack: `broker/aws/setup.yaml`, applied by
  CloudFormation **Git sync from main** (`broker/aws/deployment-config.yaml`).
  The exec role may only touch `readings*` keys in the bucket; a new S3 key
  must start with `readings` or the policy must change.
- Refresh schedule: EventBridge every 15 min (stack param RefreshMinutes).
  Budget: the account has a $10/month budget; keep Lambda at 128 MB and work
  inside the existing refresh rather than adding schedules.
- App: `viewer/app.js` (one big module). `BROKER`, `DATA_SOURCE` at the top;
  national data in `nat` (`nat.readings`, `nat.warnings`, `nat.floodclass`,
  `nat.history`); test hooks are `window.__flood*`.

## Conventions and traps

- Commit as `Gareth Edwards <ghedwards@users.noreply.github.com>` with the
  Co-Authored-By / Claude-Session trailers. Work on `2d-*` branches (they run
  `shots2d.yml`); fast-forward main only after it passes. Model changes need
  the downstream check (`tests/downstream-check.js`, ten preset towns:
  normal depth on the channel should be ~0.3 m, p90 low) before merging.
- **The `shots-2d` branch holds only the latest run** (force-pushed). Two
  branches' runs overwrite each other: run them one at a time and read the
  results (`git archive origin/shots-2d | tar -x`) right after each finishes.
- Job logs can't be downloaded from the agent sandbox; read check-run
  annotations (`gh api .../check-runs/<id>/annotations`, max 10 per step) and
  files the tests write to the shots branch (`broker-live.out`,
  `broker-live.json`, `warnings-live.json`, `downstream.json`).
- `tests/broker-live.js` uses `node:http` for the local broker: Node's fetch
  (undici) crashes with `assert(!this.paused)` on large bodies.
- The Bureau's website returns 403 to automated clients and `reg.bom.gov.au`
  disallows robots; **don't spoof a browser User-Agent**. Use the FTP server
  (`ftp.bom.gov.au/anon/gen/fwo/`), Water Data Online (KiWIS) and the
  Bureau's ArcGIS service (`hosting.wsapi.cloud.bom.gov.au`, no CORS: fetch
  it from the broker or the build, not the browser).
- Top-level names in `app.js` must be unique (a second `function x` silently
  replaces the first; lint catches it on main). Check with:
  `grep -oE "^  (async )?function [A-Za-z0-9_]+|^  (const|let) [A-Za-z0-9_]+ =" viewer/app.js | sed -E 's/^  //; s/async //; s/(function|const|let) //; s/ =//' | sort | uniq -d`
- ESLint isn't installed in the sandbox; `node --check` only checks syntax.

## Open items

### 1. Official road closures (recommended next)

Show roads closed now, next to the model's "roads cut".

- Sources: Queensland **QLDTraffic** open data (GeoJSON events incl. flooding;
  check its current API terms and whether a key is required), NSW **Live
  Traffic** (Transport for NSW Open Data, free API key: store it as a Lambda
  env var set from a repo secret in `broker-deploy.yml`, never in the repo),
  Victoria **VicTraffic** / VicRoads open data (check what's published).
- Broker: a new refresh stage (every 15 min, time-boxed like rain) in
  `readings.rs`, parsers in `flood-feeds` with fixture tests; output
  `r["roads"] = [{id, state, road, desc, kind: "flooding"|"closed",
  lat, lon, line?: [[lat,lon]...], updated, link}]`, flood-related only.
  Add closures near a gauge in flood to the watch list (`watch_list`).
- App: a layer "Road closures, flooding (official)" (on by default when any),
  popups with the agency's text and link; in a model's impact section, list
  official closures inside the model next to the modelled cut roads ("the
  model cuts X; officially closed: Y"). Keep the 15-minute refresh path.
- Check: add to `tests/broker-live.js` notices (count by state).

### 2. State emergency warnings (Australian Warning System)

Bureau warnings say how high; state services say what to do (Advice /
Watch and Act / Emergency Warning, evacuation orders) for named towns.

- Sources: Victoria (`emergency.vic.gov.au` public events GeoJSON), NSW SES
  (Hazard Watch feeds), Queensland (Qld Fire and Emergency / disaster
  dashboard feeds); confirm each feed's terms, format and CORS. Fetch in the
  broker, keep flood-related items only.
- Output `r["emergency"] = [{id, state, level, title, area polygon or point,
  updated, link, text}]`; draw on the map coloured by AWS level (yellow /
  orange / red), list above Bureau warnings in the Forecast panel, top of the
  watch list for "Emergency Warning".
- Same shape as item 1 (a refresh stage, flood-feeds parsers, tests, layer).

### 3. Observed rainfall

Rain that has fallen (since 9 am, last 24 h) at Bureau rain gauges: often the
first sign. The flood gauge network's rain gauge locations are layer 4 of
`hosting.wsapi.cloud.bom.gov.au/.../National_Flood_Gauge_Network/FeatureServer`;
find the observations on the FTP server (look for rainfall tables beside the
river height pages under `anon/gen/fwo/`) or KiWIS (rainfall timeseries).
Show totals on the gauge layer and in reports; add heavy totals to the watch
list.

### 4. Gauge zeros

The flood class buttons (Minor/Moderate/Major) in Scenario and exact
placement of a warning's forecast peak need the gauge zero (AHD), which only
the Bureau's flood class web pages publish (now 403 to the build; the FTP
river height pages have no zero; the ArcGIS gauge layers and KiWIS station
fields checked so far have none; KiWIS `custom_attributes` is unchecked).
Ideas: KiWIS `getStationList ... returnfields=custom_attributes` for a few
known gauges; state agencies' gauge metadata (Qld WMIP, WaterNSW, Vic
Water Measurement); a small hand-checked table for the preset towns' gauges.
Until then `boardToModel` places a peak from the gauge's rating or from the
lowest level recorded in the last 5+ days (approximate, and it says so).

### 5. Smaller items

- **Bureau links**: the user saw some fail; which ones is unknown. The
  warning link is `https://www.bom.gov.au/products/<ID>.shtml`; the Bureau's
  new site may have moved warnings. Ask before changing.
- **Google Flood Hub**: the build step is ready; it needs
  `FLOOD_FORECASTING_API_KEY` as a repo secret.
- **Email/SMS alerts**: on hold by the user's choice (would be SNS from the
  refresh; topic in the stack, subscription made by hand, places in a repo
  variable, never committed).
- **Branches to delete** (the agent's proxy can't delete remote branches):
  `2d-warnareas 2d-slowload 2d-bedpct 2d-bomlevel 2d-demvoids` and the older
  ones (`2d-key 2d-polish 2d-sharp 2d-streets 2d-swfix 2d-tidy 2d-cluster
  3d-bar 3d-imagery-seam 3d-imagery-zoom 3d-tidy 3d-v4 3d-v4-polish
  2d-roadtime 2d-layerfb 2d-perf 2d-perf-worker 3d-perf-worker 3d-mem
  2d-review 3d-review 3d-opacity 2d-dam 2d-tint 2d-release 2d-downstream
  2d-study 2d-riverbed readings-hourly probe-qld readings-qld 2d-broker
  2d-readings 2d-cache 2d-normal 2d-watch probe-data deps-webpki`).
