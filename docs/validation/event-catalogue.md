# Past floods we can compare the model against

Some river systems have far more recorded history than others. This pairs each flood event the project
already knows about (`config/events.json`, which sets rain and gauge windows) with the mapped outline of
that flood the viewer can score against (the `RECORDED` list in `viewer/app.js`, behind "compare with
recorded floods" and `flood extent-skill`).

Gauge records and rain records for each window are **not verified here**: the build sandbox cannot reach
the Bureau's data. Treat "gauge and rain" as to be checked when a run is made.

## Systems with the most to compare against

| System | Mapped outlines in the app | Event windows configured | Notes |
|---|---|---|---|
| Brisbane and Bremer rivers (including Ipswich) | 1893 (State, moderate confidence), 1974 (Council and State), 2011 and 2022 (Council); January 2011 Queensland towns | Brisbane 2011, Ipswich 2011, Brisbane 2022 | Four events from 1893 to 2022 on one catchment: the best test of whether one model setup holds across very different floods. |
| Burnett (Bundaberg) | 2010 and 2013 | Bundaberg 2013 | Two mapped events; no window for 2010. |
| Logan and Albert rivers | 2017 | Logan 2017 | One mapped event. |
| Fitzroy (Rockhampton) | 2017; January 2011 Queensland towns | Rockhampton 2017 | The 2011 lines are what the smoke test scores against (CSI 0.48 at its last run). |
| Roma (Bungil Creek) | April 2011, drawn from aerial photographs flown near the peak | none | Added with this catalogue. Strongest kind of outline, a single small town. |
| Victorian rivers | Victoria's flood history layer, grouped by event | Shepparton, Rochester, Echuca (October 2022) | Whether the layer holds October 2022 has not been checked. |
| South-west and western Queensland | 2012 and 2019 lines | none that match (Wagga 2012 is in New South Wales, Townsville 2019 is north-east) | Outlines with no event window. |

## Events with a window but no mapped outline in the app

Gold Coast 2017 (Coomera and Nerang), Mackay 2008, Townsville 2019, Cairns 2023, Maroochy 2022, Gympie
2022, Lismore 2022 (the viewer uses satellite water maps there), Windsor 2021 and 2022, Kempsey 2021,
Maitland 2022, Forbes 2022, Wagga Wagga 2012. These can be scored against satellite water observations or
a council outline once one is found; none is wired in.

## Outlines with no event window yet

1893 and 1974 (Brisbane and Bremer), 2010 (Bundaberg), April 2011 (Queensland towns), April 2011 (Roma),
2012 (south-west Queensland), 2019 (western Queensland). The 1893 and 1974 floods predate rain and gauge
records of the kind the replay needs, so they can only be compared by setting a river level.

## How reliable each outline is

- **Aerial photographs near the peak** (Roma 2011, much of January 2011): a photograph of the flood itself.
- **Council mapping of recent events** (Brisbane 2011 and 2022): modelled and surveyed, usually good, but
  maps of one event, not observations everywhere.
- **Historic lines** (1893, 1974): built from flood marks and old surveys. The 1893 layer says that where
  no source data is available the line follows the river bank or centreline, and rates its confidence
  "moderate".
- A mismatch against any of these is not proof the model is wrong.

## Not wired in yet

The State FloodCheck service also lists a flood-levels layer and basic and comprehensive study layers.
Flood levels (marks at known places) would score depth, not just extent.

## Suggested order

1. Brisbane 2022, then 2011, then 1974 and 1893, with one setup, scored with `flood extent-skill`.
2. Roma 2011, a small catchment with a good outline.
3. Bundaberg 2013 and 2010.
