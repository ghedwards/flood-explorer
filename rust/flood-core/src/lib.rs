//! Flood Explorer's flood model: terrain, drainage, river levels, flash
//! flooding, hazard and flood over time. A port of viewer/flood-core.js
//! with the same numbers; no outside crates, so it builds anywhere.

pub mod flash;
pub mod render;
pub mod grid;
pub mod hydro;
pub mod surface;
pub mod util;
pub mod wave;

pub use flash::{flash_flood, storm_uplift, FlashSummary, Storm};
pub use grid::*;
pub use hydro::{analyse, encode_whitebox_d8, main_stem, snap_to_stream, Analysis};
pub use surface::*;
pub use render::*;
pub use wave::*;

pub mod inertial;
