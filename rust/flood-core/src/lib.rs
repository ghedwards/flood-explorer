//! Flood Explorer's flood model: terrain, drainage, river levels, flash
//! flooding, hazard and flood over time. A port of the JavaScript model
//! it replaced, with the same numbers; no outside crates, so it builds anywhere.

pub mod access;
pub mod impact;
pub mod mesh;
pub mod net;
pub mod fine;
pub mod voids;
pub mod flash;
pub mod render;
pub mod grid;
pub mod hydro;
pub mod surface;
pub mod util;
pub mod wave;

pub use fine::{fine_raster, Fine};
pub use voids::{classify_dem_gaps, Gaps, SEA_SHORE_MAX_M};
pub use flash::{flash_flood, storm_uplift, FlashSummary, Storm};
pub use grid::*;
pub use hydro::{analyse, encode_whitebox_d8, main_stem, snap_to_stream, Analysis};
pub use surface::*;
pub use render::*;
pub use wave::*;

pub mod inertial;
pub mod tsunami;

pub mod inundation;
pub mod geo;
pub mod nest;
pub mod dam;
pub mod place;

mod dispersion;
