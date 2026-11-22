use crate::Endian;
use std::fs::File;
use std::io::BufRead;
use std::io::BufReader;
use std::io::Cursor;
use std::io::Error;
use std::io::ErrorKind;
/// 0.0.8 Enable support for target_family other than "wasm", feature "stream" is disabled.
///
/// StreamReader from creating BufRead
/// use BufRead trait
use std::io::Read;
use std::io::Seek;

use std::path::PathBuf;

use super::BinaryReader;

#[derive(Copy, Debug, Clone)]
pub struct StreamReader<R> {
  reader: R,
  endian: Endian,
}

impl StreamReader<BufReader<File>> {
  #[cfg(not(target_family = "wasm"))]
  pub fn from_file(filename: PathBuf) -> Result<Self, Error> {
    let file = File::open(filename)?;
    let reader = BufReader::new(file);
    Ok(Self {
      reader,
      endian: crate::system_endian(),
    })
  }
}

impl<R: BufRead + Seek> StreamReader<R> {
  pub fn new(reader: R) -> StreamReader<R> {
    StreamReader {
      reader,
      endian: crate::system_endian(),
    }
  }
}

impl<R> From<R> for StreamReader<Cursor<R>>
where
  R: Read,
{
  fn from(reader: R) -> Self {
    let reader = Cursor::new(reader);
    Self {
      reader,
      endian: crate::system_endian(),
    }
  }
}

#[cfg(not(target_family = "wasm"))]
impl From<File> for StreamReader<BufReader<File>> {
  fn from(file: File) -> Self {
    let reader = BufReader::new(file);
    Self {
      reader,
      endian: crate::system_endian(),
    }
  }
}

impl<R: BufRead + Seek> BinaryReader for StreamReader<R> {
  fn set_endian(&mut self, endian: Endian) {
    self.endian = endian;
  }

  fn endian(&self) -> Endian {
    self.endian
  }

  fn read_byte(&mut self) -> Result<u8, Error> {
    let mut buffer = [0; 1];
    self.reader.read_exact(&mut buffer)?;
    Ok(buffer[0])
  }
  fn read_u8(&mut self) -> Result<u8, Error> {
    self.read_byte()
  }

  fn read_i8(&mut self) -> Result<i8, Error> {
    Ok(self.read_byte()? as i8)
  }

  fn read_exact(&mut self, array: &mut [u8]) -> std::result::Result<(), Error> {
    self.reader.read_exact(array)?;
    Ok(())
  }

  fn read_bytes_as_vec(&mut self, len: usize) -> Result<Vec<u8>, Error> {
    let mut array: Vec<u8> = (0..len).map(|_| 0).collect();
    self.reader.read_exact(&mut array)?;
    Ok(array)
  }

  // This function read bytes and does not move pointer.
  // However it's behavior dependences read buffer size.
  fn read_bytes_no_move(&mut self, len: usize) -> Result<Vec<u8>, Error> {
    let buffer = self.reader.fill_buf()?;
    if buffer.len() < len {
      let err = format!(
        "Data shotage,request {} but read {} bytes",
        len,
        buffer.len()
      );
      return Err(Error::new(ErrorKind::Other, err));
    }
    let array: Vec<u8> = (0..len).map(|i| buffer[i]).collect();
    Ok(array)
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
    let mut array = [0; 2];
    self.reader.read_exact(&mut array)?;
    Ok(u16::from_be_bytes(array))
  }

  fn read_u32_be(&mut self) -> Result<u32, Error> {
    let mut array = [0; 4];
    self.reader.read_exact(&mut array)?;
    Ok(u32::from_be_bytes(array))
  }

  fn read_u64_be(&mut self) -> Result<u64, Error> {
    let mut array = [0; 8];
    self.reader.read_exact(&mut array)?;
    Ok(u64::from_be_bytes(array))
  }

  fn read_u128_be(&mut self) -> Result<u128, Error> {
    let mut array = [0; 16];
    self.reader.read_exact(&mut array)?;
    Ok(u128::from_be_bytes(array))
  }

  fn read_i16_be(&mut self) -> Result<i16, Error> {
    let mut array = [0; 2];
    self.reader.read_exact(&mut array)?;
    Ok(i16::from_be_bytes(array))
  }

  fn read_i32_be(&mut self) -> Result<i32, Error> {
    let mut array = [0; 4];
    self.reader.read_exact(&mut array)?;
    Ok(i32::from_be_bytes(array))
  }

  fn read_i64_be(&mut self) -> Result<i64, Error> {
    let mut array = [0; 8];
    self.reader.read_exact(&mut array)?;
    Ok(i64::from_be_bytes(array))
  }

  fn read_i128_be(&mut self) -> Result<i128, Error> {
    let mut array = [0; 16];
    self.reader.read_exact(&mut array)?;
    Ok(i128::from_be_bytes(array))
  }

  fn read_f32_be(&mut self) -> Result<f32, Error> {
    let mut array = [0; 4];
    self.reader.read_exact(&mut array)?;
    Ok(f32::from_be_bytes(array))
  }

  fn read_f64_be(&mut self) -> Result<f64, Error> {
    let mut array = [0; 8];
    self.reader.read_exact(&mut array)?;
    Ok(f64::from_be_bytes(array))
  }

  fn read_u16_le(&mut self) -> Result<u16, Error> {
    let mut array = [0; 2];
    self.reader.read_exact(&mut array)?;
    Ok(u16::from_le_bytes(array))
  }

  fn read_u32_le(&mut self) -> Result<u32, Error> {
    let mut array = [0; 4];
    self.reader.read_exact(&mut array)?;
    Ok(u32::from_le_bytes(array))
  }

  fn read_u64_le(&mut self) -> Result<u64, Error> {
    let mut array = [0; 8];
    self.reader.read_exact(&mut array)?;
    Ok(u64::from_le_bytes(array))
  }

  fn read_u128_le(&mut self) -> Result<u128, Error> {
    let mut array = [0; 16];
    self.reader.read_exact(&mut array)?;
    Ok(u128::from_le_bytes(array))
  }

  fn read_i16_le(&mut self) -> Result<i16, Error> {
    let mut array = [0; 2];
    self.reader.read_exact(&mut array)?;
    Ok(i16::from_le_bytes(array))
  }

  fn read_i32_le(&mut self) -> Result<i32, Error> {
    let mut array = [0; 4];
    self.reader.read_exact(&mut array)?;
    Ok(i32::from_le_bytes(array))
  }

  fn read_i64_le(&mut self) -> Result<i64, Error> {
    let mut array = [0; 8];
    self.reader.read_exact(&mut array)?;
    Ok(i64::from_le_bytes(array))
  }

  fn read_i128_le(&mut self) -> Result<i128, Error> {
    let mut array = [0; 16];
    self.reader.read_exact(&mut array)?;
    Ok(i128::from_le_bytes(array))
  }

  fn read_f32_le(&mut self) -> Result<f32, Error> {
    let mut array = [0; 4];
    self.reader.read_exact(&mut array)?;
    Ok(f32::from_le_bytes(array))
  }

  fn read_f64_le(&mut self) -> Result<f64, Error> {
    let mut array = [0; 8];
    self.reader.read_exact(&mut array)?;
    Ok(f64::from_le_bytes(array))
  }

  #[cfg(feature = "codec")]
  fn read_local_string(&mut self, size: usize, code: CodeType) -> Result<String, Error> {
    let mut array: Vec<u8> = (0..size).map(|_| 0).collect();
    self.reader.read_exact(&mut array)?;

    let buf = &array;
    let mut s = Vec::new();
    for i in 0..size {
      if buf[i] == 0 {
        break;
      }
      s.push(buf[i]);
    }
    let res = String::from_utf8(s);
    match res {
      Ok(strings) => {
        return Ok(strings);
      }
      _ => {
        let err = "This string can not read";
        return Err(Error::new(ErrorKind::Other, err));
      }
    }
  }

  /// skip size byte
  fn skip_ptr(&mut self, size: usize) -> Result<usize, Error> {
    let mut array: Vec<u8> = (0..size).map(|_| 0).collect();
    self.reader.read_exact(&mut array)?;
    Ok(size)
  }

  fn offset(&mut self) -> std::result::Result<u64, Error> {
    self.reader.stream_position()
  }

  fn seek(&mut self, seek: std::io::SeekFrom) -> std::result::Result<u64, Error> {
    self.reader.seek(seek)
  }
}
