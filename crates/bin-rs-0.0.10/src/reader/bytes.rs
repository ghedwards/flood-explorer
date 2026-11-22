use crate::Endian;
use std::io::{Error, ErrorKind, SeekFrom};

use super::BinaryReader;

/// BytesReader from creating Slice `&[u8]` or `Vec<u8>`,
/// no use Read trait
#[derive(Debug, Clone)]
pub struct BytesReader {
  buffer: Vec<u8>,
  ptr: usize,
  endian: Endian,
}

impl BytesReader {
  pub fn new(buffer: &[u8]) -> Self {
    Self {
      buffer: buffer.to_vec(),
      ptr: 0,
      endian: crate::system_endian(),
    }
  }

  #[deprecated(since = "0.0.10", note = "Use new function `from(Vec<u8>)` instead")]
  pub fn from_vec(buffer: Vec<u8>) -> Self {
    Self::from(buffer)
  }

  fn check_bound(&mut self, size: usize) -> Result<(), Error> {
    if self.ptr + size > self.buffer.len() {
      let s = format!(
        "ountbound call ptr {} + {} but buffer length {}",
        self.ptr,
        size,
        &self.buffer.len()
      );
      Err(Error::new(ErrorKind::Other, s))
    } else {
      Ok(())
    }
  }
}

impl From<Vec<u8>> for BytesReader {
  fn from(buffer: Vec<u8>) -> Self {
    Self {
      buffer,
      ptr: 0,
      endian: crate::system_endian(),
    }
  }
}

impl From<&[u8]> for BytesReader {
  fn from(buffer: &[u8]) -> Self {
    Self {
      buffer: buffer.to_vec(),
      ptr: 0,
      endian: crate::system_endian(),
    }
  }
}

impl From<&Vec<u8>> for BytesReader {
  fn from(buffer: &Vec<u8>) -> Self {
    Self {
      buffer: buffer.to_vec(),
      ptr: 0,
      endian: crate::system_endian(),
    }
  }
}

#[cfg(feature = "serde")]
impl From<bytes::Bytes> for BytesReader {
  fn from(buffer: bytes::Bytes) -> Self {
    let buffer = buffer.to_vec();
    Self {
      buffer,
      ptr: 0,
      endian: crate::system_endian(),
    }
  }
}

impl BinaryReader for BytesReader {
  fn offset(&mut self) -> Result<u64, Error> {
    Ok(self.ptr as u64)
  }

  fn set_endian(&mut self, endian: Endian) {
    self.endian = endian;
  }

  fn endian(&self) -> Endian {
    self.endian
  }

  fn read_byte(&mut self) -> Result<u8, Error> {
    self.check_bound(1)?;
    let b = &self.buffer[self.ptr];
    self.ptr += 1;
    Ok(*b)
  }

  fn read_u8(&mut self) -> Result<u8, Error> {
    self.read_byte()
  }

  fn read_i8(&mut self) -> Result<i8, Error> {
    Ok(self.read_byte()? as i8)
  }

  fn read_exact(&mut self, array: &mut [u8]) -> Result<(), Error> {
    let len = array.len();
    self.check_bound(len)?;
    for i in 0..len {
      array[i] = self.buffer[self.ptr + i];
    }
    self.ptr += len;
    Ok(())
  }

  fn read_bytes_as_vec(&mut self, len: usize) -> Result<Vec<u8>, Error> {
    self.check_bound(len)?;
    let mut c: Vec<u8> = Vec::new();
    for i in 0..len {
      c.push(self.buffer[self.ptr + i]);
    }
    self.ptr += len;
    Ok(c)
  }

  // This function read bytes, but it does not move pointer.
  /// ```
  /// use bin_rs::reader::*;
  /// use std::io::Error;
  /// fn test() ->  Result<(),Error> {
  ///    let buffer = b"Hello World!";
  ///    let mut reader = BytesReader::new(buffer);
  ///    let buffer1 = reader.read_bytes_no_move(4)?;
  /// // assert_eq!(buffer1,b"Hell");
  ///    let buffer1 = reader.read_bytes_as_vec(4)?;
  /// // assert_eq!(buffer1,b"Hell");
  ///    let buffer1 = reader.read_bytes_as_vec(4)?;
  /// // assert_eq!(buffer1,b"o Wo");
  ///    return Ok(())
  /// }
  /// ```
  ///
  fn read_bytes_no_move(&mut self, len: usize) -> Result<Vec<u8>, Error> {
    self.check_bound(len)?;
    let mut c: Vec<u8> = Vec::new();
    for i in 0..len {
      c.push(self.buffer[self.ptr + i]);
    }
    Ok(c)
  }

  fn read_u16(&mut self) -> Result<u16, Error> {
    match self.endian {
      Endian::BigEndian => self.read_u16_be(),
      Endian::LittleEndian => self.read_u16_le(),
    }
  }

  fn read_u32(&mut self) -> Result<u32, Error> {
    match self.endian {
      Endian::BigEndian => self.read_u32_be(),
      Endian::LittleEndian => self.read_u32_le(),
    }
  }

  fn read_u64(&mut self) -> Result<u64, Error> {
    match self.endian {
      Endian::BigEndian => self.read_u64_be(),
      Endian::LittleEndian => self.read_u64_le(),
    }
  }

  fn read_u128(&mut self) -> Result<u128, Error> {
    match self.endian {
      Endian::BigEndian => self.read_u128_be(),
      Endian::LittleEndian => self.read_u128_le(),
    }
  }

  fn read_i16(&mut self) -> Result<i16, Error> {
    match self.endian {
      Endian::BigEndian => self.read_i16_be(),
      Endian::LittleEndian => self.read_i16_le(),
    }
  }

  fn read_i32(&mut self) -> Result<i32, Error> {
    match self.endian {
      Endian::BigEndian => self.read_i32_be(),
      Endian::LittleEndian => self.read_i32_le(),
    }
  }

  fn read_i64(&mut self) -> Result<i64, Error> {
    match self.endian {
      Endian::BigEndian => self.read_i64_be(),
      Endian::LittleEndian => self.read_i64_le(),
    }
  }

  fn read_i128(&mut self) -> Result<i128, Error> {
    match self.endian {
      Endian::BigEndian => self.read_i128_be(),
      Endian::LittleEndian => self.read_i128_le(),
    }
  }

  fn read_f32(&mut self) -> Result<f32, Error> {
    match self.endian {
      Endian::BigEndian => self.read_f32_be(),
      Endian::LittleEndian => self.read_f32_le(),
    }
  }

  fn read_f64(&mut self) -> Result<f64, Error> {
    match self.endian {
      Endian::BigEndian => self.read_f64_be(),
      Endian::LittleEndian => self.read_f64_le(),
    }
  }

  fn read_u16_be(&mut self) -> Result<u16, Error> {
    let len = 2;
    self.check_bound(len)?;
    let ptr = self.ptr;
    self.ptr += len;
    let buf = &&self.buffer;
    let array = [buf[ptr], buf[ptr + 1]];
    Ok(u16::from_be_bytes(array))
  }

  fn read_u32_be(&mut self) -> Result<u32, Error> {
    let len = 4;
    self.check_bound(len)?;
    let ptr = self.ptr;
    self.ptr += len;
    let buf = &self.buffer;
    let array = [buf[ptr], buf[ptr + 1], buf[ptr + 2], buf[ptr + 3]];
    Ok(u32::from_be_bytes(array))
  }

  fn read_u64_be(&mut self) -> Result<u64, Error> {
    let len = 8;
    self.check_bound(len)?;
    let ptr = self.ptr;
    self.ptr += len;
    let buf = &self.buffer;
    let array = [
      buf[ptr],
      buf[ptr + 1],
      buf[ptr + 2],
      buf[ptr + 3],
      buf[ptr + 4],
      buf[ptr + 5],
      buf[ptr + 6],
      buf[ptr + 7],
    ];
    Ok(u64::from_be_bytes(array))
  }

  fn read_u128_be(&mut self) -> Result<u128, Error> {
    let len = 16;
    self.check_bound(len)?;
    let ptr = self.ptr;
    self.ptr += len;
    let buf = &self.buffer;
    let array = [
      buf[ptr],
      buf[ptr + 1],
      buf[ptr + 2],
      buf[ptr + 3],
      buf[ptr + 4],
      buf[ptr + 5],
      buf[ptr + 6],
      buf[ptr + 7],
      buf[ptr + 8],
      buf[ptr + 9],
      buf[ptr + 10],
      buf[ptr + 11],
      buf[ptr + 12],
      buf[ptr + 13],
      buf[ptr + 14],
      buf[ptr + 15],
    ];
    Ok(u128::from_be_bytes(array))
  }

  fn read_i16_be(&mut self) -> Result<i16, Error> {
    let len = 2;
    self.check_bound(len)?;
    let ptr = self.ptr;
    self.ptr += len;
    let buf = &self.buffer;
    let array = [buf[ptr], buf[ptr + 1]];
    Ok(i16::from_be_bytes(array))
  }

  fn read_i32_be(&mut self) -> Result<i32, Error> {
    let len = 4;
    self.check_bound(len)?;
    let ptr = self.ptr;
    self.ptr += len;
    let buf = &self.buffer;
    let array = [buf[ptr], buf[ptr + 1], buf[ptr + 2], buf[ptr + 3]];
    Ok(i32::from_be_bytes(array))
  }

  fn read_i64_be(&mut self) -> Result<i64, Error> {
    let len = 8;
    self.check_bound(len)?;
    let ptr = self.ptr;
    self.ptr += len;
    let buf = &self.buffer;
    let array = [
      buf[ptr],
      buf[ptr + 1],
      buf[ptr + 2],
      buf[ptr + 3],
      buf[ptr + 4],
      buf[ptr + 5],
      buf[ptr + 6],
      buf[ptr + 7],
    ];
    Ok(i64::from_be_bytes(array))
  }

  fn read_i128_be(&mut self) -> Result<i128, Error> {
    let len = 16;
    self.check_bound(len)?;
    let ptr = self.ptr;
    self.ptr += len;
    let buf = &self.buffer;
    let array = [
      buf[ptr],
      buf[ptr + 1],
      buf[ptr + 2],
      buf[ptr + 3],
      buf[ptr + 4],
      buf[ptr + 5],
      buf[ptr + 6],
      buf[ptr + 7],
      buf[ptr + 8],
      buf[ptr + 9],
      buf[ptr + 10],
      buf[ptr + 11],
      buf[ptr + 12],
      buf[ptr + 13],
      buf[ptr + 14],
      buf[ptr + 15],
    ];
    Ok(i128::from_be_bytes(array))
  }

  fn read_f32_be(&mut self) -> Result<f32, Error> {
    let len = 4;
    self.check_bound(len)?;
    let ptr = self.ptr;
    self.ptr += len;
    let buf = &self.buffer;

    let array = [buf[ptr], buf[ptr + 1], buf[ptr + 2], buf[ptr + 3]];
    Ok(f32::from_be_bytes(array))
  }

  fn read_f64_be(&mut self) -> Result<f64, Error> {
    let len = 8;
    self.check_bound(len)?;
    let ptr = self.ptr;
    self.ptr += len;
    let buf = &self.buffer;
    let array = [
      buf[ptr],
      buf[ptr + 1],
      buf[ptr + 2],
      buf[ptr + 3],
      buf[ptr + 4],
      buf[ptr + 5],
      buf[ptr + 6],
      buf[ptr + 7],
    ];
    Ok(f64::from_be_bytes(array))
  }

  fn read_u16_le(&mut self) -> Result<u16, Error> {
    let len = 2;
    self.check_bound(len)?;
    let ptr = self.ptr;
    self.ptr += len;
    let buf = &self.buffer;
    let array = [buf[ptr], buf[ptr + 1]];
    Ok(u16::from_le_bytes(array))
  }

  fn read_u32_le(&mut self) -> Result<u32, Error> {
    let len = 4;
    self.check_bound(len)?;
    let ptr = self.ptr;
    self.ptr += len;
    let buf = &self.buffer;
    let array = [buf[ptr], buf[ptr + 1], buf[ptr + 2], buf[ptr + 3]];
    Ok(u32::from_le_bytes(array))
  }

  fn read_u64_le(&mut self) -> Result<u64, Error> {
    let len = 8;
    self.check_bound(len)?;
    let ptr = self.ptr;
    self.ptr += len;
    let buf = &self.buffer;
    let array = [
      buf[ptr],
      buf[ptr + 1],
      buf[ptr + 2],
      buf[ptr + 3],
      buf[ptr + 4],
      buf[ptr + 5],
      buf[ptr + 6],
      buf[ptr + 7],
    ];
    Ok(u64::from_le_bytes(array))
  }

  fn read_u128_le(&mut self) -> Result<u128, Error> {
    let len = 16;
    self.check_bound(len)?;
    let ptr = self.ptr;
    self.ptr += len;
    let buf = &self.buffer;
    let array = [
      buf[ptr],
      buf[ptr + 1],
      buf[ptr + 2],
      buf[ptr + 3],
      buf[ptr + 4],
      buf[ptr + 5],
      buf[ptr + 6],
      buf[ptr + 7],
      buf[ptr + 8],
      buf[ptr + 9],
      buf[ptr + 10],
      buf[ptr + 11],
      buf[ptr + 12],
      buf[ptr + 13],
      buf[ptr + 14],
      buf[ptr + 15],
    ];
    Ok(u128::from_le_bytes(array))
  }

  fn read_i16_le(&mut self) -> Result<i16, Error> {
    let len = 2;
    self.check_bound(len)?;
    let ptr = self.ptr;
    self.ptr += len;
    let buf = &self.buffer;
    let array = [buf[ptr], buf[ptr + 1]];
    Ok(i16::from_le_bytes(array))
  }

  fn read_i32_le(&mut self) -> Result<i32, Error> {
    let len = 4;
    self.check_bound(len)?;
    let ptr = self.ptr;
    self.ptr += len;
    let buf = &self.buffer;
    let array = [buf[ptr], buf[ptr + 1], buf[ptr + 2], buf[ptr + 3]];
    Ok(i32::from_le_bytes(array))
  }

  fn read_i64_le(&mut self) -> Result<i64, Error> {
    let len = 8;
    self.check_bound(len)?;
    let ptr = self.ptr;
    self.ptr += len;
    let buf = &self.buffer;
    let array = [
      buf[ptr],
      buf[ptr + 1],
      buf[ptr + 2],
      buf[ptr + 3],
      buf[ptr + 4],
      buf[ptr + 5],
      buf[ptr + 6],
      buf[ptr + 7],
    ];
    Ok(i64::from_le_bytes(array))
  }

  fn read_i128_le(&mut self) -> Result<i128, Error> {
    let len = 16;
    self.check_bound(len)?;
    let ptr = self.ptr;
    self.ptr += len;
    let buf = &self.buffer;
    let array = [
      buf[ptr],
      buf[ptr + 1],
      buf[ptr + 2],
      buf[ptr + 3],
      buf[ptr + 4],
      buf[ptr + 5],
      buf[ptr + 6],
      buf[ptr + 7],
      buf[ptr + 8],
      buf[ptr + 9],
      buf[ptr + 10],
      buf[ptr + 11],
      buf[ptr + 12],
      buf[ptr + 13],
      buf[ptr + 14],
      buf[ptr + 15],
    ];
    Ok(i128::from_le_bytes(array))
  }

  fn read_f32_le(&mut self) -> Result<f32, Error> {
    let len = 4;
    self.check_bound(len)?;
    let ptr = self.ptr;
    self.ptr += len;
    let buf = &self.buffer;

    let array = [buf[ptr], buf[ptr + 1], buf[ptr + 2], buf[ptr + 3]];
    Ok(f32::from_le_bytes(array))
  }

  fn read_f64_le(&mut self) -> Result<f64, Error> {
    let len = 8;
    self.check_bound(len)?;
    let ptr = self.ptr;
    self.ptr += len;
    let buf = &self.buffer;

    let array = [
      buf[ptr],
      buf[ptr + 1],
      buf[ptr + 2],
      buf[ptr + 3],
      buf[ptr + 4],
      buf[ptr + 5],
      buf[ptr + 6],
      buf[ptr + 7],
    ];
    Ok(f64::from_le_bytes(array))
  }

  #[cfg(feature = "codec")]
  fn read_local_string(&mut self, size: usize, code: CodeType) -> Result<String, Error> {
    self.check_bound(size)?;
    self.ptr += size;
    Err(Error::new(ErrorKind::Other, "No impl"));
  }

  /// skip_ptr skips offset size bytes
  fn skip_ptr(&mut self, size: usize) -> Result<usize, Error> {
    self.check_bound(size)?;
    self.ptr += size;
    Ok(size)
  }

  fn seek(&mut self, seek: SeekFrom) -> std::result::Result<u64, Error> {
    match seek {
      SeekFrom::Start(pos) => {
        if pos > self.buffer.len() as u64 {
          let s = format!(
            "set offset {},but buffer length is{}",
            pos,
            self.buffer.len()
          );
          return Err(Error::new(ErrorKind::Other, s));
        }
        self.ptr = pos as usize;
        Ok(self.ptr as u64)
      }
      SeekFrom::End(pos_) => {
        let pos = self.buffer.len() as i64 + pos_;
        if pos < 0 || pos > (self.buffer.len() as i64) {
          let s = format!(
            "set offset {},but buffer length is {}",
            pos,
            self.buffer.len()
          );
          return Err(Error::new(ErrorKind::Other, s));
        }
        self.ptr = pos as usize;
        Ok(self.ptr as u64)
      }
      SeekFrom::Current(pos) => {
        let ptr = (self.ptr as i64) + pos;
        if (self.buffer.len() as i64) < ptr || ptr < 0 {
          let s = format!(
            "set offset {},but buffer length is{}",
            ptr,
            self.buffer.len()
          );
          return Err(Error::new(ErrorKind::Other, s));
        }
        self.ptr = ptr as usize;
        Ok(self.ptr as u64)
      }
    }
  }
}
