# Tsunami propagation lab

Open `tsunami.html` in the built viewer (or use the link in About). For local
development, run `npm run serve` and visit `/tsunami.html`. The model runs in
a dedicated browser worker using the existing Rust-to-WASM bridge. It needs
no feeds, API key or server-side simulation.

The prototype explores propagation, reflection and refraction.
It includes uniform ocean, continental shelf, and island/shelf bathymetries,
a movable paired uplift/subsidence pulse, pause/step/reset, a maximum absolute
displacement view, three virtual gauges and CSV export. The canvas uses basin
coordinates in kilometres for idealised cases. Eight Australian east-coast
subsets use geographic bounds and show the source latitude/longitude.

## On the main map: offshore tsunami hazard

The main map has a "Tsunami hazard: offshore wave height (PTHA18, experimental)" layer in its Layers panel (section "Tsunami"). It
draws PTHA18's hazard at about 2,000 hazard points around Australia (the mainland, Tasmania, the Great Barrier Reef, the Coral Sea
islands and Lord Howe; Indonesia, Timor, Papua New Guinea and New Zealand are cut out, as are the external territories) at roughly 100 m
depth, coloured by the wave height for a return period chosen in the Layers panel (1 in 100, 250, 500, 1,000 or 2,500 years; 500 to start with).
Zoomed out, about a third of the points are drawn (those that are the pick of a 0.5 degree cell) so the shelf seas do not show as solid blocks.
Tapping a point gives the wave height at every return period, with PTHA18's 16th to 84th percentile range at 500 and 2,500 years.

The numbers are PTHA18's logic-tree mean hazard curve summed over every source zone, stochastic-slip scenarios, as the largest wave height above
mean sea level without tide. They are heights at sea on a coarse 1 arc-minute linear model, not where the land floods. The file
`viewer/public/tsunami-data/ptha18-hazard.json` (about 150 KB, loaded when the layer is first switched on and cached by the service worker) is built by
`node scripts/prepare-tsunami-hazard.js`, which reads the exceedance-rate tables from the NCI THREDDS server in bulk. For example, off the Gold Coast (the point at
28.0°S 153.67°E, 69 m deep) the 1-in-500-year wave is 1.32 m (range 0.68 to 1.57 m), off Sydney about 0.9 m and off Perth about 0.6 m.

### Running a scenario live on the main map

The main map has a "Tsunami" tool (the wave icon in its side rail) that runs one curated PTHA18 scenario live in your browser and plays it over the map, in the same Rust /
WebAssembly worker the lab uses (`viewer/tsunami-worker.js`), so nothing is computed on a server. Pick a modelled place (the Gold Coast Seaway, Currumbin Creek, the Pine River mouth and the Brisbane River mouth), an earthquake, a
tide state (LAT to HAT from the place's tidal planes, held for the whole run) and a run length of 30, 60 or 90 minutes, and press Run. A one-hour run takes a few seconds. The picture
colours land under water by its depth (the same classes as the flood depth key) and the sea by the wave (orange crest, blue drawdown); a time bar and speed control play it back, with
"land under water now", "most land flooded so far" and "deepest water on land so far" beside it.

The four scenarios, from `scripts/prepare-tsunami-scenarios.js` (series files in `viewer/public/tsunami-data/scenarios/`, a few KB each), are real PTHA18 earthquakes whose waves at hazard
point 1450.5 (667 m deep, 25 km off the Gold Coast) were chosen from the ensemble's flooding draws to span the range. At mean sea level the model floods:

| Scenario | Mw | Wave at the point | Land flooded | Deepest |
|---|---|---|---|---|
| Moderate (Kermadec-Tonga, row 38914) | 8.8 | 0.22 m | 34 ha | 0.84 m |
| Large (New Hebrides, row 11816) | 8.8 | 0.46 m | 60 ha | 1.27 m |
| Distant mega-quake (South America, row 146274) | 9.5 | 0.47 m | 77 ha | 1.39 m |
| Very large (Kermadec-Tonga, row 42930) | 9.3 | 0.62 m | 72 ha | 2.16 m |

The two Moreton Bay places (Pine River and Brisbane mouth, on 25 m grids) have their own four, chosen the same way at PTHA18 hazard point 1570.2 (1,045 m deep, 35 km offshore) from the Pine River ensemble draws,
and use Brisbane Bar's tide states. At mean sea level the Pine River grid floods about 14 to 16 ha in all four (Moderate: Mw 9.1 Kermadec-Tonga, wave 0.20 m, 14 ha, 0.43 m deep; Large: Mw 8.9 New Hebrides, 0.42 m, 15 ha,
0.91 m; Distant: Mw 9.5 South America, 0.33 m, 15 ha, 0.65 m; Very large: Mw 9.4 Kermadec-Tonga, 0.68 m, 16 ha, 1.51 m); the small flat grid saturates, so the depth and the extent reached tell the scenarios apart better than the area. Brisbane Bar's
lowest tide (LAT) is 1.15 m below its mean sea level and the model starts no lower than -1 m, so that state is run at -1 m, and the tide menu says so.

The page's run gives the same numbers as `scripts/run-series-local.js` (a test and the browser check compare them to the hundredth of a hectare). The panel shows each earthquake's
annual rate as how rare the earthquake is, not how often such a wave happens. The same limits as above apply: one scenario, the wave applied at the open edges without scaling for depth, a
first-order shoreline scheme, no defences or drainage, and no validation against a recorded event. It is not a forecast or an evacuation guide.

### Modelled flood hazard on the main map

A second layer, "Tsunami flood hazard: modelled areas (experimental)", paints how often the sampled tsunamis put at least a chosen depth of water
(0.1, 0.3 or 1 m, chosen in the Layers panel) on each 50 m cell of the places the lab models locally. It is built from the same rate-proportional
samples as the ensemble above: `scripts/ensemble-ptha.js --tide-weighted --cells-out` runs 60 draws of each of Kermadec-Tonga, New Hebrides and
South America (Mw 8.4 to 9.6, one hour) at all seven tide states, weighted by how often the Seaway gauge sits nearest each, and records for each cell the
share of draws, over the states, that add at least each depth. `scripts/prepare-tsunami-extents.js` multiplies each zone's share by its annual rate and sums the zones,
giving a rate per cell, stored as one byte per cell (`viewer/public/tsunami-data/extents/<place>.json`, about 60 KB). The map draws it in six classes, from rarer than
1 in 2,500 years to more often than 1 in 100 years; cells the sampled scenarios never reach, or reach less often than 1 in 10,000 years, are left clear. For the Gold Coast
Seaway the most frequently reached cell gets 0.1 m about once in 59 years, 0.3 m about once in 86 years and 1 m about once in 514 years. For Currumbin Creek (the same samples and Seaway tide, its own 25 m grid) the figures are 1 in 61, 1 in 99 and 1 in 682 years. For the Pine River mouth (hazard point 1570.2 and Brisbane Bar's tide) they are 1 in 79, 1 in 173 and 1 in 5,223 years. For the Brisbane River mouth (the same point and tide) they are 1 in 86, 1 in 230 and 1 in 731 years; its low-lying port ground is reached over a much wider area at high tide (the map shows about 90 ha reached at 0.3 m by some tide state and scenario) than the 5 to 14 ha its mean-sea-level draws flood. The layer is placed on the map by a
UTM zone 56 transform (checked against GA's published GDA reference point to a millimetre).

"Water added" is the most the wave raises the water above what the tide already covers at the cell, so the tide's own flooding is not counted. As with the ensemble this is a
lower bound from a sample: other zones and smaller earthquakes are left out, the terrain is the bundled grid with no defences or drainage, the offshore wave is applied at the open edges
without scaling for depth, and the model is not validated against a recorded event. The sampling error is large for rare outcomes. It is a way to see where the sampled scenarios send
water, not a hazard assessment.

## Demonstration defaults

The UI starts with an intentionally exaggerated **2.5 m nominal source strength**.
Local scenes use a 450 m pulse width (Gaussian standard deviation) and playback
of five simulated minutes per second. The previous settings were 1 m, 300 m and
one minute per second locally. These changes make propagation and inundation
easier to inspect; they do not represent a selected earthquake or hazard level.
The low-level grid factory retains its 1 m default for numerical examples.

Source strength is displacement amplitude, not crest-to-trough wave height.
The local shallow-depth taper can reduce the actual initial maximum, especially
in the lake or Pine River. The maximum-displacement metric reports modelled
values. Water levels and Manning resistance are not exaggerated: sea level
starts at a hypothetical terrain elevation of zero, the idealised lake at 1 m,
and Manning n at 0.025. A single roughness value is a simplification, not a
calibrated representation of vegetated floodplains or urban obstacles.

## Regional propagation models

The two linear methods solve the linear shallow-water equations:

```
d eta / dt = -div(q)
d q / dt = -g H grad(eta)
```

Here `eta` is surface displacement in metres, `H` is fixed still-water depth
in metres, and `q` is depth-integrated horizontal transport in m²/s. The Rust
solver uses cell-centred surface height and face-centred transports, with a
half-step first momentum update and leapfrog updates thereafter. The fixed
time step is `0.45 dx / sqrt(g Hmax)`, below the two-dimensional CFL limit.
Positive ocean depths are required; zero-depth cells are reflecting land.
The alternative finite-volume method uses cell-centred transports, acoustic
Riemann fluxes and SSP-RK2 time integration. Its first-order spatial
reconstruction is more diffusive; it preserves rest over variable bathymetry
and closed-basin displacement volume. It is a comparison of numerical
methods, not an additional nonlinear or dispersive physical model.

Synthetic cases use a 160 × 96 grid with 1 km square cells. The source
is a derivative-of-Gaussian dipole initially at rest; its width parameter is
the Gaussian standard deviation in kilometres. This is prescribed initial
water displacement, not an earthquake rupture or magnitude model.

The optional edge sponge damps the wave over the outer cells; it is an
approximate absorbing boundary and can still reflect some energy. With it
disabled, the outer boundaries are closed and reflecting. Coastlines always
reflect. The peak layer records maximum absolute surface displacement,
including the initial source; it is not inundation depth. Colour saturation
is fixed at 1.5 times the source amplitude; gauge traces autoscale.

## Dispersive uniform-ocean comparison

Choose **Try dispersive ocean**, or open
`tsunami.html?scene=flat&method=dispersive`. The **Dispersive · linear Boussinesq**
method is a linearised Boussinesq/Peregrine experiment for constant positive
depth. It adds wavelength-dependent speed: shorter waves travel more slowly
than long waves. The linear model is based on the flat-bottom
[Boussinesq–Peregrine system](https://www.cambridge.org/core/journals/journal-of-fluid-mechanics/article/evolution-of-perturbed-long-nonlinear-plane-ring-and-hybrid-surface-waves/5A777B7412A3346C7F0EA4ACD2B65A88).
The uniform-depth form has no nonlinear advection, variable-depth effects, shoreline
coupling, wetting/drying or breaking; the variable-depth form is described below.

For uniform still-water depth H, the implementation advances:

```
(I - H²/3 Laplacian) phi = eta
q_t = -g H grad(phi)
eta_t = -div(q)
omega² = g H k² / (1 + H² k²/3)
```

The scalar Helmholtz operator uses Neumann walls; the staggered transports and
leapfrog stepping are shared with the reference linear solver. A warm-started
conjugate-gradient solve uses reused arrays, a relative residual tolerance of
1e-9 and a 200-iteration limit, reporting failure rather than continuing with
an unconverged pressure field. The worker sends at most 16 dispersive steps
per batch to keep controls responsive. The optional sponge remains an
approximate damping boundary, not an open-ocean radiation condition.

This is a **weak-dispersion approximation**. Its dispersion tends to
`sqrt(g H)` as kH tends to zero; it does not reproduce the full gravity-wave
relation `omega² = g k tanh(k H)` at arbitrary wavelengths. The displayed
source-scale depth/spread ratio uses k approximately equal to 1/source spread,
not the full pulse spectrum. Prefer kH below about 1 for comparisons; shorter
spectral components are less reliable. Check the selected depth and spread
when comparing the three uniform-ocean numerical methods.

Rust checks verify the Neumann Helmholtz transfer function, two cosine-mode
frequencies against the fully discrete dispersion relation, the long-wave
limit, still water, mass conservation and rejection of non-uniform depth.
WASM checks compare finite waveforms against the shallow-water solver. These
are numerical checks, not coastal or field validation. The remaining work is
recorded in the [tsunami roadmap](../ROADMAP.md#tsunami-data-coastal-coupling-and-dispersive-waves-25-oct-2026).

### Variable depth and land (regional grids)

The same method now runs on the shelf, island and prefetched coastal grids.
Where depth is not uniform, or land is present, the scalar solve is replaced by the
linearised Peregrine momentum equation for the acceleration `w = u_t`:

```
w - (H/2) grad(div(H w)) + (H²/6) grad(div w) = -g grad(eta)
q_t = H w,   eta_t = -div(q)
```

on the same staggered grid, with face depths averaged from the two adjacent
wet cells and land and domain edges as walls. It is solved each step by
Jacobi-preconditioned BiCGSTAB, warm-started from a linear extrapolation of the
previous two solutions, to a relative residual of 1e-6 (at most 300
iterations, otherwise the run stops with an error). In uniform depth the
operator is algebraically the scalar one, and a Rust test confirms the two
agree to 1e-7 when both are solved tightly. A residual of 1e-6 changes a 1.5 m source by 4e-8 m after 2000 steps
compared with solving to 1e-12, and takes about 9 iterations a step instead of 15 at 1e-8.

Checks beyond that: still water stays still over uneven bathymetry and land;
displacement volume is conserved on a shelf with land; a pulse 15 km wide on a
1000 m shelf follows the shallow-water solver to 8% after 20 minutes; a pulse
a few depths wide over a shoaling bottom (4000 m to 2000 m) loses speed and
height relative to shallow water (crest at least three cells behind, under 90%
of the height).

Against exact linear theory (`tests/dispersion-benchmark.test.js`): in a closed,
uniform-depth basin the exact solution is a sum of cosine modes with
`omega² = g k tanh(k H)`, so the solver can be compared with it directly. For the
bundled dipole pulse after 83, 132 and 186 s (a few pulse widths of travel), the relative RMS error of
the solver and of shallow water is:

| depth / pulse width (about kH) | dispersive | shallow water |
|---|---|---|
| 5000 m / 5 km (1.0) | 0.21 | 1.08 |
| 2000 m / 5 km (0.4) | 0.029 | 0.36 |
| 1000 m / 10 km (0.1) | 0.002 | 0.013 |

The error rises with kH as the weak-dispersion approximation predicts, and stays
several times below shallow water throughout. Longer runs, to 400 s at kH = 1,
reach errors of 0.4 to 0.8, so keep kH below about 1 and treat long runs with caution. This is a
check on uniform depth only.

Shoaling over a ramp (same test file): a 50 km wavelength packet, centred on the
left wall so it travels one way, crosses a 30 km depth ramp. For a conservative
wave system the integral of eta² over the packet is conserved as it shoals or
deepens (the packet lengthens or shortens with its group speed and its height
compensates), so the integral is measured while the packet lies wholly in the
upstream depth and again wholly in the downstream depth. Ratios (after / before):

| Ramp | shallow water | dispersive |
|---|---|---|
| 4000 m to 2500 m (shoaling) | 1.000 | 0.998 |
| 2500 m to 4000 m (deepening) | 1.002 | 0.986 |
| 4000 m, no ramp (control) | 1.000 | 1.003 |

The dispersive solver conserves packet energy over a ramp to about 1.5%, so its
variable-depth operator shoals consistently. An earlier gauge-based version of this test
(energy passing two gauges against the ratio of group speeds) suggested the dispersive
solver delivered about 7% too little energy when shoaling. That was an artefact of
the gauge time window: it moved a lot with the window, and swapping in an
energy-conserving form of the operator changed nothing. This is a
conservation check, not a comparison with a published shoaling benchmark.

What it does **not** establish: agreement with a published variable-depth benchmark
or with observations over real bathymetry, or the correctness of the
variable-depth terms beyond those checks. The formulation is a weak-dispersion
form (kH below about 1) with no extra variable-depth terms, no nonlinearity,
no breaking and no wetting/drying. The regional 1.5 km grids floor coastal
depths at 10 m, so shorter waves than about 4–5 cells (6–7 km) are not
represented in any case. Cost on the 160 × 96 Moreton grid is about 8 ms per step (it was 12.7 ms
with the earlier residual of 1e-8), around 60 times the shallow-water solver's 0.125 ms, so playback runs at a few simulated minutes per
second whatever speed is selected. It is not available in the nonlinear local scenes.

## Prefetched Australian east coast

The regional picker includes Moreton Bay/Brisbane, Gold Coast/Tweed, Coffs
Harbour, Newcastle/Hunter coast, Sydney/Central Coast, Sunshine Coast,
Port Macquarie and Wollongong/Illawarra.
Each is a 240 × 144 km regional grid at 1.5 km spacing. Coast grids are bundled
JSON, so viewing them does not contact an external feed. Rebuild them explicitly
with `node scripts/prepare-tsunami-coasts.js`.

These first grids come from GA's numeric WCS service for Australian Bathymetry
and Topography. Its metadata identifies **version 4 (2009)**, with CC BY 4.0
attribution © Commonwealth of Australia (Geoscience Australia) 2016. This is
real measured/compiled geographic relief, not synthetic bathymetry; it is
**not** the newer AusBathyTopo 2026 product. Each JSON retains the source URL,
dataset name, bounds, preparation date and attribution. Land elevations are
retained in the dataset but mapped to reflecting land for this propagation
solver. Wet depths below 10 m are floored to 10 m. WCS resampling and a local
equirectangular approximation make this unsuitable for resolving estuaries,
harbours or inundation.

Every coastal source remains a hypothetical offshore dipole. These are real
locations with test waves, not reconstructions of an earthquake or a PTHA18
scenario. A basin-scale source requires either a much larger propagation
domain or imported offshore boundary time series.

## Data to improve predictions

| Data | Inclusion in a later model |
| --- | --- |
| [GA AusBathyTopo 250 m and regional grids](https://www.ga.gov.au/scientific-topics/marine-and-coastal/seabed/ausbathytopo-grids) | Prefetch consistent ocean depths, retain survey provenance/uncertainty, and refine near the coast. |
| [GA coastal LiDAR and near-shore bathymetry](https://www.ga.gov.au/scientific-topics/national-location-information/digital-elevation-data) | Merge land and seabed on a common vertical datum for a nonlinear wetting/drying solver, including estuaries. |
| [GA PTHA18](https://www.ga.gov.au/scientific-topics/community-safety/data-and-products/ptha) | Use defined earthquake initial uplift/subsidence or scenario offshore time series as source/boundary conditions, keeping scenario IDs and rates. |
| Tide and tsunami gauge observations | Set initial sea level and validate arrival time, amplitude and waveform against observations. |
| Roughness, buildings and hydraulic structures | Add resistance and flow obstacles only once onshore hydraulics and grid resolution support them. |

More samples alone do not ensure better predictions: vertical datum,
measurement error, survey age, source uncertainty, grid resolution and solver
physics must be compatible. Regional propagation alone cannot turn land data into river or inundation
predictions. The separate nonlinear local tests below implement those dynamics
experimentally, with different terrain and initialisation requirements.

## Nonlinear land, river and lake experiments

Choose **Idealised estuary, river and lake**, **Pine River / Moreton Bay**,
**Brisbane River mouth**, **Currumbin Creek / Gold Coast** or
**Gold Coast / Broadwater & Seaway**.
These local scenes select a separate nonlinear Rust solver automatically;
the regional 1.5 km grids remain propagation-only. A `?scene=estuary` or
`?scene=pine-estuary` URL opens the corresponding local scene directly.

The solver evolves total water depth and both depth-integrated momenta using
the nonlinear two-dimensional shallow-water equations. It uses first-order
Rusanov fluxes with [Audusse et al. hydrostatic reconstruction (2004)](https://publications.imp.fu-berlin.de/478/),
explicit conservative face exchanges, bed-slope pressure corrections and
semi-implicit Manning friction. It recomputes an adaptive step from the sum
of directional characteristic speeds with CFL 0.4. Dry cells may wet and
wet cells may drain; no fixed shoreline mask is imposed. Tiny wet cells
below 1e-7 m have their momentum zeroed, without discarding their water.
Outer walls reflect. The optional sponge relaxes initially wet edge cells
towards their initial reference depth, with its water exchange included in
the volume balance. It is not an open-ocean radiation boundary.

All local scenes have 160 × 96 cells. Most use 25 m spacing (4 × 2.4 km);
the Gold Coast Broadwater/Seaway case uses 50 m spacing (8 × 4.8 km) to include
Southport and the inlet. The
idealised case has a sloping beach, a low floodplain, a curving channel and
an enclosed lake with an independently adjustable initial water elevation.
There is no imposed upstream river discharge, rainfall, breach or sediment
transport. The synthetic lake rim prevents exchange until overtopped; it is
not automatically filled to sea level. Clicking the idealised lake generates a local lake wave; the initial pulse
is confined to the connected waterbody containing the source. The imposed
local dipole is initially at rest and is tapered in shallow water to retain non-negative depth. Its
width can be 0.1–0.8 km, rather than the regional 5–20 km source width.

Pine River, Brisbane River mouth and Currumbin use numeric terrain from the
[Queensland QldDem mosaic](https://spatial-img.information.qld.gov.au/arcgis/rest/services/Elevation/QldDem/ImageServer),
clipped in GDA2020 / MGA zone 56 (EPSG:7856) and bilinearly resampled to 25 m.
Recreate these with `node scripts/prepare-tsunami-estuary.js`. Source resolution
and survey age vary; resampling does not turn coarse bathymetry into a survey.
The export does not specify a vertical datum, so the initial water level is a
hypothetical elevation in source units, not a verified tide or MSL/AHD conversion.

Gold Coast Broadwater/Seaway instead uses the [CSIRO Queensland estuaries
composite topography-bathymetry v1](https://data.csiro.au/collection/csiro:72113),
DOI 10.25919/1xzm-pw88, CC BY 4.0. It retains the **Australian Vertical Working
Surface (AVWS, EPSG:9458)** for the entire grid; values are not patched into the
Queensland mosaic of an unspecified datum. Recreate with
`node scripts/prepare-tsunami-csiro.js`. The script projects each 50 m model
cell centre into the source Australian Albers projection (EPSG:9473), samples
the nearest 5 m source pixel and retains its provenance flag. HTTP range reads
retrieve only a small crop of the 15 GB statewide cloud-optimised GeoTIFF.
Centre sampling can miss narrow channels; it is not an area-average or a 5 m
simulation. Initial sea level zero means a hypothetical AVWS plane, not local
mean sea level; calibrated tides and surveys remain future work.

The original Gold Coast QldDem export had six NoData cells. Underlying source
rasters had numeric values at five of those locations, suggesting mosaic or
coverage-selection gaps; the exact mosaic cause is unconfirmed. CSIRO has
values at all six, and the replacement grid has no missing sampled cells.
However, its 15,360 samples include 7,320 interpolated, 7,095 LiDAR-derived,
774 modelled-creek, 168 coarse-base-water and 3 satellite-intertidal cells.
This is improved completeness, not uniformly surveyed bathymetry. Source
percentages appear below the map, individual flags appear on inspection,
and an optional amber overlay marks interpolated, modelled or coarse cells.
These flags are provenance classes, not quantitative error estimates.

Any missing elevation samples remain null with a validity mask. Excluded cells
act as impermeable computational boundaries and contain no water; magenta
hatching marks them even with terrain colours disabled. Their count and
percentage appear below the map, and inspection reports unavailable elevation.
This can obstruct channels. Prefetch scripts reject more than 1% missing data;
the application does not invent elevations or carve channels. Source-supplied
interpolation in CSIRO is retained and identified separately.

Initial water is flood-filled through cells below the chosen level, starting
from each grid's declared ocean-facing edges: east for Pine, north for Brisbane
River mouth, and north/east for Currumbin and Gold Coast Seaway. Source and virtual-gauge cells are
chosen from this connected water, rather than from arbitrary negative terrain. Disconnected depressions start dry; lake levels
are unknown there. The idealised scene demonstrates separately initialised
lakes. The three QldDem subsets have **CC BY-SA** terms; CSIRO is **CC BY 4.0**. All retain attribution,
modification notice and required acknowledgements (see the adjacent data
README and JSON). The application code remains MIT licensed.

Views show surface change from each cell's initial reference water depth,
maximum absolute change, current water depth and depth-averaged speed. On
initially dry land, surface change equals inundation depth. Peak change in
initially wet cells is not maximum total depth. Flooded area counts initially
dry cells exceeding 1 cm now; all such initialisation depends on the selected
sea/lake levels. Gauge traces and CSV report water-depth change from initial
reference (equivalent to surface elevation change at continuously wet gauges).
The mass error subtracts both initial water volume and sponge exchange.

## Offshore-to-local coupling (one-way nesting)

For the four local terrain scenes, tick **Drive from an offshore wave (regional
model)** (or open `tsunami.html?scene=pine-estuary&coupled=1`). The local
pulse is removed and the water starts at rest. Instead:

1. The 1.5 km linear regional model (Moreton Bay / Brisbane for Pine River and
   the Brisbane River mouth; Gold Coast / Tweed for Currumbin and the Seaway)
   runs first, in the same worker, from a hypothetical offshore source at
   154.30°E (27.30°S or 28.00°S). Source strength and width are the regional
   settings, not a PTHA18 scenario.
2. It records surface displacement at 16 points along each declared sea edge.
   The local edge cells are converted from MGA zone 56 to longitude/latitude
   (inverse transverse Mercator, checked against Geoscience Australia's worked
   example) and mapped onto the regional grid. A point that falls on regional
   land is moved to the nearest wet regional cell within 12 km; the count is
   kept in the run record. A scene lying outside the regional grid is refused.
3. Each series is scaled by Green's law, `(H_regional / H_local)^(1/4)`, bounded
   to 0.5–2, from the regional depth (floored at 10 m) to the local edge depth.
4. The series, trimmed to start two minutes before the wave first exceeds 2% of
   its peak, becomes the **incoming wave** of a Flather-type open boundary on
   each sea edge of the nonlinear solver: outward velocity
   `sqrt(g/H) (eta - 2 eta_in)`, where `eta` is the local surface displacement
   and `eta_in` the forcing. Outgoing waves leave with little reflection; with
   no forcing the edge is a resting wall. The sponge is switched off. Cells
   that are dry at the start stay walls, and boundary water exchange is included
   in the mass-balance error. The local clock starts at that trimmed time, and
   the page reports how many minutes after the offshore source it stands.

### Waves from PTHA18 scenarios

`scripts/prepare-ptha-series.js` builds an incoming-wave file from a scenario in
Geoscience Australia's [PTHA18](https://www.ga.gov.au/scientific-topics/community-safety/data-and-products/ptha)
(CC BY 4.0), reading the NCI THREDDS server over OPeNDAP so only the needed
values are downloaded. PTHA18 stores, per source zone, one linear-model wave
for each unit source (1 m of slip on one fault patch); a scenario is a set of
unit sources with slips, and its wave at a "hazard point" is their slip-weighted
sum, as in GA's own R code. Behind a proxy set `NODE_USE_ENV_PROXY=1`.

```
node scripts/prepare-ptha-series.js --near 153.9,-27.95 --min-depth 80   # hazard points near a place
node scripts/prepare-ptha-series.js --zone southamerica --find --mw 9.3,9.5   # scenario rows (1-based)
node scripts/prepare-ptha-series.js --zone southamerica --event 142847 --gauge 1450.5 \
    --friction --align peak --hours 3 --out wave.csv
```

Load the file under **Incoming wave → Uploaded series · CSV** in a local scene.
`--align arrival` (default) starts the series just before the first wave,
`--align peak` starts 30 minutes before the largest wave of the whole series, and
`--align none` keeps time since the earthquake. The lab runs at most two hours,
so the window matters: the biggest waves often arrive hours after the first, and
the tool reports when the whole-series peak is outside the window it wrote.
`--friction` applies PTHA18's delayed linear friction (12 h delay, 1e-5 drag),
`--local-depth M` scales by Green's law from the hazard point's depth to M metres
(capped at 0.5 to 2), and `--slip` chooses stochastic (default), variable-uniform or
uniform scenarios. `--hazard` also reads PTHA18's own exceedance-rate curve at the hazard
point (summed over every source zone, with its 16th to 84th percentile uncertainty) and says
how often a peak as large as this scenario's is expected there, and which source zones contribute
most to exceeding it (each zone has its own curve), in the console and in the file.
`--gauge ID --return-period YEARS` works the other way: the stage PTHA18 expects to be exceeded once in that
many years at the point, with its uncertainty range and main source zones. At the Gold Coast point
above that is 0.25 m for 1 in 100 years (mostly the New Hebrides, South America and Kermadec-Tonga zones)
and 0.76 m for 1 in 2500 years (mostly Kermadec-Tonga and New Hebrides).
The output carries its provenance as `#` comment lines. A real
example, a Mw 9.4 South American scenario at the 667 m hazard point off the Gold
Coast (peak 9 cm after friction), is in
`docs/examples/ptha18-southamerica-142847-gauge1450.5.csv`; a test runs it through the
nested Gold Coast Seaway model. Its frictionless peak at the point is 13 cm, which PTHA18
expects to be exceeded about once in 28 years (16th to 84th percentile: 1 in 17 to 1 in 83) from
all sources combined. So this very large, very rare scenario produces a wave there that is common
in PTHA18's terms: its rate says how rare the earthquake is, not how rare the wave is at this point.

#### Scenarios at a hazard level

`scripts/pick-ptha-scenarios.js` finds scenarios of one source zone whose peak at a hazard point
is close to a chosen level (`--target-stage METRES`, or `--return-period YEARS` to take the level
from PTHA18's curve). It samples scenarios evenly in a magnitude range, not weighted by rate,
so it finds scenarios of the right size rather than the ones that dominate the hazard.
`scripts/run-series-local.js` then runs several series files through the nested Gold Coast Seaway
model for comparison. For the hazard point 1450.5, PTHA18's level for 1 in 2500 years is 0.76 m
(16th to 84th percentile: 0.35 to 0.91 m), mostly from the Kermadec-Tonga and New Hebrides zones.
Five sampled scenarios from those zones with offshore peaks of 0.7 to 0.9 m, against the example
above, run for an hour from mean sea level with no tide:

| Scenario | Mw | Offshore peak | Max water level | Max depth on land | Flooded |
|---|---|---|---|---|---|
| South America 142847 (example) | 9.4 | 0.09 m | 0.25 m | 0.11 m | 2 ha |
| New Hebrides 12252 | 9.0 | 0.84 m | 2.45 m | 2.44 m | 99 ha |
| New Hebrides 12277 | 9.0 | 0.81 m | 2.36 m | 2.34 m | 94 ha |
| Kermadec-Tonga 43241 | 9.3 | 0.74 m | 2.02 m | 2.00 m | 91 ha |
| Kermadec-Tonga 42003 | 9.1 | 0.72 m | 2.24 m | 2.12 m | 89 ha |
| Kermadec-Tonga 43490 | 9.4 | 0.90 m | 3.14 m | 1.92 m | 68 ha |

(Offshore peak is the largest absolute value in the series, trough included. Flooded counts initially
dry cells with more than 1 cm of water.) Two things stand out. The model turns a deep-water
wave about nine times larger into a flooded area some forty times larger: the response is steeply
nonlinear in the wave. And scenarios with similar offshore peaks differ by about 30%
in flooded area (and by about 20% in maximum depth on land), with the largest wave (43490) flooding the least, so a single peak
number does not determine the outcome; the wave's period and shape matter too.

These are illustrations of how this model responds to waves of PTHA18's 1-in-2500-year offshore size. They do **not**
estimate the 1-in-2500-year flood: that would need many scenarios weighted by their rates, tide
as a distribution, and calibrated terrain and roughness, none of which is here. The terrain
is the bundled 5 m grid at mean sea level without tide.

#### A rate-proportional sample of one zone

`scripts/ensemble-ptha.js` draws scenarios of one source zone with probability proportional to
their annual rate (so common scenarios appear as often as they occur), runs each through the nested
Gold Coast Seaway model, and estimates how often the zone's scenarios reach given offshore and
flooded-area levels: the zone's total rate times the fraction of draws that reach the level, with a 90%
interval on that fraction. Scenarios whose peak at the point is under 0.1 m are not run and count as
flooding nothing (a 9 cm wave floods about 2 ha). A run of 60 draws for Kermadec-Tonga (`kermadectonga2`,
Mw 8.4 to 9.6, 10,351 scenarios, total rate 1.8% per year) at hazard point 1450.5 takes about 25 minutes;
the full report is `docs/validation/ensemble-kermadectonga2-gauge1450.5.json`.
`ensemble-ptha.js` and `tide-sweep.js` spread their local runs over worker threads
(`--jobs N`, default one per core up to 8; `scripts/run-pool.js`). Each worker loads its own copy of the
WASM model and the runs are deterministic, so results do not depend on the number of workers (a test checks this).
On 4 cores, six one-hour runs took 99 s in one thread and 33 s on four workers, about 3 times faster, with identical results
(a run takes 15 to 20 s on an idle core). The 25 minutes quoted above was for the earlier single-thread version.

**Three zones together.** The same 60-draw sample (Mw 8.4 to 9.6, one hour, mean sea level) was also run for New Hebrides (`newhebrides2`, 2,700 scenarios, 1.05% per year) and South America (`southamerica`, 38,421 scenarios, 6.25% per year). These three carry about 75% to 95% of PTHA18's rate at this point for offshore peaks of 0.25 to 1 m (`zoneContributions`, hazard point 1450.5). `scripts/combine-ensembles.js` sums them (`docs/validation/ensemble-combined-gauge1450.5.json`): offshore peaks of 0.25 m about 1 in 144 years, 0.5 m about 1 in 697 years, none seen at 0.76 m; flooded area of 10 ha about 1 in 54 years, 30 ha about 1 in 181 years, 60 ha about 1 in 377 years, none seen at 90 ha. The reports were then rerun with `--tide-weighted`, which runs every scenario that floods at all seven tide states and weights them by the gauge frequencies above. Counting only the area the wave adds to what the tide already covers, the combined rates become: 1 ha about 1 in 59 years, 10 ha about 1 in 89 years, 30 ha about 1 in 339 years, 60 ha about 1 in 957 years, none seen at 90 ha. These are rarer than the mean-sea-level figures (10 ha: 1 in 54, 30 ha: 1 in 181, 60 ha: 1 in 377) because a high tide has already covered ground the wave would otherwise add; the figure leaves out the tide's own flooding, which the wave comes on top of. The sampling and the other limits are unchanged: other zones and magnitudes below 8.4 are left out, the one-hour run holds the tide at its state, and the intervals reflect sampling only.

As a check on the sampling, its offshore result can be compared with PTHA18's own curve for that zone at the same
point (rate of exceeding the stage; PTHA18's interval is its 16th to 84th percentile, the sample's is a 90% sampling interval):

| Offshore peak at least | This sample | PTHA18 curve for the zone |
|---|---|---|
| 0.10 m | 1 in 132 years (105 to 173) | 1 in 122 (81 to 245) |
| 0.25 m | 1 in 412 (248 to 716) | 1 in 464 (256 to 6,100) |
| 0.50 m | 1 in 1,100 (460 to 2,700) | 1 in 1,650 (840 to unbounded) |
| 0.76 m | none seen in 60 draws | 1 in 4,700 |

They agree within the intervals, so the sampler reproduces the rates. (The pool leaves out
Mw below 8.4, which matters little above 0.1 m.) The flooded-area rates it adds, for this zone alone:
at least 30 ha about 1 in 370 years (230 to 620), and at least 60 ha about 1 in 1,100 (460 to 2,700). Every run with an
offshore peak of 0.11 m or more flooded at least 13 ha, so the area rates at small sizes follow the offshore
peak rate directly (the 1 ha and 10 ha rows are the same as the 0.1 m row).

Limits: one source zone (the hazard at a site sums all of them), one magnitude range, one sea level (mean sea
level, no tide), uncalibrated terrain and roughness, and sixty draws, which cannot resolve rates rarer than about 1
in 1,000 years. The interval covers sampling error only, not the model's error or PTHA18's own uncertainty. This is the
structure of a scenario-based estimate, run on a small sample, not an estimate of the site's flood hazard.

#### Tide state at arrival

Every run above starts at mean sea level. `scripts/tide-sweep.js` starts the same series at the
tidal-plane levels of the Gold Coast Seaway instead: LAT, MLWS, MSL, MHWN, MHWS and HAT, as heights relative to MSL
(from `viewer/public/tsunami-data/gold-coast-seaway-tidal-planes.json`, Maritime Safety Queensland's 2026 semidiurnal tidal planes:
HAT +1.15 m, MHWS +0.65, MHWN +0.36, MLWN -0.37, MLWS -0.66, LAT -0.88). The sea level is held at the state for
the hour of the run, so this is the effect of the state at arrival, not of a moving tide. "Tide alone" is the
land the starting level already covers; the total is land under more than 1 cm at any time; the wave adds the rest.

| Scenario | State (sea level) | Tide alone | Added by wave | Total flooded | Max depth on land |
|---|---|---|---|---|---|
| New Hebrides 12252 (0.84 m offshore) | LAT (-0.88 m) | 0 ha | 27 ha | 27 ha | 1.58 m |
| | MLWS (-0.66) | 0 | 41 | 41 | 1.78 |
| | MSL (0) | 0 | 99 | 99 | 2.44 |
| | MHWN (+0.36) | 70 | 82 | 152 | 2.80 |
| | MHWS (+0.65) | 116 | 50 | 166 | 3.08 |
| | HAT (+1.15) | 148 | 58 | 206 | 3.55 |
| Kermadec-Tonga 42003 (0.72 m offshore) | LAT | 0 | 19 | 19 | 1.36 |
| | MLWS | 0 | 31 | 31 | 1.55 |
| | MSL | 0 | 89 | 89 | 2.12 |
| | MHWN | 70 | 74 | 144 | 2.49 |
| | MHWS | 116 | 45 | 161 | 2.78 |
| | HAT | 148 | 47 | 195 | 3.30 |
| South America 142847 (0.09 m offshore, example) | LAT / MLWS | 0 | 0 | 0 | 0.00 |
| | MSL | 0 | 2 | 2 | 0.11 |
| | MHWN | 70 | 3 | 73 | 1.81 |
| | MHWS | 116 | 3 | 119 | 2.10 |
| | HAT | 148 | 2 | 150 | 2.61 |

What it shows, for this terrain and model:

- **The tide state at arrival moves the answer more than the scenario does.** For the 0.84 m wave the total flooded
  area runs from 27 ha at the lowest tide to 206 ha at the highest, a factor of nearly 8, and the maximum depth on land from
  1.6 to 3.6 m; the six scenarios of similar offshore size earlier differed by about 30% at mean sea level. Between MSL and
  MHWN the total changes by about 15 ha for every 0.1 m of sea level, so the unknown level of MSL in the terrain's datum
  (taken here as 0) matters at that scale.
- **A lot of the high-tide total is the tide itself.** The terrain covers 148 ha at HAT without any wave, which includes low
  ground that sea walls, levees and drains would in reality keep dry; the terrain data may not capture them. The area
  the wave adds peaks near MSL and falls at the high states because the tide has already covered that ground. The
  extra depth is real, though: the same wave puts about 1.1 to 1.2 m more water on the ground at HAT than at MSL.
- **A tiny wave matters at high tide.** The 9 cm example adds only 2 to 3 ha at any state, but
  the tide alone it arrives on covers 70 to 148 ha.

Limits: the planes were read from a search summary of the published table; the PDF could not be downloaded from here,
so the numbers are not checked against it (the file says so). They have been checked against the gauge instead (below). The spring and neap ranges are the same in the 2024, 2025
and 2026 tables and only MSL moves, and only heights relative to MSL are used. Putting MSL on the terrain's AVWS datum
needs a level the table does not give.

**Checked against the Seaway gauge, and how often each state occurs.** Maritime Safety Queensland's Gold Coast Seaway gauge records
(station 045044A, observed and predicted 10-minute levels for 2016 to 2025, CC BY 4.0, from data.qld.gov.au) are open, so
`scripts/tide-analysis.js` fits 22 harmonic constituents to them (the fit reproduces the 2026 prediction to 1.7 cm RMS). The planes it gives for 2026
agree with the table's values to 1 mm at MHWS and MHWN, 13 mm at MSL, 17 mm at HAT and 13 mm at LAT, and to 36 mm at MLWN and MLWS (a symmetric M2 and S2
rule against MSQ's own definition of the lows); planes from the 2016 to 2025 observed levels agree to within 1.3 cm except LAT (4 cm, an extreme that a fit cannot pin down). The table's values are therefore consistent
with the gauge, though still not read from the PDF. The same record gives how often the sea sits nearest each state (levels moved to 2026 along the 6 mm per year
rise in annual mean level): LAT 0.9%, MLWS 11.1%, MLWN 25.2%, MSL 25.7%, MHWN 21.4%, MHWS 14.2%, HAT 1.6%.
Observed levels run 6 cm above the prediction on average (weather and wave set-up), with 1% of readings more than 12 cm below and 1% more than 28 cm above it, and
the largest excess 56 cm. `tide-sweep.js` run with all seven states
(`--states LAT,MLWS,MLWN,MSL,MHWN,MHWS,HAT`) now also prints the expected flooded area over these weights. Both the weights and the
gauge are at the Seaway itself, so they describe the sea level there, not the tide in the Broadwater behind it.

How well PTHA18's deep-water waves match reality is tested in
[docs/validation/tohoku-2011-dart.md](validation/tohoku-2011-dart.md), a blind comparison of
315 PTHA18 scenarios of the 2011 Tohoku earthquake with NOAA DART records at 16 buoys
(`scripts/validate-ptha-dart.js`, which needs the network). The observed peak lies inside the
scenarios' 10th to 90th percentile range at 15 of 16 buoys, including the Coral Sea buoy 55012
that sits on the path to eastern Australia (at the 14th percentile: the scenarios' median is
about 1.5 times the observed 4 cm). Observed waves tend to sit below the scenarios' median, and
observed arrivals are later than modelled in the east Pacific. This tests the series the importer
reads, not the lab's own solvers, and it is one event in deep water.

What this is and is not:

- **One scenario, not a hazard.** A scenario's annual rate is recorded in the file but
  a single run says nothing about how likely a given inundation is. `--hazard` places the
  scenario's peak on PTHA18's published offshore curve, which is deep-water stage (above mean
  sea level, no tide), not inundation. PTHA18's use is to
  supply many such scenarios with rates for site studies; this lab runs one at a time
  (the sensitivity ensemble varies other inputs, not the scenario).
- **PTHA18's waves are from a frictionless linear model on a 1 arc-minute grid.** They are
  reliable in deep water and for early arrivals, not nearshore or for late arrivals
  (overstated without friction), which is why deep hazard points and `--friction` are
  suggested. The local model then starts from that wave at its open edges, with no
  scaling unless you ask for it, no tide, and PTHA18's mean-sea-level reference against
  the local terrain's own (unreconciled) datum.
- It reads only PTHA18's published hazard-point series. The scenario's initial seabed
  deformation is not used (the lab has no source physics), and the regional model
  is not run for these scenarios.

### Your own incoming wave, and a tide

Under the nested option, **Incoming wave → Uploaded series · CSV** replaces the
regional model with a series you supply, which is the route for a measured
or scenario waveform (for example a tsunami gauge record, or an offshore time
series you have extracted from a PTHA18 scenario). The file has two columns,
**seconds from the start of the local run** and **metres above the initial sea
level**, comma-, semicolon-, tab- or space-separated, with `#` comments and one
header row allowed. Times must increase, heights must be within 20 m and the
file at most 8 MB. The same wave is applied to every open edge with no depth
scaling and no datum check; the file's author is responsible for the position,
datum and any conversion to the local depth. PTHA18 files themselves (NetCDF)
are not read.

**Rising tide at the open edges** adds a sinusoidal M2 (12.42 h) sea level
change rising from the initial level, to either source. It enters as a *total
external level* with no external current, separate from the incoming wave: a
closed basin therefore settles at the tide level, whereas a wave of the same
height is treated as a progressive wave that reflects at a wall. It is
hypothetical, not a forecast, and starts at the initial sea level whatever the
true tidal phase.

Checks: a Rust test records a pulse from a coarse linear run and feeds it to
a finer nonlinear run, and the downstream waveform agrees with the coarse
solution to within 8% of the peak; others cover still water on variable bed,
exit of outgoing waves (under 10% of the closed-wall case remains), series
validation, land edges and the recorder. JS tests run the whole chain for
Currumbin and Pine River, including a no-forcing control that stays at rest,
and a browser test switches the Gold Coast Seaway scene in and out of coupling, uploads a wave file and sets a tide. A Rust test checks that a rising external level raises a closed basin to that level, not twice it, with the inflow in the water balance.

Limits, in order of importance:

- **One-way and linear upstream.** The local model never feeds back. The
  regional model is linear and its coastal depths are floored at 10 m, so
  amplitudes near the coast are only indicative; Green's law is a
  correction for slowly varying depth, not a substitute for nesting.
- **Sheltered bays.** The regional grid barely resolves the entrances to Moreton
  Bay, so Pine River and the Brisbane River mouth receive a small, late wave (a
  few cm, more than an hour after the source) with the default 2.5 m source,
  while the open-coast Gold Coast scenes receive metres within half an hour.
  Treat that as a statement about the 1.5 km grid, not about the bay.
- **Vertical datums** of the regional (GA, 2009) and local grids are not
  reconciled, and the local sea level is the same hypothetical plane as before.
- **Not a scenario.** The source is the same demonstration dipole; no PTHA18
  scenario, tide or river flow is applied.

Next: independently verified bed surveys and datum conversions, prescribed
river inflow, a physically consistent offshore boundary time series, local
refinement and published run-up/inundation benchmarks. The local pulse can now be replaced by a one-way offshore wave from the regional solver (see above);
it is still not tied to an earthquake scenario.

## Recent mathematical work to evaluate

- [SWEpy (2026)](https://gmd.copernicus.org/articles/19/3953/2026/) combines
  high-order reconstruction, well-balancing, wet/dry treatment and GPU work.
  These are useful directions for reducing numerical errors and adding run-up.
- [Dynamic-seafloor Fourier-continuation solver (2025 preprint)](https://arxiv.org/abs/2508.20596)
  explores time-dependent seabed motion and high-order propagation.
- [Fourier neural-operator source inversion (October 2026)](https://link.springer.com/article/10.1186/s40623-026-02552-2)
  demonstrates fast learned surrogates for a trained domain; coastal boundary
  limitations remain. It does not replace validation of the physical solver.
- [Kamchatka analysis (September 2026)](https://www.nature.com/articles/s43247-026-04050-5)
  uses dispersive modelling to reproduce satellite-observed wave structure.
  A Boussinesq/non-hydrostatic option is a future physical extension.

## Terrain and water overlay

Terrain shading is on by default beneath the selected water overlay. Deep bed
elevations are dark blue, shallow beds light blue; ground above the terrain
reference zero grades from green to brown. Separate colour ramps report the
bed and ground ranges in metres. Each scene uses its own range, so colours
cannot be compared quantitatively between locations. The source's reference
zero is not necessarily verified mean sea level (especially Pine River).

Terrain uses the solver bed for local scenes and original elevation samples
for prefetched regional scenes, rather than the propagation solver's 10 m
shallow-water floor. Synthetic regional land masks have no elevation samples;
they remain neutral and are reported as unknown. No land heights are invented.

Water movement is blended over those colours according to the selected view
and magnitude. **Terrain only** hides the water overlay without stopping the
simulation. **Show terrain beneath water** can be switched off for the previous
wave-only palette. Pointer inspection shows bed/ground elevation, initial model
water depth, and current water depth and surface elevation for the nonlinear
solver. Linear scenes show wave displacement instead of asserting a changing
physical water surface over their floored depths.

## Reference names and further modelling work

Geographic scenes include offline point labels from the Composite Gazetteer of
Australia, retaining source IDs and attribution to GA and state naming
authorities. Rebuild them with `node scripts/prepare-tsunami-places.js` after
preparing terrain. Regional coordinates are mapped to their geographic bounds;
local coordinates are requested in the same MGA56 projection as the terrain.
Labels avoid gauge markers and one another. Points outside the cropped domain
are listed as outside-grid references rather than repositioned on the map.
The idealised scene labels its ocean, channel, lake and floodplain; it does not
assign real city names to synthetic geography.

See [the tsunami roadmap](../ROADMAP.md#tsunami-data-coastal-coupling-and-dispersive-waves-25-oct-2026)
for proposed data improvements, offshore/river coupling, refinement, sensitivity
runs and the next stage of the **dispersive-wave (Boussinesq-type)** solver. Its
linear uniform- and variable-depth forms are implemented; nonlinear coastal coupling remains future work.

## Numerical scheme: first or second order

The nonlinear local solver has two schemes, chosen by **Numerical scheme** (or
`?scheme=second`). **First-order** (the default) is a Rusanov flux with hydrostatic
reconstruction and a forward-Euler step: robust, but it smooths waves and
under-predicts run-up. **Second-order** keeps the same face fluxes and
hydrostatic pressure corrections, applied to reconstructed face states, and adds
limited linear (generalised minmod, θ = 1.5) reconstruction of depth, bed and
velocity along each axis, a centred bed-slope source from the reconstructed bed,
and a two-stage Heun time step with CFL 0.3. A cell reconstructs only if it and
both neighbours are valid and wet (depth above 1 cm) and its depth comfortably exceeds the
bed and surface variation across it; everywhere else, including every shoreline
cell, it is first-order. Reconstructing the bed linearly keeps the face and cell
bed values consistent, so lake-at-rest states remain exact (a Rust test checks
1e-12 under both schemes, with dry shores, separate lakes, masks, sponge,
forced edges and tides).

Evidence: in the solitary-wave run-up benchmark above, second order reaches 90%
of the analytical run-up with 1 m cells and 98% with 0.5 m cells (first order: 71% and 83%).
On the four real terrains and a nested run it stayed positive and conservative (water
balance error below 2e-6 m³ over 15–20 simulated minutes) and produced stronger currents
and more flooding than first order, as less numerical damping implies. The
shoreline itself remains first-order, so run-up at very coarse resolution is
still approximate, and the scheme is newer and less tested on rough terrain
than the default. It costs about three times the CPU per simulated second (two
stages plus reconstruction), so live playback runs slower; the pre-calculation
option helps. The mass and boundary accounting are unchanged.

### Speed of the solvers

Where the time goes, measured on a 160 × 96 grid like the bundled local terrains (50 m cells, half of it land,
with a sponge, friction and a forced edge in a second scene), and what was done about it:

- **Dry cells were doing full work.** Two cells with no water at all exchange exactly nothing, so such a face is
  skipped (the second-order scheme did the full flux and reconstruction there too). The second-order scheme also
  worked out each cell's velocity up to six times and allocated about a megabyte of reconstruction for every
  direction on every stage; it now computes the velocities once and reuses its buffers, as the first-order scheme
  reuses its change array. The per-cell update runs over plain slices, and skips the friction power when the roughness is zero.
- **The sponge factor of each face** in the linear solver is worked out once instead of a square root per face per step.
- **The dispersive solve's tolerance** is 1e-6 (above).

None of this changes the answer: a checksum of the full state (every depth and both transports) after hundreds to thousands of steps is bit for bit the
same before and after the first-order and second-order changes and the linear-solver change, in scenes with a forced edge, a tide, a mask and a sponge.
(Only the dispersive solver changes, within the tolerance above.) Results, native Rust on this machine:

| | before | after |
|---|---|---|
| First order, per step | 970 µs | 835 µs |
| Second order, per step | 3,360 µs | 1,890 µs |
| Staggered linear, per step | 104 µs | 97 µs |
| Dispersive, per step | 5,240 µs | 3,030 µs |

In the browser module (Node, WASM) a 1800 s run of the nested Gold Coast Seaway model took 7.8 s at first order and 22.8 s at second order, and now takes 6.7 s
and 17.6 s (the same flooded depths); the Moreton dispersive grid went from 12.7 to 7.8 ms per step. The rest of the first-order
time is the flux itself, a few square roots and divisions per face; going further means changing the arithmetic, which would stop the
results matching bit for bit. `time_the_steps` in `inundation.rs` and `tsunami.rs` are ignored tests that print these timings
(`cargo test --release -p flood-core time_the_steps -- --ignored --nocapture`).

#### WebAssembly is slower than native at some maths

A second round of measurements, in the WebAssembly module under Node (the same module the browser runs), found that
`hypot` and `powf` cost far more there than in the native build: the module carries its own maths library, and they are
the slow parts of it. Because of that the same change that gave 10% natively gave 2× in the module.

| Change | Before | After |
|---|---|---|
| Nonlinear solver: vector length as `sqrt(x² + y²)` instead of `hypot` (about 1e-14 relative difference in the answer) | first order 6.8 s, second order 18 s for a 1800 s nested run | 3.2 s and 12.3 s |
| Storm model (`flash_flood`): rain intensity worked out once per catchment size, and the overland-depth power skipped for cells below the depth that could matter (identical output) | 247 ms, and 276 ms with pipes, on 1.78 M cells | 95 ms and 125 ms |
| Shaded relief in Rust (`terrain_rgba`), also without `hypot` and with no per-pixel trigonometry (identical to the JavaScript on test data) | JavaScript 260 ms | 89 ms |
| Flood timeline: one scenario and one surface reused across steps, no copy of either per step (identical output) | 241 ms (0.44 M cells), 1,100 ms (1.78 M cells) | 205 ms and 980 ms |
| 3D water frame: reads only the sampled cells of an encoded frame, and a flat table instead of a `Map` for the soft shoreline (identical mesh) | 3-5 ms hard edge, 21 ms soft shoreline | 1.3 ms and 10 ms |

Things that did **not** help in the module, and were left out: replacing `powf(4/3)` with a cube root (slower), the same for
the 2D inertial model's `h^(7/3)` (slower), working out the sponge's exponentials once per strength instead of per cell
(no change), and finding the next time step inside the update loop instead of a separate pass (no change).

Timings on this machine drift by 30% or more over an hour, so each of these was measured by building the old and new
versions in turn, three times, and comparing neighbouring runs; an earlier comparison made without that care was
wrong in both directions. The ignored `time_a_large_relief` test and the `time_the_steps` tests print native figures.

## Sensitivity ensemble

In any nonlinear local scene, **Sensitivity ensemble** (below the gauges) reruns the
current scene, to the chosen simulation length, with its uncertain inputs moved
in a fixed, small pattern: a baseline; each of **source strength**, **initial sea
level**, **Manning n** and **terrain height** (a uniform vertical shift of the
bed) pushed low and high on its own; and two combined runs, all inputs towards
more flooding and all towards less. The offsets are editable (defaults ±50% source
strength, ±0.5 m sea level, ±50% Manning n, ±0.5 m terrain); values that clamp
to the same setting are merged, and terrain is skipped in the idealised scene
and source strength when a CSV series drives the run. That is up to 11 runs,
executed one after another in a separate worker with a progress bar, results
appearing as each run finishes. Nested runs share one regional run between
members with the same source strength.

For each run it reports, per gauge, the **arrival time** (first change above 5 cm
at the gauge, to about 20 solver steps) and **peak** change; the **deepest water
on initially dry land**; the **flooded land** area (above 1 cm); and the **fastest
current**, sampled at those steps and therefore a lower bound. A final row gives
the minimum and maximum over runs, noting runs in which a gauge was not reached.
The table can be exported as CSV. If settings change afterwards, the table says it
no longer matches them.

What it is and is not: a bracketing exercise on chosen inputs. It is **not** a
probabilistic ensemble: the ranges are not confidence intervals or hazard
probabilities, there is no sampling of source location, shape, rupture physics,
bathymetry error beyond the uniform shift, or numerical error, and the first-order
solver's known under-prediction of run-up (see Checks) applies to every run.
Arrival times in a nested run are on the local clock, which starts shortly before
the wave reaches the edges, so an ensemble length that is too short shows
"not reached" and zero flooding. Runtime is about the sum of the individual
runs (for example, five or ten simulated minutes at 25–50 m take a few seconds each).

## Pre-calculating a run

Tick **Pre-calculate the whole run first** (or open `tsunami.html?precompute=1`)
to run the entire simulation in the worker before playback. A progress bar
shows the percentage, the simulated time reached and an estimate of the seconds
left; a nested run first shows "Running the regional offshore model…" while that
step has no measurable progress. Play is disabled until it finishes. Changing any
setting, or pressing Reset after an error, recalculates (the page is not
blocked: the work is in the worker, and changing a setting cancels it).

The result is 200 evenly spaced frames, held as 32-bit floats: roughly 12 MB for
a linear run and 50 MB for a nonlinear one. Playback then simply steps through
them at the selected speed, so it is smooth even for the slow variable-depth
dispersive method and nested runs, and a **Simulated time** bar lets you drag to
any moment. Pause, Step (one frame), Replay and Reset (rewinds without recomputing)
work as usual, and gauge traces and the CSV export cover the whole run. Frames
are 1/200 of the run apart (18 s for 60 minutes), so playback and gauge traces
are sampled at that spacing rather than at every solver step; peak and mass-balance
figures are unaffected. Without the option, runs compute live as before.

## Checks and limits

Rust tests check rest over variable bathymetry, propagation speed against
`sqrt(g H)`, pulse splitting amplitude, displacement-volume conservation in a
closed basin, dry cells and reduction of returning waves by the sponge. JS
tests exercise the actual WASM bridge and browser tests exercise the built
worker, nested deployment paths, controls and export. Nonlinear tests check
resting water over a variable bed and a dry shore, separate lake levels,
positive depths, mass balance including sponge exchange, beach run-up and
subsequent drainage, and a dry-bed Ritter dam-break depth profile and contour
position. A NOAA/NCTR analytical benchmark is included: a non-breaking solitary wave
(H/d = 0.05, below Synolakis' breaking limit) on a 1:10 beach, compared with
the run-up law `R/d = 2.831 sqrt(cot beta) (H/d)^(5/4)`. The first-order solver
reaches 71% of the analytical run-up with 1 m cells and 83% with 0.5 m cells
(depth 6 m, about 60 cells per wave length scale), so it **under-predicts
run-up**, converging at roughly first order as expected of a Rusanov scheme with
hydrostatic reconstruction. The test requires the finer result to be within 20%.
Treat first-order run-up at the grid sizes the browser can afford as a
lower bound; the second-order scheme (below) is much closer. The solver accepts cells down to 0.05 m so such benchmarks can be
run at laboratory scale.
A second analytical case tests the moving shoreline itself: Thacker's oscillating water body in a
parabolic bowl (bed `z = h0 x²/a² - D`, a one-dimensional strip). Its exact, nonlinear, frictionless
solution is a parabola of water that slides back and forth without changing shape, `h = max(0, D - h0 (x - ξ(t))²/a²)` with
a uniform velocity `ξ'(t)` and `ξ = ξ0 cos ωt`, `ω = √(2 g h0) / a`, so both shorelines run across dry
cells and back (here a = 100 m, h0 = 1 m, D = 0.5 m, ξ0 = 20 m, a period of 142 s). Over five periods, sampled eight
times each, against the exact depth profile:

| Scheme and cell size | Worst L1 depth error | Worst right-shoreline error |
|---|---|---|
| First order, 2 m | 27% | 15 m |
| First order, 1 m | 15% | 8.4 m |
| Second order, 2 m | 4.4% | 5.4 m |
| Second order, 1 m | 1.7% | 1.8 m |

Water is conserved to rounding (volume drift below 1e-13 m²). First order damps and lags the oscillation, and
the error halves with the cell size, as for the run-up benchmark; second order keeps the shape
about nine times better. The shoreline error is the lag of the wet edge behind the exact one, which grows
with the number of periods: it is a resolution and scheme limit, not a conservation problem.

These first-order tests are not tsunami run-up certification. Run:

```
cargo test --locked --manifest-path rust/Cargo.toml -p flood-core -p flood-wasm
npm run build
npm test
npm run test:build
```

These are numerical sanity checks, not tsunami benchmark certification. The
linear model assumes long waves and small displacement relative to depth.
It excludes nonlinear advection, breaking, dispersive effects, friction,
Coriolis, moving seabed, wetting/drying and coastal inundation. It cannot
produce site-specific hazard, run-up or evacuation information.

The nonlinear local solver also omits dispersion, Coriolis, moving seabed,
non-hydrostatic wave breaking, structures and sub-cell channel hydraulics.
Next steps are verified bathymetry/topography with compatible vertical datums,
well-defined source and boundary scenarios, and grid refinement,
then validation against published analytical, laboratory and field benchmarks.
See [NOAA's modelling overview](https://nctr.pmel.noaa.gov/model.html) and
[analytical benchmark collection](https://nctr.pmel.noaa.gov/benchmark/Analytical/index.html).
