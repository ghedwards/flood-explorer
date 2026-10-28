# Bundled tsunami terrain data

The application code is MIT licensed. These third-party geographic datasets
retain their own licences and are not relicensed under MIT.

* `moreton.json`, `gold-coast.json`, `coffs.json`, `newcastle.json`, `sydney.json`, `sunshine-coast.json`,
  `port-macquarie.json`, `wollongong.json`:
  Geoscience Australia 2009 bathymetry/topography, CC BY 4.0. Attribution and
  source URLs are stored in each file.
* `pine-estuary.json`, `brisbane-mouth.json`, `currumbin.json`: Queensland QldDem mosaic. CC BY-SA, as specified in the
  [service metadata](https://spatial-img.information.qld.gov.au/arcgis/rest/services/Elevation/QldDem/ImageServer/info/metadata).
  This clipped/resampled numeric dataset is shared under the same CC BY-SA
  terms. The source metadata does not specify a licence version. Attribution,
  required acknowledgements, source URL and modifications are retained in the
  JSON and displayed in the prototype. Bathymetry is not for navigation.

No permission to replace missing bathymetry or assume a tidal datum is implied.

* `places.json`: selected name/coordinate facts from the Composite Gazetteer of
  Australia, Geoscience Australia and Queensland/NSW naming authorities. Original
  reference IDs and the source URL are retained. These are reference points,
  not surveyed boundaries or navigation positions.

* `gold-coast-seaway.json`: Branson, Paul; Hally, Bryan; & Steven, Andy (2025):
  Composite Topography-Bathymetry Digital Elevation Model for Queensland
  Estuaries. v1. CSIRO. https://doi.org/10.25919/1xzm-pw88.
  © CSIRO 2025, **CC BY 4.0**. Derived by reprojecting model cell centres from
  EPSG:7856 into EPSG:9473 and sampling the nearest 5 m source pixel at each
  50 m model cell centre. Elevations retain AVWS (EPSG:9458), rounded to 1 mm;
  source flags are retained. No vertical datum mixing or local gap filling.
  This replaces an incomplete QldDem export (six NoData cells) with a complete
  CSIRO grid, including source-provided interpolation and modelled creek depths.
  Run `node scripts/prepare-tsunami-csiro.js` to recreate.

Missing samples in any local grid remain null with `valid=0`; the solver
excludes them as impermeable cells and magenta hatching marks them unknown.
CSIRO source classes and percentages are shown separately; amber optionally
highlights interpolated, modelled-creek and coarse-base cells. Completeness
and fine source grid spacing do not guarantee surveyed bed coverage.

`gold-coast-seaway-tidal-planes.json` holds the Gold Coast Seaway's tidal planes (Maritime
Safety Queensland, 2026, heights above Queensland Port Datum) for `scripts/tide-sweep.js`. It is
not loaded by the viewer. Its `verified` flag is false: the values were read from a search
summary of the published table and not yet checked against the table itself. Its `gaugeCheck` field says how they compare
with Maritime Safety Queensland's gauge records.

`gold-coast-seaway-tide-analysis.json` is the output of `scripts/tide-analysis.js` on those gauge records (observed and
predicted 10-minute levels at the Seaway, 2016-2025, CC BY 4.0, data.qld.gov.au): fitted tidal constituents, the planes they give,
the gauge minus the prediction, and how often the sea sits nearest each tide state (`stateWeights`, used by `scripts/tide-sweep.js`).

`brisbane-bar-tidal-planes.json` and `brisbane-bar-tide-analysis.json` are the same for Maritime Safety Queensland's Brisbane Bar gauge
(2023 to 2025 observed levels and the 2025 and 2026 predictions, CC BY 4.0, data.qld.gov.au), for the Moreton Bay and Brisbane River places. The planes are
fitted by `scripts/tide-analysis.js`, not read from a published table, so `verified` is false; only three observed years were open, so no sea-level trend
is removed from the state weights. `scripts/ensemble-ptha.js --tide brisbane-bar` uses them.

`extents/` holds the per-cell tsunami flood rates for the main map's "Tsunami flood hazard" layer, one file per modelled place and an `index.json` listing them
(built by `scripts/prepare-tsunami-extents.js`; see docs/tsunami-prototype.md). They combine PTHA18 (Geoscience Australia, CC BY 4.0) with the place's terrain and carry
both attributions; the Gold Coast Seaway grid is CSIRO's, CC BY 4.0.

