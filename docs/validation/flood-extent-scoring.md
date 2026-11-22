# Scoring a modelled flood against a mapped outline

`flood extent-skill` compares a modelled flood depth grid with a reference flood outline, such as a
council's mapped extent of a past flood.

```sh
flood extent-skill <model_depth.tif> <outline.geojson> [--thresholds 0.05,0.1,0.3] [--margin 500] [--out report.json]
```

## Inputs

- **Model:** a depth GeoTIFF in metres with a CRS. The viewer's own GeoTIFF download is in longitude and
  latitude, and projected grids (MGA, UTM, Web Mercator) work too. Cells need not be square.
- **Reference:** GeoJSON in longitude and latitude (Polygon, MultiPolygon, Feature or FeatureCollection),
  for example what an ArcGIS service returns with `f=geojson`. Holes are respected.

## What is counted

- A model cell is wet when its depth reaches a threshold (0.05, 0.1 and 0.3 m by default). A reference
  cell is wet when its centre is inside the outline.
- Cells with no model value are left out and never counted dry. The report says how many reference cells
  were left out.
- Only cells inside the outline's bounding box plus a margin (500 m by default) are scored. Without it a
  large model area adds false alarms for water the outline does not map, such as rivers and lakes.

## What is reported, for each threshold

| Figure | Meaning |
|---|---|
| CSI | hits / (hits + misses + false alarms); 1 is a perfect match |
| captured | share of the reference's cells the model wets |
| extra | share of the model's wet cells outside the reference |
| area ratio | modelled wet area over reference area; above 1 over-predicts |
| hit, miss, false alarm km² | the same cells as areas |

## Limits

- An outline is a map, not an observation. Council extents are themselves modelled, mapped to a stated
  event and may not include every source of flooding, so a mismatch is not proof the model is wrong.
- The model's water includes the river channel. If the outline leaves the channel out, those cells count
  as false alarms; the margin only limits how far from the outline they are counted.
- The scoring is only as good as the run behind it: the rain, the losses and any river level feeding the
  model must be those of the mapped event.
- **No event has been scored yet.** Scoring the February 2022 Brisbane flood needs the recorded rain, the
  council outline and a model run, none of which could be fetched from the build sandbox. Results go here
  once someone runs it.
