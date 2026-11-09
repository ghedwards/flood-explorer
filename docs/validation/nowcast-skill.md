# Nowcast skill harness

`flood nowcast-skill` scores the radar forecast (`rust/flood-core/src/nowcast.rs`) against the
simplest alternative, keeping the latest frame unchanged ("persistence"), on an archive of
real radar frames. It is the harness for item 3 of the validation plan in
[../radar-nowcast-design.md](../radar-nowcast-design.md). **No real archive has been scored
yet**: the only runs so far are on synthetic storms, where a clean translating rain cell is
forecast almost perfectly. Those runs show the harness works, not that the forecast does.

## Run it

```sh
flood nowcast-skill <radar_dir> [--history 4] [--max-lead 12] [--thresholds 1,5,10] \
                    [--max-speed 25] [--out report.json]
```

`<radar_dir>` is the broker's folder format ([broker/README.md](../../broker/README.md)):
`radar.json` plus one little-endian `f32` mm/h file per frame, NaN where nothing was
measured. Use data you have the right to use; the command fetches nothing.

## What it does

- Splits the archive into runs of consecutive frames at the commonest spacing; a time gap starts
  a new run.
- At each origin frame, estimates the rain's motion from the last `--history` frames, carries the
  origin frame forward to leads of 1 to `--max-lead` steps, and compares each with the frame that
  really came then. Persistence is the origin frame itself.
- Skips, and counts, origins whose frames have a missing cell, and origins with too little rain to
  match.
- Reports per lead, pooled over all origins and cells: RMSE of both, skill (`1 - rmse_nowcast /
  rmse_persistence`; above 0 beats persistence), the bias ratio (forecast rain over observed
  rain), and for each rain threshold the critical success index of both, plus probability of
  detection and false-alarm ratio for the forecast.

## Reading a report

- Skill near 1 is a near-perfect forecast; 0 is no better than persistence; negative is worse.
  Expect it to fall with lead. The lead at which it drops below 0 is the longest forecast worth
  showing.
- A bias ratio far from 1 means the forecast is systematically too wet or too dry; that is what
  a gauge adjustment would address.
- Compare the CSI at your flood-relevant thresholds (say 10 and 25 mm/h), not just the RMSE,
  which is dominated by the many near-dry cells.
- `originsGappy` and `originsDry` say how much of the archive was not scored; a high share means
  the score describes only the clean, rainy part.
- It scores the rain field only. It says nothing about the flood the solver makes from it.

## Not yet done

Scoring on real archived radar, per-storm-type breakdowns (stratiform against convective), a
comparison of radar against rain gauges, and a hindcast through the solver against recorded
flood outlines. See the validation plan.
