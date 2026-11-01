# Visual baselines

Reviewed map-only scenes for the built viewer, generated with the Playwright
version in `metadata.json` on Ubuntu Noble. The baseline PNGs are expected
images; normal tests never overwrite them. Missing baselines fail.

| Scene | Coverage |
|---|---|
| `national` | Six fixed forecast/tide gauges and loaded basemap tiles |
| `river-depth` | Synthetic river-valley flood extent, depth colours and model boundary |
| `river-hazard` | Hazard colour bands for the same scenario |
| `impact` | Flooded/cut-off road segments and evacuation/site markers |
| `timeline` | A fixed step at 35% of the generated timeline with updated water and roads |

The renderer is the actual built application and Rust/WASM model. Network
routes supply fixed gauge data, a synthetic GeoTIFF, a seeded synthetic town
and a repeated street tile; unhandled external requests are blocked. Terrain
and town fixture functions are shared with `tests/impact-browser.js`. The
viewport is 960 × 640 at DPR 1, light mode, en-AU, Australia/Brisbane. A clock
advances from a fixed epoch so Leaflet's JavaScript fades can finish. Captures
wait for tiles, images, fonts and consecutive identical screenshot buffers.

Floating UI, labels/tooltips and Leaflet controls are hidden only during map
capture. This suite checks map compositing, not panel typography or the content,
availability and geographic accuracy of live upstream imagery. Live smoke
screenshots remain diagnostics for those services.

Run locally after building:

```sh
npm ci
npx playwright install chromium
npm run build
npm run test:visual
npm run test:visual:verify
```

`test:visual:verify` deliberately hides `.flood-layer` and checks that the normal
runner exits unsuccessfully for a **river-depth pixel mismatch**, with a diff
image. An unrelated startup failure does not count as successful detection.

Pixelmatch uses a 0.1 colour threshold and excludes antialiased edge pixels.
The changed-pixel limit is 0.5% for model scenes; the sparse national markers
use 0.005% so disappearing gauges cannot pass under a large background.
Viewport size changes fail. A Playwright version change requires baseline
regeneration/review, with the corresponding pinned container version updated.

## Updating expected images

Update deliberately after reviewing an intended rendering change. Build first,
then generate in the pinned Linux environment (Docker must be available):

```sh
docker run --rm --network none --ipc=host \
  --mount "type=bind,src=$PWD,dst=/work" -w /work \
  mcr.microsoft.com/playwright:v1.64.1-noble npm run test:visual:update
```

This reuses the built `site/`, compiled `viewer/flood.wasm` and installed
`node_modules/` from the checkout; the runner does not need network access.
Review all five PNGs and `metadata.json`, then run comparison twice and the
intentional-regression check in that image:

```sh
docker run --rm --network none --ipc=host \
  --mount "type=bind,src=$PWD,dst=/work" -w /work \
  mcr.microsoft.com/playwright:v1.64.1-noble \
  sh -c 'npm run test:visual && npm run test:visual && npm run test:visual:verify'
```

`npm run test:visual:update` also runs natively for development, but use the
Linux environment for committed baselines. Updates are refused whenever `CI`
is set; `UPDATE_VISUALS` does not enable updates. Do not generate with a hidden
flood layer; the runner refuses `--update --hide-flood`.

Expected/actual/diff PNGs go to ignored `test-results/visual/`. The intentional
failure has its own `test-results/visual-regression-proof/` so it does not
replace a normal run's evidence. The Browser checks workflow uploads both
under **visual-comparisons**, including on failure. Commit the reviewed baseline
PNGs with the rendering change; never promote CI actual images automatically.
