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

## Model

Both selectable methods solve the linear shallow-water equations:

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
physics must be compatible. The current solver cannot turn land data into
river or inundation predictions without implementing those dynamics.

## Extending to land, lakes and rivers

This requires a nonlinear shallow-water solver that evolves total water depth
and momentum, including advection, bed slope and friction. A well-balanced,
positivity-preserving scheme must keep still water at rest and allow cells to
wet and dry without introducing negative depths. The existing linear methods
cannot provide this by simply removing the land mask.

The input must retain bed elevation independently of the initial water surface.
Ocean water can start at a chosen tide level; lakes and rivers can have different
levels. A disconnected inland lake must not automatically start at sea level.
River discharge and upstream boundary conditions are separate from the tsunami
forcing at the offshore boundary. Banks, dunes and channel connections must be
resolved before interpreting overtopping or upstream propagation.

A practical first east-coast case is a small estuary inside the Moreton Bay
region, using a fine local terrain grid driven by offshore wave time series.
The existing 1.5 km grids cannot resolve its channels. Prefetch finer bathymetry,
land elevation, waterbody connectivity and available bed surveys, with explicit
coverage and vertical-datum metadata. Start with an idealised beach/channel/lake
case and validate run-up, still-water balance and mass conservation before
using a real local grid. Outputs would include water depth over land, current
speed and maximum inundation extent, rather than just surface displacement.

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
worker, nested deployment paths, controls and export. Run:

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

Next steps are real bathymetry/topography with compatible vertical datums,
well-defined source scenarios, nonlinear wetting/drying and grid refinement,
then validation against published analytical, laboratory and field benchmarks.
See [NOAA's modelling overview](https://nctr.pmel.noaa.gov/model.html) and
[analytical benchmark collection](https://nctr.pmel.noaa.gov/benchmark/Analytical/index.html).
