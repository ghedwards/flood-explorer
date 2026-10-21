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

### How to check a new endpoint (read first)

The agent sandbox can't reach most hosts (bom.gov.au, government APIs,
github.io, the Lambda URL); WebFetch only summarises and can't show raw
responses. To see a real response:

- Add a URL to the broker's probe (`Broker::probe` in `flood-broker/src/lib.rs`)
  and invoke it: `{"flood_broker":"probe"}` runs after each deploy on main
  (the deploy workflow's probe step prints a notice).
- Or add a throwaway step to `shots2d.yml` on a `2d-*` branch that `curl`s
  the URL and writes the first few KB to `$OUT/probe-*.txt`, which lands on
  the `shots-2d` branch. Remove it before merging.
- Save a real response as a test fixture before writing the parser.

All new feeds follow the same pattern, so one recipe:

1. **flood-feeds**: `pub fn parse_<feed>(body: &Value) -> Vec<Value>` (pure,
   fixture-tested) and `pub fn <feed>(http, errors) -> Value` (fetch with a
   timeout; errors pushed, never panics).
2. **broker refresh** (`readings.rs`): a stage after warnings, time-boxed
   (like rain: a deadline, carry the previous value up to N hours with
   `Self::carry`), its seconds in `stageSeconds`, a count in the summary.
3. **watch list** (`feeds::watch_list`): add a kind where it matters, scored
   against the existing kinds (warning, flood, river, sea).
4. **app**: a layer in `buildNationalLayers` (persistent `L.layerGroup`,
   redrawn when `refreshLiveReadings` brings new readings, like
   `drawWarningAreas`), popups with the source's text and link, attribution,
   `status.<feed>` and a `window.__flood<Feed>()` hook for tests.
5. **tests**: Rust fixtures; a notice in `tests/broker-live.js` (counts, one
   sample); a screenshot.
6. **size**: readings.json is ~2 MB raw (~170 KB gzipped). Keep new feeds
   small: simplify geometry (≈100 m), drop unneeded fields, cap counts.

### 1. Official road closures (recommended next; ~1 day)

Why: the model says which roads a flood would cut; the agencies say which
are closed now. Side by side they show the situation and check the model.

Sources (verify each with a probe first):

- **Queensland, QLDTraffic GeoJSON API** (Department of Transport and Main
  Roads). Feeds include Hazards, Crashes, Congestion, **Flooding**,
  Roadworks, Special Events, Web cameras. Specification:
  https://qldtraffic.qld.gov.au/more/Developers-and-Data/ (PDF "QLDTraffic
  website API specification", v1.10). The API is `https://api.qldtraffic.qld.gov.au/v2/events`
  with an `apikey` query parameter; the specification has historically
  published a public key for open use. **Verify** the base URL, the
  flooding filter (`event_type`/`event_subtype`) and the key from the current
  PDF. Terms: provided "as is"; attribution "© The State of Queensland
  (Department of Transport and Main Roads)".
- **NSW, Live Traffic NSW hazards** (Transport for NSW, CC BY). GeoJSON
  FeatureCollections at `https://api.transport.nsw.gov.au/v1/live/hazards/`:
  `flood-open.json` (current), `flood.json` (open and closed). Properties:
  `headline`, `displayName`, `roads[]` (road name, suburb, ...), `isMajor`,
  `created` and `lastUpdated` (ms since 1970), `mainCategory`/`subCategoryA`
  (documented as unstable: don't rely on them). Needs a free Open Data Hub
  API key (https://opendata.transport.nsw.gov.au/), sent as the header
  `Authorization: apikey <key>`. Developer guide v1.9 (Oct 2023) on the hub.
  Store the key as a repo secret, pass it to the Lambda env in
  `broker-deploy.yml` (like `ALLOWED_ORIGINS`), never commit it.
- **Victoria**: no public traffic hazards feed confirmed; check the
  Department of Transport and Planning open data (VicTraffic) before
  building anything for Victoria. Skip if none.

Data shape in readings.json:

```json
"roads": {"fetched": "...", "sources": {"QLD": "ok", "NSW": "ok"},
  "items": [{"id": "qld:123", "state": "QLD", "road": "Warrego Hwy",
    "where": "Mitchell to Morven", "desc": "Closed due to flooding",
    "closed": true, "major": false, "updated": "2026-10-21T04:00:00Z",
    "lat": -26.5, "lon": 147.9, "line": [[-26.5, 147.9], ...],
    "link": "https://qldtraffic.qld.gov.au/"}]}
```

Flood-related only (type flooding, or text matching flood/water over
road). `closed` true when the agency says closed; otherwise "caution".

App:

- Layer "Road closures, flooding (official)", on by default when any: red
  lines (closed) or orange (caution) where geometry is a line, else a
  marker; popup with road, place, agency text, updated time and source link.
- Model impact section (`renderImpact`/roads cut): list official closures
  inside the model's box next to the modelled cut roads: "The model cuts 12
  roads; officially closed now: Warrego Hwy (Mitchell–Morven)". Don't try to
  match road names automatically at first.
- Watch list: a closure of a major road, or several near a gauge in flood.

Risks: feeds change without notice (keep parsers tolerant; a failed source
is reported in `sources` and the last list carried for 2 h); the NSW key
needs the user to register.

### 2. State emergency warnings (Australian Warning System; ~1-2 days)

Why: the Bureau says how high the river goes; the state emergency services
say what to do: Advice (yellow), Watch and Act (orange), Emergency Warning
(red), including "evacuate now" for named towns. Those are the warnings
people act on.

Sources (all need verifying; none confirmed reachable yet):

- **NSW SES, Hazard Watch** (data.gov.au "Hazard Watch", CC BY 3.0 AU,
  publisher NSW State Emergency Service). The dataset page lists no feed URL;
  the public site hazardwatch.gov.au serves its map from a feed: find it
  (browser dev tools by the user, or a probe) and confirm terms with NSW SES
  (datansw@customerservice.nsw.gov.au) if unclear.
- **Queensland, "Storm, flood and cyclone warnings" (CAP-AU XML)** by the
  Queensland Fire Department (data.qld.gov.au dataset
  `storm-flood-and-cyclone-warnings-capau-xml`): CAP-AU with warning areas,
  plus a point layer updated every 30 minutes. Find the file URL on
  data.qld.gov.au. CAP parsing exists already (`parse_cap_flood`; extend it
  for `<parameter>` AWS level fields and `<polygon>` areas, which
  `cap_polygons` already reads).
- **Victoria, VicEmergency**: the support article (2019) says the data feed
  isn't public (register interest). The VicEmergency site's own map uses a
  public events JSON that community tools read; using it needs the terms
  checked with Emergency Management Victoria first. Treat Victoria as
  optional.
- Other states later (Emergency WA, SA SES, Tas SES, NT).

Data shape: `"emergency": {"items": [{"id", "state", "level":
"advice"|"watch_and_act"|"emergency", "hazard": "flood", "title",
"action" ("Evacuate now", "Prepare to evacuate", ...), "areas": [rings],
"point": [lat, lon], "updated", "link"}]}`; flood (and storm/cyclone where
it says flooding) only.

App: a layer coloured by level (the standard AWS colours: yellow, orange,
red), drawn above the Bureau warning areas; a section above "Current flood
warnings (BoM)" in the Forecast panel; Emergency Warnings at the top of the
watch list; on a model, "Inside an Emergency Warning area: evacuate now"
in the impact section. Wording must quote the agency, never paraphrase an
instruction.

Risks: availability and terms (do this only with feeds that are clearly
public); these are life-safety messages, so show them verbatim with the
time issued, link to the source, and never show a stale one as current
(drop items past their expiry; label carried items "as of <time>").

### 3. Observed rainfall (~0.5-1 day)

Rain that has fallen (since 9 am, last 24 h) at the Bureau's flood-network
rain gauges: often the first sign of a flood.

- Locations: layer 4 "Rain gauge locations" of
  `https://hosting.wsapi.cloud.bom.gov.au/arcgis/rest/services/flood/National_Flood_Gauge_Network/FeatureServer`
  (`bom_stn_num`, `name`, `lat`, `long`, `state`, `basin`); fetch from the
  build or broker (no CORS), once a day is plenty.
- Observations: the Bureau's "Rainfall & River Conditions" products. The
  river height pages we already parse (`IDx653xx.html` on the FTP server)
  have sibling rainfall pages/tables: list `anon/gen/fwo/` with the broker's
  FTP client (`ftp::Session::list`) and look for the rainfall products
  (probe first). Alternative: KiWIS rainfall timeseries (Water Data Online,
  daily totals, a day behind; less useful).
- Output `r["rainObs"] = {station: [since9am, last24h, at]}` for gauges with
  rain; app: colour the rain gauge dots by 24 h total, show totals in
  reports, and put heavy totals (e.g. > 100 mm/24 h) near a river gauge on
  the watch list alongside the forecast rain.

### 4. Gauge zeros (open research)

Needed for exact placement of a warning's forecast peak and for the
Minor/Moderate/Major buttons in Scenario (currently off wherever the zero is
unknown, which is now most gauges). Known: only the Bureau's flood class web
pages published it, and they refuse the build (403); `reg.bom.gov.au`
disallows robots; the FTP river height pages, the ArcGIS gauge layers and
the KiWIS station fields checked so far have none.

Leads, in order:

1. KiWIS `getStationList` with `returnfields=station_no,custom_attributes`
   (and `getTimeseriesList` with `returnfields=...,ts_unitname,coverage,
   ca_ts`) for a few known gauges (e.g. 423204A Cunnamulla, 130005A): look
   for a datum/zero attribute.
2. State agencies' metadata: Queensland WMIP (the broker already talks to it:
   check its site metadata call for a datum/elevation), WaterNSW, Victorian
   Water Measurement Information System. Many state gauges report AHD
   directly or publish the gauge datum.
3. A small checked table (`viewer/gauge-zeros.json`, with source and date
   for each) for the preset towns' gauges, filled from councils' flood
   studies; better than nothing.

Until then `boardToModel` (app.js) places a peak from the gauge's rating
(`gaugeRating`, median height) or from the lowest level recorded in the last
5+ days; the message says which.

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
