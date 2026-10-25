# Tsunami propagation lab

Open `tsunami.html` in the built viewer (or use the link in About). For local
development, run `npm run serve` and visit `/tsunami.html`. The model runs in
a dedicated browser worker using the existing Rust-to-WASM bridge. It needs
no feeds, API key or server-side simulation.

The prototype explores propagation, reflection and refraction.
It includes uniform ocean, continental shelf, and island/shelf bathymetries,
a movable paired uplift/subsidence pulse, pause/step/reset, a maximum absolute
displacement view, three virtual gauges and CSV export. The canvas uses basin
coordinates in kilometres for idealised cases. Five Australian east-coast
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

## Prefetched Australian east coast

The location picker includes Moreton Bay/Brisbane (Qld), Gold Coast/Tweed
(Qld/NSW), Coffs Harbour, Newcastle/Hunter coast and Sydney/Central Coast (NSW).
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

Choose **Idealised estuary, river and lake** or **Pine River / Moreton Bay**.
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

Both local scenes are 160 × 96 cells at 25 m spacing (4 × 2.4 km). The
idealised case has a sloping beach, a low floodplain, a curving channel and
an enclosed lake with an independently adjustable initial water elevation.
There is no imposed upstream river discharge, rainfall, breach or sediment
transport. The synthetic lake rim prevents exchange until overtopped; it is
not automatically filled to sea level. Clicking the idealised lake generates a local lake wave; the initial pulse
is confined to the connected waterbody containing the source. The imposed
local dipole is initially at rest and is tapered in shallow water to retain non-negative depth. Its
width can be 0.1–0.8 km, rather than the regional 5–20 km source width.

The Pine River subset is numeric terrain from the [Queensland QldDem mosaic](https://spatial-img.information.qld.gov.au/arcgis/rest/services/Elevation/QldDem/ImageServer),
clipped in GDA2020 / MGA zone 56 (EPSG:7856) and bilinearly resampled to 25 m.
Recreate it with `node scripts/prepare-tsunami-estuary.js`. Source resolution
and survey age vary; resampling does not turn lower-resolution bathymetry
into a 25 m survey. Missing elevation samples are rejected, not filled or
channel-carved. The export does not specify a vertical datum. Initial sea
level is therefore a hypothetical elevation in source terrain units,
**not a verified tide or MSL/AHD conversion**. Submerged bed coverage and
shoreline connectivity have not been independently verified. This is a
local terrain/solver experiment, not a calibrated estuary inundation model.

Initial water is flood-filled from the Pine grid's eastern bay edge through
cells below the chosen level. Disconnected depressions start dry; lake levels
are unknown there. The idealised scene demonstrates separately initialised
lakes. The Pine terrain has its own **CC BY-SA** terms, retained attribution,
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

Next: independently verified bed surveys and datum conversions, prescribed
river inflow, a physically consistent offshore boundary time series, local
refinement and published run-up/inundation benchmarks. The current local pulse
is not coupled to the regional offshore solver or to an earthquake scenario.

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

## Checks and limits

Rust tests check rest over variable bathymetry, propagation speed against
`sqrt(g H)`, pulse splitting amplitude, displacement-volume conservation in a
closed basin, dry cells and reduction of returning waves by the sponge. JS
tests exercise the actual WASM bridge and browser tests exercise the built
worker, nested deployment paths, controls and export. Nonlinear tests check
resting water over a variable bed and a dry shore, separate lake levels,
positive depths, mass balance including sponge exchange, beach run-up and
subsequent drainage, and a dry-bed Ritter dam-break depth profile and contour
position. These first-order tests are not tsunami run-up certification. Run:

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
