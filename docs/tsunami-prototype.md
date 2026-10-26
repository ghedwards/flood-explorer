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
previous two solutions, to a relative residual of 1e-8 (at most 300
iterations, otherwise the run stops with an error). In uniform depth the
operator is algebraically the scalar one, and a Rust test confirms the two
agree to 1e-7.

Checks beyond that: still water stays still over uneven bathymetry and land;
displacement volume is conserved on a shelf with land; a pulse 15 km wide on a
1000 m shelf follows the shallow-water solver to 8% after 20 minutes; a pulse
a few depths wide over a shoaling bottom (4000 m to 2000 m) loses speed and
height relative to shallow water (crest at least three cells behind, under 90%
of the height).

What it does **not** establish: agreement with a published dispersive benchmark
or with observations over real bathymetry, or the correctness of the
variable-depth terms beyond those checks. The formulation is a weak-dispersion
form (kH below about 1) with no extra variable-depth terms, no nonlinearity,
no breaking and no wetting/drying. The regional 1.5 km grids floor coastal
depths at 10 m, so shorter waves than about 4–5 cells (6–7 km) are not
represented in any case. Cost on a 160 × 96 coastal grid is about 20 ms per
step in the browser (roughly 25 solver iterations per step), around 50 times
the shallow-water solver, so playback runs at a few simulated minutes per
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
uniform scenarios. The output carries its provenance as `#` comment lines. A real
example, a Mw 9.4 South American scenario at the 667 m hazard point off the Gold
Coast (peak 9 cm after friction), is in
`docs/examples/ptha18-southamerica-142847-gauge1450.5.csv`; a test runs it through the
nested Gold Coast Seaway model.

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
  a single run says nothing about how likely a given inundation is. PTHA18's use is to
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
