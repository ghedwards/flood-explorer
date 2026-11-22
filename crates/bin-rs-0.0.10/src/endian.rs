//! Endinen is Big Endien or Little Endian.
//! bin_rs is default use System Endian.
//! if your use other endian, you can use set_endian function.
//! ```
//! use bin_rs::reader::*;
//! use bin_rs::Endian;
//! use std::io::Error;
//!
//! fn read_file() -> Result<(), Error> {
//!   let buffer = b"\x00\x01\x02\x03\x04\x05\x06\x07";
//!   let mut reader = BytesReader::new(buffer);
//!   reader.set_endian(Endian::BigEndian);
//!   let r = reader.read_u16()?; // Read BigEndian
//!   assert_eq!(r, 1);
//!   reader.set_endian(Endian::LittleEndian);
//!   let r = reader.read_u16()?; // Read LittleEndian
//!   assert_eq!(r, 0x0302);
//!   Ok(())
//! }
//! ```
use std::fmt::Display;
#[derive(Copy, Debug, Clone, PartialEq)]
/// Endinen is Big Endien or Little Endian.
pub enum Endian {
  /// Big Endian is 0x00ff (16bit) set 0x00 0xff in address (ex. Motorola CPU)
  BigEndian,
  /// Little Endian is 0x00ff (16bit) set 0xff 0x00 in address (ex. Intel CPU)
  LittleEndian,
}

impl Endian {
  pub fn as_str(&self) -> &str {
    match &self {
      Endian::BigEndian => "Big Endian",
      Endian::LittleEndian => "Little Endian",
    }
  }
}

impl Display for Endian {
  fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> Result<(), std::fmt::Error> {
    write!(f, "{}", &self.as_str())
  }
}

pub(crate) fn system_endian() -> Endian {
  if cfg!(target_endian = "big") {
    Endian::BigEndian
  } else {
    Endian::LittleEndian
  }
}
