use crate::Endian;
use std::io::{Error, ErrorKind, SeekFrom};

/// 0.0.11 Some functions have been changed to be written in this trait.
pub trait BinaryReader {
  fn set_endian(&mut self, endian: Endian);
  fn endian(&self) -> Endian;

  fn read_byte(&mut self) -> Result<u8, Error>;
  fn read_u8(&mut self) -> Result<u8, Error>;

  #[deprecated(since = "0.0.10", note = "Use new function `read_exact()` instead")]
  fn read_bytes(&mut self, array: &mut [u8]) -> Result<(), Error> {
    self.read_exact(array)
  }

  fn read_exact(&mut self, array: &mut [u8]) -> Result<(), Error>;

  //    fn read_bytes(&mut self,len: usize) -> Result<&[u8],Error>;
  fn read_bytes_as_vec(&mut self, len: usize) -> Result<Vec<u8>, Error>;

  /// read_bytes_no_move does not move offset after read_bytes.
  ///
  /// Assumed to be used for header checks.
  ///

  fn read_bytes_no_move(&mut self, len: usize) -> Result<Vec<u8>, Error>;

  fn read_u16(&mut self) -> Result<u16, Error>;
  fn read_u32(&mut self) -> Result<u32, Error>;
  fn read_u64(&mut self) -> Result<u64, Error>;
  fn read_u128(&mut self) -> Result<u128, Error>;
  fn read_i8(&mut self) -> Result<i8, Error>;
  fn read_i16(&mut self) -> Result<i16, Error>;
  fn read_i32(&mut self) -> Result<i32, Error>;
  fn read_i64(&mut self) -> Result<i64, Error>;
  fn read_i128(&mut self) -> Result<i128, Error>;

  fn read_f32(&mut self) -> Result<f32, Error>;
  fn read_f64(&mut self) -> Result<f64, Error>;

  fn read_u16_be(&mut self) -> Result<u16, Error>;
  fn read_u32_be(&mut self) -> Result<u32, Error>;
  fn read_u64_be(&mut self) -> Result<u64, Error>;
  fn read_u128_be(&mut self) -> Result<u128, Error>;
  fn read_i16_be(&mut self) -> Result<i16, Error>;
  fn read_i32_be(&mut self) -> Result<i32, Error>;
  fn read_i64_be(&mut self) -> Result<i64, Error>;
  fn read_i128_be(&mut self) -> Result<i128, Error>;

  fn read_f32_be(&mut self) -> Result<f32, Error>;
  fn read_f64_be(&mut self) -> Result<f64, Error>;

  fn read_u16_le(&mut self) -> Result<u16, Error>;
  fn read_u32_le(&mut self) -> Result<u32, Error>;
  fn read_u64_le(&mut self) -> Result<u64, Error>;
  fn read_u128_le(&mut self) -> Result<u128, Error>;
  fn read_i16_le(&mut self) -> Result<i16, Error>;
  fn read_i32_le(&mut self) -> Result<i32, Error>;
  fn read_i64_le(&mut self) -> Result<i64, Error>;
  fn read_i128_le(&mut self) -> Result<i128, Error>;

  fn read_f32_le(&mut self) -> Result<f32, Error>;
  fn read_f64_le(&mut self) -> Result<f64, Error>;

  /// read_ascii_string for C like ascii string.This function finishes find end marker 0x00.
  /// ```
  /// use bin_rs::reader::*;
  /// use std::io::Error;
  ///
  /// fn test() -> Result<String,Error> {
  ///   let buffer = b"Hello World!\01234";
  ///   let mut reader = BytesReader::new(buffer);
  ///   let r = reader.read_ascii_string("Hello World!\01234".len())?;  // after \0 is trim
  ///   //assert_eq!(r ,"Hello World!");
  ///   return Ok(r)
  /// }
  /// ```

  fn read_ascii_string(&mut self, size: usize) -> Result<String, Error> {
    let mut array: Vec<u8> = vec![0; size];
    self.read_exact(&mut array)?;

    let buf = &array;
    let mut s = Vec::new();
    for b in buf {
      if *b == 0 {
        break;
      }
      s.push(*b as u16);
    }
    let res = String::from_utf16(&s);
    match res {
      Ok(strings) => Ok(strings),
      _ => {
        let err = "This string can not read";
        Err(Error::new(ErrorKind::Other, err))
      }
    }
  }

  /// 0.0.11
  /// read_utf16_string for utf16 string. use endien
  /// "size" refers to the number of bytes.
  fn read_utf16_string(&mut self, size: usize) -> Result<String, Error> {
    let size = size / 2;
    let mut array: Vec<u16> = vec![0; size];
    for i in 0..size {
      array[i] = self.read_u16()?;
    }
    let res = String::from_utf16(&array);
    match res {
      Ok(strings) => Ok(strings),
      _ => {
        let err = "This string can not read";
        Err(Error::new(ErrorKind::Other, err))
      }
    }
  }

  fn read_utf16be_string(&mut self, size: usize) -> Result<String, Error> {
    let endian = self.endian();
    self.set_endian(Endian::BigEndian);
    let result = self.read_utf16_string(size);
    self.set_endian(endian);
    result
  }

  fn read_utf16le_string(&mut self, size: usize) -> Result<String, Error> {
    let endian = self.endian();
    self.set_endian(Endian::LittleEndian);
    let result = self.read_utf16_string(size);
    self.set_endian(endian);
    result
  }

  fn read_utf8_string(&mut self, size: usize) -> Result<String, Error> {
    let mut array: Vec<u8> = vec![0; size];
    for i in 0..size {
      array[i] = self.read_u8()?;
    }
    let res = String::from_utf8(array);
    match res {
      Ok(strings) => Ok(strings),
      _ => {
        let err = "This string can not read";
        Err(Error::new(ErrorKind::Other, err))
      }
    }
  }

  #[cfg(feature = "codec")]
  fn read_local_string(&mut self, size: usize, code: CodeType) -> Result<String, Error>;

  /// skip size byte
  fn skip_ptr(&mut self, size: usize) -> Result<usize, Error>;

  fn offset(&mut self) -> Result<u64, Error>;
  fn seek(&mut self, seek: SeekFrom) -> Result<u64, Error>;
}
