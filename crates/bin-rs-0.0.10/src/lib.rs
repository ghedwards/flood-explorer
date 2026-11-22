//! Crate bin_rs is a binary manipulate crate.
//!

pub mod reader;
#[cfg(feature = "async")]
pub mod async_reader;
pub mod endian;
#[cfg(feature = "util")]
pub mod io;
pub use endian::*;
#[cfg(test)]
pub mod test;
