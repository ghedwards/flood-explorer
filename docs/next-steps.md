# Next steps (handoff, 21 Oct 2026)

Where Flood Explorer stands, how the live-data side fits together, the
conventions and traps learned the hard way, and designs for the next pieces
of work. Written so another agent can pick any item up cold.

## State of play (main at `7a5d87c0`)

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
- **Fetching split** (item 5c below): the broker serves `/v1/now` (latest
  level per gauge, warnings with outlines, watch list, flood classes, sea,
  rain totals — without the per-gauge series) and `/v1/series?site=`
  (`&kind=storage` for dams); the map polls `/v1/now` and a report asks for
  its own series lazily (`viewer/app.js`: `loadNationalData`,
  `refreshLiveReadings`, `ensureSeries`).
- **Water Data Online at most hourly** (5a): KiWIS hourly values once an hour
  and daily series every 3 hours, carried in between with `Self::carry`, so
  refreshes are shorter and value-batch 504s rarer.
- **Steadier rain** (5d): fewer, larger Open-Meteo requests, a pause between
  batches, and only the batches that failed are retried next refresh.
- **Refresh now**: a button in the watch panel re-fetches live readings, at
  most once every 5 minutes (remembered across reloads); the page starts from
  the readings saved by the last visit and says why a saved copy wasn't used.
- **Per-source status** (5f): readings record when each source was fetched
  and recorded plus per-source `lastGood`, `lastError` and `errorCount` in
  `r["sources"]` (exposed in `/health` and shown in the Data status panel,
  which never sits stuck on "Loading").
- **Single FTP session & incremental downloads** (5b): `flood_warnings` and
  `flood_classes` share one `ftp::Session` per refresh (`flood_ftp_both`),
  use `LIST` sizes and mtimes cached in memory and S3
  (`readings-ftp-index.json.gz`), download only changed or new files, and
  drop entries for files that disappeared.
- **Observed rainfall** (item 3): `parse_rain_popups` reads the Bureau's
  `PopupRain` entries off `IDx653xx.html` (1/6/24 h totals per station);
  `r["rainObs"]`, a "Rain gauges, observed 24h (BoM)" layer coloured by the
  24 h total, totals in gauge reports, and heavy totals (≥ 100 mm/24 h) on
  the watch list.
- **Official road closures — every event type now** (item 1): `parse_qld_roads`
  (QLDTraffic events API, all open events — closures, flooding, crashes,
  works, hazards — each with the agency's reason) and `parse_nsw_roads`
  (Live Traffic NSW) fetched every 30 minutes by the broker; `r["roads"]`,
  a "Road closures and events (official)" layer with closure classes
  (`level`: closed / closed to through traffic / part closed / access
  restricted / lanes affected / caution) and popups (`Because of: <due>`),
  and major/closed events on the watch list. NSW needs a
  `NSW_TRAFFIC_API_KEY`.
- **Build without refetching** (5e): in runtime mode the site build reuses
  cached readings and warnings as the fallback instead of fetching Water
  Data Online and the Bureau on every push.
- **Service worker**: network requests give up after 20 s instead of hanging.
- **Bureau access**: the broker reads the Bureau only through its FTP server
  and ArcGIS map service, never posing as a browser.

## How the live side fits together

- `rust/flood-feeds`: all feed code shared by the broker and the build
  (Water Data Online/KiWIS, Qld WMIP, Bureau FTP: CAP warnings, river height
  pages -> flood classes and Bureau levels, storm tide CSV, Open-Meteo rain,
  watch list).
- `rust/flood-broker`: `readings.rs` (the refresh: stages with timings,
  carries old values when a stage fails, S3 store), `history.rs`, `lib.rs`
  (HTTP: `/v1/now`, `/v1/series`, `/v1/readings`, `/v1/levels`, `/v1/history`,
  `/health`), `lambda.rs`
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
- **The `shots-2d` branch holds only the latest run** (force-pushed); each
  run is also pushed to `shots-2d--<branch>` (e.g. `shots-2d--2d-fixes`), so
  read a branch's results there: `git archive origin/shots-2d--<branch> | tar -x`.
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

### 1. Official road closures — DONE

Why: the model says which roads a flood would cut; the agencies say which
are closed now. Side by side they show the situation and check the model.

Shipped (commits `48fcbb23`, then the clarity and all-events work): `parse_qld_roads`
(QLDTraffic events API v2; every open event — closures, flooding, crashes,
roadworks, hazards — with the agency's reason in `event_due_to`, the
specification's public key unless `QLD_TRAFFIC_API_KEY` overrides it) and
`parse_nsw_roads` (Live Traffic NSW; needs a `NSW_TRAFFIC_API_KEY`, otherwise
that state is skipped) fetched by the broker every 30 minutes
(`ROADS_EVERY_MS`) and carried up to 2 h when a fetch fails. Each item
carries `level` (`closed`, `closed to through traffic`, `part closed`,
`access restricted`, `lanes affected`, `caution`), `type`
(event_subtype/event_type), `due` (event_due_to) and `impact`
(impact_subtype); `closed` is only the "closed" levels, so a partial lane
closure no longer counts as "closed to all traffic". The viewer has a
"Road closures and events (official)" layer — polylines where the event has
a geometry, a dot where it only has a point — with a legend swatch per
level, popups (`roadClosurePopupHtml`) showing level, type, reason
("Because of: …") and impact, and major/closed events on the watch list.

Per-state feed access (probed live 2026-10-22; verify again before wiring):

| State | Feed | Access | Status |
| --- | --- | --- | --- |
| QLD | `api.qldtraffic.qld.gov.au/v2/events` | public key in spec | **live** (verified 2026-10-23: 683 events, all types kept) |
| NSW | `api.transport.nsw.gov.au` hazards: `/flood/all`, `/flood/open`, also `/incident/…`, `/fire/…`, `/roadwork/…`, `/majorevent/…`, `/alpine/…` | free API key | coded (flood feed), awaiting `NSW_TRAFFIC_API_KEY`; broaden to `/incident/all` when wired |
| WA | Main Roads WebEOC Road Closures ArcGIS (`services2.arcgis.com/cHGEnmsJ165IBJRM/.../WebEoc_RoadClosures/FeatureServer/4`) | open, no key | **live** (verified 2026-10-23): `parse_wa_roads`; `IncidentTy` (incl. Bushfire → `hazard: fire`), `ClosureTyp`, `TrafficImp`, polyline geometry |
| SA | `maps.sa.gov.au/arcgis/rest/services/DPTIExtTransport/TrafficSAOpenData/MapServer/0` (DIT Traffic SA) | open, no key | **live** (verified 2026-10-23): `parse_sa_roads`; point features, `REC_TYPE`/`DESCRIPTION`/`NO_LANES_CLOSED` |
| NT | `roadreport.nt.gov.au/api/Obstruction/GetAll` (Road Report NT API) | open, no key | **live** (verified 2026-10-23): `parse_nt_roads`; `response[]`, startPoint→endPoint line |
| TAS | `data.stategrowth.tas.gov.au/geoserver/ssg/ows` WFS `ssg:GEO_ROAD_WORKS` | open, no key | **live** (verified 2026-10-23): `parse_tas_roads`; roadworks, LineString geometry |
| ACT | ACT Gov ArcGIS `Public_Temporary_Road_Closures` (`services1.arcgis.com/E5n4f1VY84i0xSjy`, plus `_HISTORICAL` views) | open, no key | **live** (verified 2026-10-23): `parse_act_roads`; point features, `projectTitle`/`roadsClosed` |
| VIC | opendata.transport.vic.gov.au "Unplanned Disruptions – Road" (dataset `af595015-…`, resource `1b185c7f-…`) | API key (free registration) | real-time endpoint exists, published as an OpenAPI spec that requires a key |
| — | "Harmonised National Roadworks and Road Closures" (`spatial.infrastructure.gov.au/.../RADAR_Curated_Prod_roadworks`) | open | stale archive (last captures 2020) — do not use |

Sources (verify each with a probe first):

- **Queensland, QLDTraffic GeoJSON API** (Department of Transport and Main
  Roads). Feeds include Hazards, Crashes, Congestion, **Flooding**,
  Roadworks, Special Events, Web cameras. Specification:
  https://qldtraffic.qld.gov.au/more/Developers-and-Data/ (PDF "QLDTraffic
  website API specification", v1.10). The API is `https://api.qldtraffic.qld.gov.au/v2/events`
  with an `apikey` query parameter; the specification has historically
  published a public key for open use. The key and base URL were verified
  live (2026-10-22). We take **every open event** — the API's `event_type`
  filter param doesn't reliably filter anyway (it returned all 714 events
  whatever the value) — within the 150-item cap, closures first. The shared
  public key has a request quota: on 2026-10-22 it was exhausted ("You have
  exceeded the request quota assigned to your API key… email
  QLDTraffic@tmr.qld.gov.au"), emptying the roads layer until the quota
  resets; the broker now tries hourly (not half-hourly) instead of wasting
  the attempts. When TMR issues a dedicated key, store it as the
  `QLD_TRAFFIC_API_KEY` secret (the broker prefers it over the public one)
  and the layer recovers on the next refresh. Terms:
  provided "as is"; attribution "© The State of Queensland
  (Department of Transport and Main Roads)".
- **NSW, Live Traffic NSW hazards** (Transport for NSW, CC BY). GeoJSON
  FeatureCollections at `https://api.transport.nsw.gov.au/v1/live/hazards/`,
  one per category (from the hub's documentation, Aug 2025): `/flood/all`,
  `/flood/open`, `/flood/closed`, likewise `/incident/…`, `/fire/…`,
  `/roadwork/…`, `/majorevent/…`, `/alpine/…` — the flood feed we use is
  only one of them; extend to a broader category when the key lands.
  Properties:
  `headline`, `displayName`, `roads[]` (road name, suburb, ...), `isMajor`,
  `created` and `lastUpdated` (ms since 1970), `mainCategory`/`subCategoryA`
  (documented as unstable: don't rely on them). Needs a free Open Data Hub
  API key (https://opendata.transport.nsw.gov.au/), sent as the header
  `Authorization: apikey <key>`. Developer guide v1.9 (Oct 2023) on the hub.
  Store the key as a repo secret, pass it to the Lambda env in
  `broker-deploy.yml` (like `ALLOWED_ORIGINS`), never commit it.
- **Victoria**: the real-time "Unplanned Disruptions – Road" endpoint exists
  on opendata.transport.vic.gov.au (see the table) but is published as an
  OpenAPI spec that requires an API key (free registration, like NSW);
  register for one before building anything for Victoria.

Data shape in readings.json:

```json
"roads": {"fetched": "...", "sources": {"QLD": "ok", "NSW": "ok"},
  "items": [{"id": "qld:123", "state": "QLD", "road": "Warrego Hwy",
    "where": "Mitchell to Morven", "desc": "Water over the road",
    "closed": true, "level": "closed", "type": "Flash flooding",
    "due": "Flooding of river", "impact": "Road closed to all traffic",
    "major": false, "updated": "2026-10-21T04:00:00Z",
    "lat": -26.5, "lon": 147.9, "line": [[-26.5, 147.9], ...],
    "link": "https://qldtraffic.qld.gov.au/"}]}
```

Every open event, whatever its type (`type` is the agency's subtype or
event_type; `due` its reason). `closed` true only when the level says so;
otherwise the level buckets the impact (`part closed`, `access restricted`,
`lanes affected`, `caution`).

App:

- Layer "Road closures and events (official)", on by default when any:
  six closure classes as line colours/dashes (closed red, through-traffic
  closures dark orange, part closed orange, restricted brown, lanes
  affected yellow, caution grey) where geometry is a line, else a marker;
  popup with road, place, level, type, agency text, the reason
  ("Because of: …"), updated time and source link; the legend lists the
  classes and the count of official road events on now.
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

Sources (probed 2026-10-22; verify the unconfirmed ones before wiring):

- **NSW, RFS Major Incidents** — **shipped** (`0bb4e4d5`/`024c7b18`): `parse_nsw_rfs_emergency` in `flood-feeds`,
  `fetch_emergency` in the broker (every refresh, 15-min carry), `r["emergency"]` in readings.json,
  and an `Emergency warnings (state)` layer in the viewer (advice/watch_and_act/emergency colours).
  Feed: `https://www.rfs.nsw.gov.au/feeds/majorIncidents.json` (public, no key, live) — GeoJSON with
  `title`, `link` (Fires Near Me), `category` (Advice / Watch and Act / Emergency Warning /
  Planned Burn / Not Applicable) and a `description` with TYPE/STATUS/SIZE/COUNCIL/LOCATION. *Fire*,
  not flood — ideal for the fire extension too. NSW SES's own Hazard Watch (data.gov.au, publisher
  NSW SES) still has no listed feed URL: find it from hazardwatch.gov.au's dev-tools network tab.
- **Queensland, "Storm, flood and cyclone warnings" (CAP-AU XML)** by the
  Queensland Fire Department (data.qld.gov.au dataset
  `storm-flood-and-cyclone-warnings-capau-xml`): CAP-AU with warning areas,
  plus a point layer updated every 30 minutes. Find the file URL on
  data.qld.gov.au. CAP parsing exists already (`parse_cap_flood`; extend it
  for `<parameter>` AWS level fields and `<polygon>` areas, which
  `cap_polygons` already reads).
- **Victoria, VicEmergency**: the site's events API needs a community API
  key (register interest with EMV). Treat Victoria as optional until a key
  exists.
- **WA, DFES**: incident feed exists but the obvious path guesses returned
  404 (20/10); find the correct URL (Emergency WA map's dev-tools tab) —
  ~30 min detective task.
- **SA, CFS**: same — the incident feed isn't at the guessed path
  (`cfs.sa.gov.au/data/incidents.json`, 404); find the correct one.
- **ACT, ESA**: esa.act.gov.au responded but the feed path is unverified —
  confirm before wiring.
- **NT / TAS**: thin emergency-incident feeds; treat as low value for this
  map and skip for now.
- Fire angle: where an incident feed carries fire hazards (NSW RFS above;
  WA's road feed tags bushfire), tag items `hazard: fire` so the roads
  layer and popups show them the same way (see WA row in the item-1 table).

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

### 3. Observed rainfall — DONE

Rain that has fallen (since 9 am, last 24 h) at the Bureau's flood-network
rain gauges: often the first sign of a flood.

Shipped (commit `48fcbb23`): `parse_rain_popups` reads the `PopupRain(...)`
entries on the Bureau's `IDx653xx.html` FTP rainfall pages (name, station,
lat/lon, and the 1 h / 6 h / 24 h totals as reported), returned by
`flood_ftp_all` alongside the flood classes and merged through the same
single FTP session. `r["rainObs"]` keys station → totals; the viewer draws a
"Rain gauges, observed 24h (BoM)" layer coloured by the 24 h total (blue ×
50 mm × 100 mm), the gauge report shows the observed totals next to the
forecast rain, and the watch list flags heavy totals
(`RAIN_OBS_24H_MM = 100.0`).

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

### 5. Fetching improvements (5a-5f are done)

Measured on a refresh (21 Oct): 196 s in all, of which Water Data Online
(KiWIS) 189 s; recurring errors are KiWIS `HTTP 504` on value batches and
Open-Meteo `timeout: connect` on rain batches. The Bureau's FTP pages now
give fresher levels (hourly, `bureauLevels` ~1,500 gauges) than KiWIS
(about a day behind). Stage timings are in the refresh summary
(`stageSeconds`) and the deploy's probe notice.

**5a. Ask Water Data Online less often (biggest win) — DONE.**
- In `readings.rs`, split the readings stage: Bureau FTP levels and Qld
  live levels every refresh; KiWIS hourly values every hour and daily
  series every 3 hours, carrying the previous values in between
  (`Self::carry`, like rain and sea).
- Skip KiWIS value requests for stations whose FTP Bureau level is newer
  than KiWIS can be (they're replaced by `bureau_levels` anyway); still
  fetch their daily series on the slow cycle for the sparkline.
- Expect most refreshes under ~30 s (Lambda cost down ~4x at 128 MB), and
  far fewer 504s. Check: `stageSeconds.readings` in the summary; levels
  count and kinds unchanged in `tests/broker-live.js` notices.

**5b. FTP: only changed files, one connection — DONE.**
- `flood_warnings` and `flood_classes` each open a session and download
  every file. Use one `ftp::Session` per refresh for both; `LIST` gives
  sizes and modification times: keep `{name: (size, mtime, parsed)}` from
  the last refresh (in the stored readings, or a small
  `readings-ftp-index.json` in S3, key must start with `readings`) and
  download only files that changed or are new; drop entries for files
  that disappeared (expired warnings).
- Add a test with a fake session (list twice, second time one changed
  file: one download).

**5c. Split what the app downloads — DONE.**
- Today the app fetches all of readings.json (~2 MB raw, ~170 KB gzipped)
  whenever it changes, mostly the per-gauge daily series.
- Serve a small "now" document (`/v1/now`: latest level per gauge with
  kind/time/rise, warnings with outlines, watch list, flood classes, sea,
  rain totals; target 20-40 KB gzipped) that the page polls, and per-gauge
  series on demand (`/v1/series?site=`, like `/v1/history`), fetched when a
  report opens. Keep `/v1/readings` for the build/tests and older clients.
- App: `loadNationalData` and `refreshLiveReadings` read `/v1/now`;
  `levelReadingHtml` asks for series lazily (cache per station, 10 min),
  falling back to the daily sparkline only when present. The service
  worker's `BROKER_PATH` must include the new paths.
- Check on a phone-sized viewport in `shots2d` (bytes on the wire in the
  broker check: `curl --compressed -w '%{size_download}'`).

**5d. Steadier rain forecasts — DONE.**
- Open-Meteo batches fail to connect (one try per batch, 150 s budget, so
  a failed batch waits 3 h). Fewer, larger requests (check its limits on
  locations per request), a short pause between batches, and on the next
  refresh fetch only the batches that failed (remember them with the
  carried rain) instead of waiting for the 3-hour cycle.

**5e. The site build shouldn't fetch live data twice — DONE.**
- Commit `149e738c`: in runtime mode `build.yml` reuses `cache/readings.json`
  as the published fallback (`NATIONAL_SKIP_READINGS=1` makes
  `flood national` keep the existing copy instead of fetching Water Data
  Online), reuses `cache/floodinfo.json` for the warnings fallback, and
  stores both in a monthly `readings-fallback-*` cache. The static gauge,
  storage and station data is still rebuilt every push.

**5f. Health per source — DONE.**
- Shipped: readings record when each source was fetched and recorded
  (clock times and live times per source), plus per-source `lastGood`,
  `lastError` and `errorCount` (`wdo`, `qld`, `warnings`, `warningAreas`,
  `floodclass`, `rain`, `sea`) in the refresh summary and readings
  (`r["sources"]`), exposed in `/health` and shown in the app's Data
  status panel (which never sits stuck on "Loading").

**5g. Cache what we can, ask too often for nothing (design notes; open).**

Why: the QLDTraffic public key's quota ran out on 22 Oct and the roads
fetch went on trying every 30 minutes even though every 429 said the same
thing; Water Data Online takes ~95% of a refresh when asked (5a fixed the
worst); the site build refetches what the broker already holds (5e fixed
the runtime build). Three rules, mostly to adopt generally rather than
invent:

1. **Ask no more often than the source changes** — the cadences are
   scattered constants today; a single table (name, URL, every, carry,
   backoff) next to `ROADS_EVERY_MS` etc. in `readings.rs` would make
   them auditable at a glance:

   | Source | Ask | Carries | Ref |
   | --- | --- | --- | --- |
   | QLD live levels, warnings, flood classes, sea | every refresh (15 min) | — | — |
   | Water Data Online levels / daily series | 1 h / 3 h | in between | 5a |
   | Rain forecast | 3 h cycle, batches resume individually | whole doc | 5d |
   | Roads (QLD+NSW) | 30 min; hourly while over quota | 2 h, 24 h for floodclass | db5d818a |
   | Site build | reuses cache/readings.json | — | 5e |

2. **Back off on upstream refusals, per source**: on HTTP 429 (and an
   upstream `Retry-After` when present), stop asking that source for an
   hour, then 4 h, then let the day's quota go; a source in backoff skips
   its next attempts and serves its carried copy, and the backoff state
   should show in the source health (`lastError`/`errorCount` from 5f
   already carry the pieces). Roads does the 1-hour step (`db5d818a`);
   generalize it to every fetcher with a test like
   `qld_traffic_over_quota_is_asked_hourly_not_every_half_hour`.
3. **Serve from cache, validate in the background**: the service worker
   already cacheFirsts tiles/terrain/elevation and networkFirsts API and
   broker answers; candidates to flip are (a) map-service answers
   (council/states/census — stale-while-revalidate: serve the cached
   copy, refresh in the background, freshness matters less for planning
   overlays), and (b) `stale-while-revalidate` on the live broker paths
   with the ETags the broker already answers (a reloaded page today
   re-pulls ~226 KB gzipped where a 304 would end it). Do not flip
   warnings or road events network-first to cache-first: they are
   life-safety and must stay fresh-first.

Check: after a planted 429 a refresh makes exactly one call (the roads
test pattern); `/health` shows the backoff; `tests/broker-live.js`
stays green.

### 6. Smaller items

Follow-ups from 2026-10-22 (verify once the pending publishes land):

- **Firefox black tiles** (`b89ca9e8`): the hardened service worker ships with
  the viewer build that was still publishing when this was written. Confirm a
  reload clears any black tiles; if one session stays black, clearing site
  data (DevTools → Storage) is the workaround. The bundled Playwright Firefox
  on the dev machine won't launch ("Could not find profile folder"), so
  `tests/sw-tiles.js` couldn't run locally — its Chromium half passed on the
  live site; rerun both halves once the local binary is fixed (reinstall
  playwright's firefox, or fix the profile folder).
- **QLDTraffic key quota** (`db5d818a`): the shared public key was exhausted
  (HTTP 429) and emptied the roads layer until the quota resets; the broker
  now retries hourly while over quota. When TMR emails a dedicated key, add
  the `QLD_TRAFFIC_API_KEY` repo secret and pass it to the Lambda env in
  `broker-deploy.yml` (like `NSW_TRAFFIC_API_KEY` would be); the broker
  prefers it already. Then confirm `/health` shows
  `sources.roads.lastGood` fresh and the layer repopulates.
- **All-events roads layer** (`4383dfe4`): the layer now takes every
  QLDTraffic event type; on the live site it'll be visible once the QLD
  quota allows (or with the dedicated key). Verify the legend's six classes,
  a popup's "Because of: <due>" line and the all-events wording on the live
  site; the old "flooding filter" wording anywhere else in docs already was
  updated to match.

- **Broker smoke-test flakiness**: the deploy run shows "failure" even
  though the function and refresh succeed, because the post-deploy
  `/v1/levels` check hit a transient "the Queensland Water portal did
  not answer". Either make that smoke step tolerant (exit 0 with a
  warning, or retry the levels check) or drop it and rely on the readings
  check alone, so the badge stays green on a normal deploy.

- **Bureau links**: the user saw some fail; which ones is unknown. The
  warning link is `https://www.bom.gov.au/products/<ID>.shtml`; the Bureau's
  new site may have moved warnings. Ask before changing.
- **Google Flood Hub**: the build step is ready; it needs
  `FLOOD_FORECASTING_API_KEY` as a repo secret.
- **Email/SMS alerts**: on hold by the user's choice (would be SNS from the
  refresh; topic in the stack, subscription made by hand, places in a repo
  variable, never committed).
- **Branches to delete**: done — all merged `2d-*`, `3d-*`, `shots-*`, `readings-*`,
  `deps-webpki` and `probe-*` branches were removed. Remaining remote branches:
  `2d-downstream`, `2d-roadtime`, `3d-opacity`, `aws-sync-main-46b6606d`,
  `probe-data`, `probe-qld`, `rust-vendor`, `shots-2d`.

### 7. Model every forecast peak at once; places where a flood might be expected — DONE

A button in the Warnings/watch panel ("Model forecast peaks") that, for every
current item that predicts or threatens a flood, adds the place and — where a
river level is known — builds the flood model too, rather than the user doing
it gauge by gauge.

Shipped (commits `dc55ff21`+): the watch panel shows the button with the
pending counts ("model the 5 forecast peaks and add 60 places") whenever there
is anything to add. One press builds the models first (the slow part: each
downloads its elevation live from the national service), then pins gauge
reports for the watch list's river/flood items — at most 5 new things per
press, and the button stays with what's left. `pendingWatchWork()` dedupes by
gauge (two warnings naming one gauge keep the higher peak), skips gauges that
already have a model, and a build that fails because the elevation service is
refusing requests (429) stops the batch and asks for a retry instead of
failing the rest the same way. Tested live in the browser against the broker:
five peak models built (Stanley, Condamine, Warrego, Bulloo, Barcoo), 60+
watch-list places pinned. Test hooks: `__floodPendingWatchWork`,
`__floodModelPeaks`.


### 8. Fire overlays (current and historical; open research)

Current fire data already in the app:
- **NSW RFS major incidents** — live point incidents with alert levels
  (Advice / Watch and Act / Emergency Warning), shipped as the
  `Emergency warnings (state)` layer (`0bb4e4d5`/`024c7b18`); hazard tagged
  `fire` unless the text says flood.
- **Road closures** tagged `hazard: fire` where the agency reports a
  bushfire (WA's WebEOC feed carries `IncidentType: Bushfire`; QLD has a
  handful).

Available but not yet wired:
- **Other states' current fire incidents** — VIC (CFA/DELWP, community key),
  WA (DFES — feed path to find), QLD (QFES alerts), SA (CFS), ACT (ESA).
  These arrive for free with item 2 (emergency warnings), which already
  started with NSW RFS as the proven pattern.
- **NASA FIRMS hotspots** (MODIS/VIIRS) — public, near-real-time point
  hotspots; small effort as a live overlay like rain obs; needs a free
  MAP_KEY. Good for "what's burning now" nationally.
- **Historical fire perimeters** — Geoscience Australia "Bushfire
  Historical Extents v3" (national, shapefile ZIP), plus state datasets
  (NSW FESM, VIC FHIRES, WA, SA). Large; needs conversion to GeoJSON/tiles
  before they can be an overlay — comparable effort to the recorded-flood
  overlays. High value for "past fires" but a data-prep task.

Recommendation: extend item 2 to more states first (current warnings, incl.
fire); FIRMS hotspots as a quick follow-up; historical perimeters only if
wanted as a recorded-fire overlay.

### 9. Model a flood warning area (polygon) instead of only a rectangle — bbox version shipped

Why: the Bureau's "Flood warning areas (BoM)" are catchment polygons, but the
flood model only runs on a rectangular grid the user draws. A warning area
already says where the flood is expected, so modelling it (rather than a
hand-drawn box) is the natural next step.

Two levels of effort:
- **Cheap (bbox) — shipped** (`d10aa5eb`): a "Model this warning area" button on the warning
  popup and in the warning list that creates a model area from the polygon's
  bounding box (reusing `modelHere` with `center`/`halfKm` from the bounds,
  capped 5-15 km). The polygon stays on the map as the boundary. Caveat: the
  model still computes a rectangle, so water is shown outside the warning
  area too.
- **Proper (polygon clip) — shipped** (`1282763e`): the model area now
  carries `area.polygon` (the warning rings); `composeWater()` skips cells
  whose centre is outside the polygon (ray-casting point-in-polygon, holes
  supported), so the flood raster and `floodPixels` count only show water
  inside the warning area. The terrain relief base is left as the full bbox
  for context. The model still computes the rectangle underneath, but the
  display and totals are clipped.

Recommendation: ship the bbox version first (it reuses `modelHere` and the
existing peak button), then decide whether the clipping is worth it.

### 10. Desktop version (offline-first) — phase 1 in progress

Phase 1 started (`b75b5fac` + scaffold in `desktop/`):
- `Store::Local` in `readings.rs`: reads/writes `readings.json` (+ `.gz`) to a
  data dir; `latest()` loads from disk on cold start, `refresh()` persists.
- `main.rs`: `FLOOD_STORAGE=local`, `FLOOD_DATA_DIR=<path>` or `--data-dir`
  select local mode; refresh loop runs in-process (as it already did for
  in-memory). Verified locally: broker serves on 8787 and writes readings.json.
- Tauri 2 scaffold in `desktop/`: `Cargo.toml`, `tauri.conf.json`,
  `src/main.rs` + `src/lib.rs` (runs the broker in-process in local mode),
  `desktop/README.md` with build steps. `beforeBuildCommand` sets
  `FLOOD_BROKER_URL=http://127.0.0.1:8787` so the webview points at the
  local broker; national data bundled via `bundle.resources`.

The broker now runs in-process on loopback port 8787; a bind failure stops
startup. Desktop elevation uses the local `/v1/elev` proxy. The frontend build
uses `DATA_SOURCE=runtime` for live readings. See `desktop/README.md` for
current build steps. Phases 2-3 (bundled data, offline badge, signed installers
and updater) remain follow-ups. See `ROADMAP.md`.

### 11. Rendering pipeline in Rust (WASM for web, native for desktop) — in progress

Steps 1-2 and 4 (canvas) shipped (`ba527775`, `2a4847b1`, `7880fda4`):
`composeWater()` now tries the Rust/WASM `composeWater` op first (with JS
fallback), and the flood raster renders via `setPixels` on a canvas overlay
instead of `toBlob`+PNG+`setUrl`, removing the encode step. Step 3 (desktop
reuse) comes with the desktop version; step 4's WebGL texture upload remains
an optional follow-up (canvas is now fast enough that WebGL is not urgent).

### 12. Settings: cloud settings.ini + desktop settings page

The standalone broker reads `--settings <path>`, `FLOOD_SETTINGS`, or
`./settings.ini`, in that order. Non-empty environment variables take
precedence. Host configuration is loaded at startup; traffic keys are re-read
when road feeds refresh. Supported configuration uses the names in
`rust/flood-broker/src/main.rs` (including `WORKERS`, `CACHE_MINUTES`, and
`READINGS_REFRESH_MINUTES`).

The desktop gear button saves QLD and NSW traffic keys to `settings.ini` in
its data directory (default `~/.flood-explorer/`), or `FLOOD_SETTINGS` when set.
The in-process broker reads that same file on road-feed refresh, without
restarting. The web build leaves key management to the broker host.

Optional follow-ups: immediate refresh after saving and per-source status
in the Settings panel (`/health` exposes lastGood/lastError).


### 13. Tsunami coastal experiments and dispersive methods (25 Oct 2026)

The client-side Rust/WASM prototype is at `tsunami.html`. See
[the current prototype notes](tsunami-prototype.md) for implemented methods,
terrain provenance, scene selection, overlays, controls and validation.

The next modelling work is recorded under
[Tsunami: data, coastal coupling and dispersive waves](../ROADMAP.md#tsunami-data-coastal-coupling-and-dispersive-waves-25-oct-2026):
verified bed/land data and vertical datums; identified offshore scenarios and
boundary time series; tide and upstream river flow; coastal grid refinement;
an optional Boussinesq-type dispersive solver; and sensitivity ensembles.

Dispersive modelling means wavelengths can travel at different speeds, changing
pulse shape as it propagates. It is a proposed additional physical model, not
another name for the existing linear finite-volume method or its numerical
damping. No dispersive solver has been implemented. The roadmap lists the
physics, wet/dry coupling and runtime checks required before offering it.
