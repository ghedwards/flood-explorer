//! A reader default uses system endianness
//! If you will use another endianness,use set_endian.
//! 0.0.10 StreamReader enable for wasm32

mod binary;
mod bytes;
mod stream;
pub use self::binary::BinaryReader;
pub use self::bytes::BytesReader;
pub use self::stream::StreamReader;

#[cfg(feature = "codec")]
use encoding_rs::*;

#[cfg(feature = "codec")]
pub enum CodeType {
  Ascii,
  Big5,
  EucJp,
  EucKr,
  Gb18030,
  Jis,
  ShiftJis,
  Utf16Be,
  Utf16le,
  Utf8,
}
