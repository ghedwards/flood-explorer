//! async_reader is a test feature.
//! This async is dipoable.
//! now refactoring 

use tokio::io::AsyncReadExt;
use tokio::io::AsyncBufReadExt;
use tokio::io::AsyncSeek;
use tokio::io::AsyncSeekExt;
type Error = Box<dyn std::error::Error>;
use std::io::ErrorKind;
use std::io::SeekFrom;
use crate::Endian;

/// using AsyncBytesReader feature async only
/// 
/// AsyncBytesReader is async functions bytesreader on stream
#[derive(Copy,Debug,Clone)]
pub struct AsyncBytesReader<R> {
    reader: R,
    endian: Endian,
}

impl<R: AsyncBufReadExt + Send + std::marker::Unpin>  AsyncBytesReader<R> {

    pub fn new(reader: R) -> AsyncBytesReader<R> {
        AsyncBytesReader {
            reader: reader,
            endian: crate::system_endian(),
        }
    }
    
    pub fn set_endian(&mut self, endian: Endian) {
        self.endian = endian;
    }

    pub fn endian(&self) -> Endian {
        self.endian
    }
 
    pub async fn read_byte(&mut self) -> Result<u8,Error>{
        let mut buffer = [0; 1];
        self.reader.read_exact(&mut buffer).await?;
        Ok(buffer[0])
    }
    
    pub async fn read_u8(&mut self) -> Result<u8,Error>{
        Ok(self.read_byte().await?)
    }

    pub async fn read_i8(&mut self) -> Result<i8,Error>{
        Ok(self.read_byte().await? as i8)
    }

    pub async fn read_bytes_as_vec(&mut self,len: usize) -> Result<Vec<u8>,Error>{
        let mut array: Vec<u8> = (0..len).map(|_| 0).collect();
        self.reader.read_exact(&mut array).await?;
        Ok(array)
    }

    pub async fn read_bytes_no_move(&mut self,len: usize) -> Result<Vec<u8>,Error>{
        let buffer = self.reader.fill_buf().await?;
        if buffer.len() <= len {
            let err = "Data shotage";
            return Err(Box::new(std::io::Error::new(ErrorKind::Other,err)));
        }
        let array: Vec<u8> = (0..len).map(|i| buffer[i]).collect();
        Ok(array)
    }

    pub async fn read_u16(&mut self) -> Result<u16,Error>{
        match self.endian {
            Endian::BigEndian => {
                self.read_u16_be().await
            },
            Endian::LittleEndian => {
                self.read_u16_le().await
            }
        }
    }

    pub async fn read_u32(&mut self) ->  Result<u32,Error>{
        match self.endian {
            Endian::BigEndian => {
                self.read_u32_be().await
            },
            Endian::LittleEndian => {
                self.read_u32_le().await
            }
        }
    }

    pub async fn read_u64(&mut self) -> Result<u64,Error>{
        match self.endian {
            Endian::BigEndian => {
                self.read_u64_be().await
            },
            Endian::LittleEndian => {
                self.read_u64_le().await
            }
        }
    }

    pub async fn read_u128(&mut self) -> Result<u128,Error>{
        match self.endian {
            Endian::BigEndian => {
                self.read_u128_be().await
            },
            Endian::LittleEndian => {
                self.read_u128_le().await
            }
        }
    }

    pub async fn read_i16(&mut self) -> Result<i16,Error>{
        match self.endian {
            Endian::BigEndian => {
                self.read_i16_be().await
            },
            Endian::LittleEndian => {
                self.read_i16_le().await
            }
        }
    }

    pub async fn read_i32(&mut self) -> Result<i32,Error>{
        match self.endian {
            Endian::BigEndian => {
                self.read_i32_be().await
            },
            Endian::LittleEndian => {
                self.read_i32_le().await
            }
        }
    }

    pub async fn read_i64(&mut self) -> Result<i64,Error>{
        match self.endian {
            Endian::BigEndian => {
                self.read_i64_be().await
            },
            Endian::LittleEndian => {
                self.read_i64_le().await
            }
        }
    }

    pub async fn read_i128(&mut self) -> Result<i128,Error>{
        match self.endian {
            Endian::BigEndian => {
                self.read_i128_be().await
            },
            Endian::LittleEndian => {
                self.read_i128_le().await
            }
        }
    }

    pub async fn read_f32(&mut self) -> Result<f32,Error>{
        match self.endian {
            Endian::BigEndian => {
                self.read_f32_be().await
            },
            Endian::LittleEndian => {
                self.read_f32_le().await
            }
        }
    }

    pub async fn read_f64(&mut self) -> Result<f64,Error>{
        match self.endian {
            Endian::BigEndian => {
                self.read_f64_be().await
            },
            Endian::LittleEndian => {
                self.read_f64_le().await
            }
        }
    }

    
    pub async fn read_u16_be(&mut self) -> Result<u16,Error>{
        let mut array = [0;2];
        self.reader.read_exact(&mut array).await?;
        Ok(u16::from_be_bytes(array))
    }

    pub async fn read_u32_be(&mut self) -> Result<u32,Error>{
        let mut array = [0;4];
        self.reader.read_exact(&mut array).await?;
        Ok(u32::from_be_bytes(array))
    }

    
    pub async fn read_u64_be(&mut self) -> Result<u64,Error>{
        let mut array = [0;8];
        self.reader.read_exact(&mut array).await?;
        Ok(u64::from_be_bytes(array))
    }

    pub async fn read_u128_be(&mut self) -> Result<u128,Error>{
        let mut array = [0;16];
        self.reader.read_exact(&mut array).await?;
        Ok(u128::from_be_bytes(array))
    }

    pub async fn read_i16_be(&mut self) -> Result<i16,Error>{
        let mut array = [0;2];
        self.reader.read_exact(&mut array).await?;
        Ok(i16::from_be_bytes(array))
    }

    pub async fn read_i32_be(&mut self) -> Result<i32,Error>{
        let mut array = [0;4];
        self.reader.read_exact(&mut array).await?;
        Ok(i32::from_be_bytes(array))
    }

    pub async fn read_i64_be(&mut self) -> Result<i64,Error>{
        let mut array = [0;8];
        self.reader.read_exact(&mut array).await?;
        Ok(i64::from_be_bytes(array))
    }

    pub async fn read_i128_be(&mut self) -> Result<i128,Error>{
        let mut array = [0;16];
        self.reader.read_exact(&mut array).await?;
        Ok(i128::from_be_bytes(array))
    }

    pub async fn read_f32_be(&mut self) -> Result<f32,Error>{
        let mut array = [0;4];
        self.reader.read_exact(&mut array).await?;
        Ok(f32::from_be_bytes(array))
    }

    pub async fn read_f64_be(&mut self) -> Result<f64,Error>{
        let mut array = [0;8];
        self.reader.read_exact(&mut array).await?;
        Ok(f64::from_be_bytes(array))
    }
    
    pub async fn read_u16_le(&mut self) -> Result<u16,Error>{
        let mut array = [0;2];
        self.reader.read_exact(&mut array).await?;
        Ok(u16::from_le_bytes(array))
    }

    pub async fn read_u32_le(&mut self) -> Result<u32,Error>{
        let mut array = [0;4];
        self.reader.read_exact(&mut array).await?;
        Ok(u32::from_le_bytes(array))
    }

    
    pub async fn read_u64_le(&mut self) -> Result<u64,Error>{
        let mut array = [0;8];
        self.reader.read_exact(&mut array).await?;
        Ok(u64::from_le_bytes(array))
    }

    pub async fn read_u128_le(&mut self) -> Result<u128,Error>{
        let mut array = [0;16];
        self.reader.read_exact(&mut array).await?;
        Ok(u128::from_le_bytes(array))
    }

    pub async fn read_i16_le(&mut self) -> Result<i16,Error>{
        let mut array = [0;2];
        self.reader.read_exact(&mut array).await?;
        Ok(i16::from_le_bytes(array))
    }

    pub async fn read_i32_le(&mut self) -> Result<i32,Error>{
        let mut array = [0;4];
        self.reader.read_exact(&mut array).await?;
        Ok(i32::from_le_bytes(array))
    }

    pub async fn read_i64_le(&mut self) -> Result<i64,Error>{
        let mut array = [0;8];
        self.reader.read_exact(&mut array).await?;
        Ok(i64::from_le_bytes(array))
    }

    pub async fn read_i128_le(&mut self) -> Result<i128,Error>{
        let mut array = [0;16];
        self.reader.read_exact(&mut array).await?;
        Ok(i128::from_le_bytes(array))
    }

    pub async fn read_f32_le(&mut self) -> Result<f32,Error>{
        let mut array = [0;4];
        self.reader.read_exact(&mut array).await?;
        Ok(f32::from_le_bytes(array))
    }

    pub async fn read_f64_le(&mut self) -> Result<f64,Error>{
        let mut array = [0;8];
        self.reader.read_exact(&mut array).await?;
        Ok(f64::from_le_bytes(array))
    }

    /// read until \0, but skip size byte
    pub async fn read_ascii_string(&mut self,size:usize) -> Result<String,Error>{
        let mut array :Vec<u8> = (0..size).map(|_| 0).collect();
        self.reader.read_exact(&mut array).await?;

        let buf = &array;
        let mut s = Vec::new();
        for i in 0..size {
            if buf[i] == 0 {break;}
            s.push(buf[i]);
        }
        let res = String::from_utf8(s);
        match res {
            Ok(strings) => {
                return Ok(strings);
            },
            _ => {
                let err = "This string can not read";
                return Err(Box::new(std::io::Error::new(ErrorKind::Other,err)));
            }
        }
    }

    pub async fn read_utf8_string(&mut self,size:usize) -> Result<String,Error>{
        let mut array :Vec<u8> = (0..size).map(|_| 0).collect();
        self.reader.read_exact(&mut array).await?;

        let buf = &array;
        let mut s = Vec::new();
        for i in 0..size {
            s.push(buf[i]);
        }
        let res = String::from_utf8(s);
        match res {
            Ok(strings) => {
                return Ok(strings);
            },
            _ => {
                let err = "This string can not read";
                return Err(Box::new(std::io::Error::new(ErrorKind::Other,err)));
            }
        }
    }

    #[cfg(feature="codec")]
    pub async fn read_local_string(&mut self,size:usize,code: CodeType) -> Result<String,Error>{
        let mut array :Vec<u8> = (0..size).map(|_| 0).collect();
        self.reader.read_exact(&mut array)?;

        let buf = &array;
        let mut s = Vec::new();
        for i in 0..size {
            if buf[i] == 0 {break;}
            s.push(buf[i]);
        }
        let res = String::from_utf8(s);
        match res {
            Ok(strings) => {
                return Ok(strings);
            },
            _ => {
                let err = "This string can not read";
                return Err(Box::new(std::io::Error::new(ErrorKind::Other,err)));
            }
        }
    }

    /// skip size byte
    pub async fn skip_ptr(&mut self,size:usize) -> Result<usize,Error>{
        let mut array :Vec<u8> = (0..size).map(|_| 0).collect();
        self.reader.read_exact(&mut array).await?;
        Ok(size)
    }
}

impl<R: AsyncBufReadExt + AsyncSeek + Send + std::marker::Unpin> AsyncBytesReader<R> {
    pub async fn offset(&mut self) -> Result<u64, Error> {
        Ok(self.reader.stream_position().await?)
    }

    pub async fn seek(&mut self, seek: SeekFrom) -> Result<u64, Error> {
        Ok(self.reader.seek(seek).await?)
    }
}



