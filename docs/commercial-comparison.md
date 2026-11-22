# Comparison with a commercial flash-flood forecaster

Written 8 November 2026.

**Method and limits.** The commercial product (called "the comparator" below) was assessed from the
text of its live-forecast, technology and alerts pages only; the running map was
not inspected, so its look, speed and accuracy are unverified. Its products,
terms and study pages were not read. Flood Explorer was assessed from this
repository's README, roadmap and layout; it was not run for this comparison.
The roadmap's caution applies: implemented does not mean validated.

## What each one is

**The comparator** is a commercial product. It
forecasts street-level flooding from the rain on the radar, updated every 10
minutes, for the cities of one Australian state. The question it answers: what will the current rain do to my street in
the next 2 hours?

**Flood Explorer** is a free, open-source screening and scenario tool for all
of Australia, running mostly in the browser (Rust compiled to WebAssembly). The
question it answers: what would flood under this scenario, and what is
affected?

## Side by side

| | Comparator | Flood Explorer |
|---|---|---|
| Core question | What will the current rain flood in the next 2 hours? | What floods under this scenario, and what is affected? |
| Live rain input | Commercial radar-nowcast provider; "Now" and "Next 2 h" views; 24 h forecast tab | RainViewer radar overlay only (latest frame, not fed into the flood model) |
| Resolution | 1 to 5 m cells; 1 m LiDAR | About 30 m (GA DEM-H); finer only in places |
| Model | U-Net network trained on tens of thousands of physics runs of ARR design storms, with a GPU 2D solver as reference; runs on a CPU | Screening model plus an experimental 2D local-inertial solver (Rust/WASM) |
| Roads | Separate "roads flooded" depth legend | Roads cut over 30 cm, named worst roads, evacuation routes avoiding flooded roads |
| Coverage | Urban areas of one state | All of Australia (about 60 presets, any map point) |
| Hazards | Flash flooding; paid certified flood studies | River, coast and storm tide, flash, dam break, levee failure, tsunami (experimental) |
| Gauges and warnings | BoM and state gauges as inputs | BoM gauges, dams, warnings, Google Flood Hub, recorded-flood replay |
| Impacts | Depth and roads; site forecasts and studies paid | Buildings, people (ABS Census), key sites, over-floor flooding, H1 to H6 hazard, property check |
| Alerts | Free trial for one address, then a monthly subscription for several addresses (channel not stated) | None |
| Offline / install | Not stated | Service worker, installable, offline badge, Tauri desktop app |
| Accessibility | Not stated | Keyboard map, announced status messages |
| Business model | Commercial; certified studies signed by a registered engineer | Free, MIT licence, "not for emergency or property decisions" |

## Where the comparator is ahead

1. **A live forecast is the product.** Street-level depths for the next 2 hours
   with no scenario to set up. Flood Explorer's radar is only a picture.
2. **Resolution.** At 1 to 5 m, streets and properties are meaningful. At 30 m,
   kerbs, drains and overland flow between buildings are lost.
3. **Speed.** A trained network returns results in seconds.
4. **Address alerts.** The feature people use during an event, and the revenue
   model.
5. **Focus.** Search an address, see depth, check the forecast and what-ifs.
   Flood Explorer exposes dozens of panels.
6. **Drainage data.** The comparator credits a council's drain data. Flood
   Explorer has no drainage network.

## Where Flood Explorer is ahead

1. **Breadth** of coverage and hazard types.
2. **Decision support**: impacts, hazard classes, evacuation routes, property
   check.
3. **Transparency**: public code, methods, design notes and validation docs.
4. **Scenario work**: pinned comparisons, recorded-flood replay, satellite and
   council-map checks, GeoTIFF/GeoJSON/report export.
5. **Resilience**: offline use, installable app and desktop app.
6. **Cost**: free.

## Suggested priorities

Ordered by how much each closes the gap.

1. **Radar rainfall into the 2D solver for a "now + 2 h" run.** The solver and
   storm mode exist; this is mostly data plumbing and the largest gap.
2. **A fast surrogate for the solver**, trained on its own output, to match
   the comparator's seconds-not-minutes response.
3. **Higher-resolution terrain where LiDAR is openly available** (starting with
   state 1 m LiDAR programs), and drain/pipe data where councils publish it.
4. **Address-based alerts**, even a simple one-address email or push.
5. **A simple "address to forecast" front door** over the existing expert
   panels.
6. **Keep and sharpen the safety messaging**: "never enter floodwater" and
   000/SES numbers alongside the existing disclaimers.

## Open questions

- How accurate is the comparator in practice? A hands-on trial against a real event
  would settle it.
- Rain source: the comparator's provider is commercial. A free route would be BoM radar, if a
  permitted access path exists (the roadmap already notes BoM access limits).
- Alerts need a delivery channel and hosting beyond static GitHub Pages, which
  would likely involve the `broker`.

## Other kinds of commercial flood product

This compares categories, not named products. Everything here is general; none of it
describes a particular company, and prices and licence terms were not found.

| | Flood Explorer | Pre-computed hazard maps | Address-level risk and loss models | Live property-level forecasts |
|---|---|---|---|---|
| What it is | Open-source 2D screening model with live gauges | Country or world maps of depth at set return periods | Per-address depths and losses, mostly sold to insurers | Radar nowcast driving a fine 2D model, with drains and sensors |
| Resolution | 30 m everywhere, 5 m picture where LiDAR exists | Typically 5 to 90 m, finer in some countries | Address level | Tens of metres |
| Return-period catalogue | No: scenarios you run | Yes, with defended and undefended cases | Yes | Not applicable (live) |
| Live nowcast | Yes, from supplied radar (untested on real radar) | No | No | Yes |
| Independent validation or certification | No | Published validation, accepted by insurers | Used by insurers | Commercial clients |
| Terms | Free, but the data feeds forbid commercial use | Commercial licence | Commercial licence | Commercial licence |

Where the commercial categories are ahead: whole-country coverage at fixed return periods,
validation and acceptance by insurers, address-level loss figures, and running live for
paying clients. Where Flood Explorer differs: the method is open and inspectable, every
limit is stated, it is free to run, it works offline, and it also models tsunami and dam
failure. Its limits: it is a screening tool, not a certified flood study, and its data
licences rule out commercial use.
