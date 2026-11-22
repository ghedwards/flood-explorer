//! bin-rs::io::* is buffer read binary law level wrapper utility
//! When It analyzes a complex binary,it's data is moving back and forth.
//! Therefor it needs direct access functions.
//!
//! use feature="util"
//!
//! 0.0.9 utf16 string read/write

use crate::Endian;

#[allow(unused)]
#[inline]
pub fn read_f32(buf: &[u8], ptr: usize, endian: Endian) -> f32 {
  f32::from_bits(read_u32(buf, ptr, endian))
}
#[allow(unused)]
#[inline]
pub fn read_f64(buf: &[u8], ptr: usize, endian: Endian) -> f64 {
  f64::from_bits(read_u64(buf, ptr, endian))
}

#[allow(unused)]
#[inline]
pub fn read_byte(buf: &[u8], ptr: usize) -> u8 {
  buf[ptr]
}

#[allow(unused)]
#[inline]
pub fn read_i8(buf: &[u8], ptr: usize) -> i8 {
  ((&buf[ptr]) as *const u8) as i8
}

#[allow(unused)]
#[inline]
pub fn read_u16_be(buf: &[u8], ptr: usize) -> u16 {
  (buf[ptr] as u16) << 8 | (buf[ptr + 1] as u16)
}

#[allow(unused)]
#[inline]
pub fn read_i16_be(buf: &[u8], ptr: usize) -> i16 {
  (((buf[ptr] as u16) << 8 | (buf[ptr + 1] as u16)) as u16) as i16
}

#[allow(unused)]
#[inline]
pub fn read_u32_be(buf: &[u8], ptr: usize) -> u32 {
  (buf[ptr] as u32) << 24
    | (buf[ptr + 1] as u32) << 16
    | (buf[ptr + 2] as u32) << 8
    | (buf[ptr + 3] as u32)
}

#[allow(unused)]
#[inline]
pub fn read_i32_be(buf: &[u8], ptr: usize) -> i32 {
  (((buf[ptr] as u32) << 24
    | (buf[ptr + 1] as u32) << 16
    | (buf[ptr + 2] as u32) << 8
    | (buf[ptr + 3] as u32)) as u32) as i32
}

#[allow(unused)]
#[inline]
pub fn read_u64_be(buf: &[u8], ptr: usize) -> u64 {
  (buf[ptr] as u64) << 56
    | (buf[ptr + 1] as u64) << 48
    | (buf[ptr + 2] as u64) << 40
    | (buf[ptr + 3] as u64) << 32
    | (buf[ptr + 4] as u64) << 24
    | (buf[ptr + 5] as u64) << 16
    | (buf[ptr + 6] as u64) << 8
    | (buf[ptr + 7] as u64)
}

#[allow(unused)]
#[inline]
pub fn read_i64_be(buf: &[u8], ptr: usize) -> i64 {
  (((buf[ptr] as u64) << 56
    | (buf[ptr + 1] as u64) << 48
    | (buf[ptr + 2] as u64) << 40
    | (buf[ptr + 3] as u64) << 32
    | (buf[ptr + 4] as u64) << 24
    | (buf[ptr + 5] as u64) << 16
    | (buf[ptr + 6] as u64) << 8
    | (buf[ptr + 7] as u64)) as u64) as i64
}

#[allow(unused)]
#[inline]
pub fn read_i16_le(buf: &[u8], ptr: usize) -> i16 {
  unsafe { ((buf[ptr] as u16) << 8 | (buf[ptr + 1] as u16)) as i16 }
}

#[allow(unused)]
#[inline]
pub fn read_u16_le(buf: &[u8], ptr: usize) -> u16 {
  (buf[ptr + 1] as u16) << 8 | buf[ptr] as u16
}

#[allow(unused)]
#[inline]
pub fn read_u32_le(buf: &[u8], ptr: usize) -> u32 {
  (buf[ptr + 3] as u32) << 24
    | (buf[ptr + 2] as u32) << 16
    | (buf[ptr + 1] as u32) << 8
    | (buf[ptr]) as u32
}

#[allow(unused)]
#[inline]
pub fn read_i32_le(buf: &[u8], ptr: usize) -> i32 {
  ((buf[ptr + 3] as u32) << 24
    | (buf[ptr + 2] as u32) << 16
    | (buf[ptr + 1] as u32) << 8
    | (buf[ptr]) as u32) as i32
}

#[allow(unused)]
#[inline]
pub fn read_u64_le(buf: &[u8], ptr: usize) -> u64 {
  (buf[ptr + 7] as u64) << 56
    | (buf[ptr + 6] as u64) << 48
    | (buf[ptr + 5] as u64) << 40
    | (buf[ptr + 4] as u64) << 32
    | (buf[ptr + 3] as u64) << 24
    | (buf[ptr + 2] as u64) << 16
    | (buf[ptr + 1] as u64) << 8
    | buf[ptr] as u64
}

#[allow(unused)]
#[inline]
pub fn read_i64_le(buf: &[u8], ptr: usize) -> i64 {
  (((buf[ptr + 7] as u64) << 56
    | (buf[ptr + 6] as u64) << 48
    | (buf[ptr + 5] as u64) << 40
    | (buf[ptr + 4] as u64) << 32
    | (buf[ptr + 3] as u64) << 24
    | (buf[ptr + 2] as u64) << 16
    | (buf[ptr + 1] as u64) << 8
    | buf[ptr] as u64) as u64) as i64
}

#[allow(unused)]
#[inline]
pub fn read_u16(buf: &[u8], ptr: usize, endian: Endian) -> u16 {
  if endian == Endian::LittleEndian {
    read_u16_le(buf, ptr)
  } else {
    read_u16_be(buf, ptr)
  }
}

#[allow(unused)]
#[inline]
pub fn read_u32(buf: &[u8], ptr: usize, endian: Endian) -> u32 {
  if endian == Endian::LittleEndian {
    read_u32_le(buf, ptr)
  } else {
    read_u32_be(buf, ptr)
  }
}

#[allow(unused)]
#[inline]
pub fn read_u64(buf: &[u8], ptr: usize, endian: Endian) -> u64 {
  if endian == Endian::LittleEndian {
    read_u64_le(buf, ptr)
  } else {
    read_u64_be(buf, ptr)
  }
}

#[allow(unused)]
#[inline]
pub fn read_i16(buf: &[u8], ptr: usize, endian: Endian) -> i16 {
  if endian == Endian::LittleEndian {
    read_i16_le(buf, ptr)
  } else {
    read_i16_be(buf, ptr)
  }
}

#[allow(unused)]
#[inline]
pub fn read_i32(buf: &[u8], ptr: usize, endian: Endian) -> i32 {
  if endian == Endian::LittleEndian {
    read_i32_le(buf, ptr)
  } else {
    read_i32_be(buf, ptr)
  }
}

#[allow(unused)]
#[inline]
pub fn read_i64(buf: &[u8], ptr: usize, endian: Endian) -> i64 {
  if endian == Endian::LittleEndian {
    read_i64_le(buf, ptr)
  } else {
    read_i64_be(buf, ptr)
  }
}

#[allow(unused)]
#[inline]
pub fn read_u128(buf: &[u8], ptr: usize, endian: Endian) -> u128 {
  if endian == Endian::LittleEndian {
    read_u128_le(buf, ptr)
  } else {
    read_u128_be(buf, ptr)
  }
}

#[allow(unused)]
#[inline]
pub fn read_u128_be(buf: &[u8], ptr: usize) -> u128 {
  let b0 = read_u64_be(buf, ptr);
  let b1 = read_u64_be(buf, ptr);
  ((b0 as u128) << 64) | b1 as u128
}

#[allow(unused)]
#[inline]
pub fn read_u128_le(buf: &[u8], ptr: usize) -> u128 {
  let b0 = read_u64_le(buf, ptr);
  let b1 = read_u64_le(buf, ptr);
  ((b1 as u128) << 64) | b0 as u128
}

#[allow(unused)]
#[inline]
pub fn read_i128(buf: &[u8], ptr: usize, endian: Endian) -> i128 {
  if endian == Endian::LittleEndian {
    read_i128_le(buf, ptr)
  } else {
    read_i128_be(buf, ptr)
  }
}

#[allow(unused)]
#[inline]
pub fn read_i128_be(buf: &[u8], ptr: usize) -> i128 {
  let b0 = read_u64_be(buf, ptr);
  let b1 = read_u64_be(buf, ptr);
  (((b0 as u128) << 64) | b1 as u128) as i128
}

#[allow(unused)]
#[inline]
pub fn read_i128_le(buf: &[u8], ptr: usize) -> i128 {
  let b0 = read_u64_le(buf, ptr);
  let b1 = read_u64_le(buf, ptr);
  (((b1 as u128) << 64) | b0 as u128) as i128
}

pub fn read_ascii_string(buf: &[u8], _ptr: usize, _num: usize) -> String {
  let mut u16s = Vec::new();
  for b in buf {
    u16s.push(*b as u16);
  }
  return String::from_utf16_lossy(&u16s);
}

#[allow(unused)]
#[inline]
pub fn read_string(buf: &[u8], ptr: usize, num: usize) -> String {
  let mut s = Vec::new();
  for i in 0..num {
    if buf[ptr + i] == 0 {
      break;
    }
    s.push(buf[ptr + i]);
  }
  let res = String::from_utf8(s);
  match res {
    Ok(strings) => {
      return strings;
    }
    _ => {
      return "".to_string();
    }
  }
}

#[allow(unused)]
pub fn read_utf16_string(buf: &[u8], ptr: usize, num: usize, endian: Endian) -> String {
  let mut s = Vec::new();
  let len = buf.len() / 2;
  for i in 0..len {
    if buf[ptr + i * 2] == 0 && buf[ptr + i * 2 + 1] == 0 {
      break;
    }
    let u16 = read_u16(buf, ptr + i * 2, endian);
    s.push(u16);
  }
  String::from_utf16_lossy(&s)
}

#[allow(unused)]
#[inline]
pub fn read_bytes_as_vec(buf: &[u8], ptr: usize, length: usize) -> Vec<u8> {
  let mut c = Vec::new();
  for i in 0..length {
    c.push(buf[ptr + i]);
  }
  c
}

#[allow(unused)]
#[inline]
pub fn read_bytes_as_u16_vec(buf: &[u8], ptr: usize, length: usize) -> Vec<u16> {
  let mut c = Vec::new();

  for i in 0..length / 2 {
    c.push(buf[ptr + i * 2] as u16);
    c.push(buf[ptr + i * 2 + 1] as u16);
  }
  c
}

#[allow(unused)]
#[inline]
pub fn write_byte(num: u8, buf: &mut Vec<u8>) {
  buf.push(num);
}

#[allow(unused)]
#[inline]
pub fn write_i8(num: i8, buf: &mut Vec<u8>) {
  buf.push(num as u8);
}

#[allow(unused)]
#[inline]
pub fn write_u16_be(num: u16, buf: &mut Vec<u8>) {
  let bytes = num.to_be_bytes();
  for b in bytes.into_iter() {
    buf.push(b);
  }
}

#[allow(unused)]
#[inline]
pub fn write_i16_be(num: i16, buf: &mut Vec<u8>) {
  let bytes = num.to_be_bytes();
  for b in bytes.into_iter() {
    buf.push(b);
  }
}

#[allow(unused)]
#[inline]
pub fn write_u32_be(num: u32, buf: &mut Vec<u8>) {
  let bytes = num.to_be_bytes();
  for b in bytes.into_iter() {
    buf.push(b);
  }
}

#[allow(unused)]
#[inline]
pub fn write_i32_be(num: i32, buf: &mut Vec<u8>) {
  let bytes = num.to_be_bytes();
  for b in bytes.into_iter() {
    buf.push(b);
  }
}

#[allow(unused)]
#[inline]
pub fn write_u64_be(num: u64, buf: &mut Vec<u8>) {
  let bytes = num.to_be_bytes();
  for b in bytes.into_iter() {
    buf.push(b);
  }
}

#[allow(unused)]
#[inline]
pub fn write_i64_be(num: i64, buf: &mut Vec<u8>) {
  let bytes = num.to_be_bytes();
  for b in bytes.into_iter() {
    buf.push(b);
  }
}

#[allow(unused)]
#[inline]
pub fn write_i16_le(num: i16, buf: &mut Vec<u8>) {
  let bytes = num.to_le_bytes();
  for b in bytes.into_iter() {
    buf.push(b);
  }
}

#[allow(unused)]
#[inline]
pub fn write_u16_le(num: u16, buf: &mut Vec<u8>) {
  let bytes = num.to_le_bytes();
  for b in bytes.into_iter() {
    buf.push(b);
  }
}

#[allow(unused)]
#[inline]
pub fn write_u32_le(num: u32, buf: &mut Vec<u8>) {
  let bytes = num.to_le_bytes();
  for b in bytes.into_iter() {
    buf.push(b);
  }
}

#[allow(unused)]
#[inline]
pub fn write_i32_le(num: i32, buf: &mut Vec<u8>) {
  let bytes = num.to_le_bytes();
  for b in bytes.into_iter() {
    buf.push(b);
  }
}

#[allow(unused)]
#[inline]
pub fn write_u64_le(num: u64, buf: &mut Vec<u8>) {
  let bytes = num.to_le_bytes();
  for b in bytes.into_iter() {
    buf.push(b);
  }
}

#[allow(unused)]
#[inline]
pub fn write_i64_le(num: i64, buf: &mut Vec<u8>) {
  let bytes = num.to_le_bytes();
  for b in bytes.into_iter() {
    buf.push(b);
  }
}

#[allow(unused)]
#[inline]
pub fn write_u16(num: u16, buf: &mut Vec<u8>, endian: Endian) {
  if endian == Endian::BigEndian {
    write_u16_be(num, buf)
  } else {
    write_u16_le(num, buf)
  }
}

#[allow(unused)]
#[inline]
pub fn write_u32(num: u32, buf: &mut Vec<u8>, endian: Endian) {
  if endian == Endian::BigEndian {
    write_u32_be(num, buf)
  } else {
    write_u32_le(num, buf)
  }
}

#[allow(unused)]
#[inline]
pub fn write_u64(num: u64, buf: &mut Vec<u8>, endian: Endian) {
  if endian == Endian::BigEndian {
    write_u64_be(num, buf)
  } else {
    write_u64_le(num, buf)
  }
}

#[allow(unused)]
#[inline]
pub fn write_i16(num: i16, buf: &mut Vec<u8>, endian: Endian) {
  if endian == Endian::BigEndian {
    write_i16_be(num, buf)
  } else {
    write_i16_le(num, buf)
  }
}

#[allow(unused)]
#[inline]
pub fn write_i32(num: i32, buf: &mut Vec<u8>, endian: Endian) {
  if endian == Endian::BigEndian {
    write_i32_be(num, buf)
  } else {
    write_i32_le(num, buf)
  }
}

#[allow(unused)]
#[inline]
pub fn write_i64(num: i64, buf: &mut Vec<u8>, endian: Endian) {
  if endian == Endian::BigEndian {
    write_i64_be(num, buf)
  } else {
    write_i64_le(num, buf)
  }
}

#[allow(unused)]
#[inline]
pub fn write_u128(num: u128, buf: &mut Vec<u8>, endian: Endian) {
  if endian == Endian::BigEndian {
    write_u128_be(num, buf)
  } else {
    write_u128_le(num, buf)
  }
}

#[allow(unused)]
#[inline]
pub fn write_u128_be(num: u128, buf: &mut Vec<u8>) {
  let bytes = num.to_be_bytes();
  for b in bytes.into_iter() {
    buf.push(b);
  }
}

#[allow(unused)]
#[inline]
pub fn write_u128_le(num: u128, buf: &mut Vec<u8>) {
  let bytes = num.to_le_bytes();
  for b in bytes.into_iter() {
    buf.push(b);
  }
}

#[allow(unused)]
#[inline]
pub fn write_i128(num: i128, buf: &mut Vec<u8>, endian: Endian) {
  if endian == Endian::BigEndian {
    write_i128_be(num, buf)
  } else {
    write_i128_le(num, buf)
  }
}

#[allow(unused)]
#[inline]
pub fn write_i128_be(num: i128, buf: &mut Vec<u8>) {
  let bytes = num.to_be_bytes();
  for b in bytes.into_iter() {
    buf.push(b);
  }
}

#[allow(unused)]
#[inline]
pub fn write_i128_le(num: i128, buf: &mut Vec<u8>) {
  let bytes = num.to_le_bytes();
  for b in bytes.into_iter() {
    buf.push(b);
  }
}

pub fn write_ascii_string(srting: String, buf: &mut Vec<u8>) {
  let bytes = srting.as_bytes();
  for b in bytes.into_iter() {
    buf.push(*b);
  }
  buf.push(0)
}

#[allow(unused)]
#[inline]
pub fn write_string(srting: String, buf: &mut Vec<u8>) {
  let bytes = srting.as_bytes();
  for b in bytes.into_iter() {
    buf.push(*b);
  }
}

#[allow(unused)]
#[inline]
pub fn write_bytes(bytes: &[u8], buf: &mut Vec<u8>) {
  for b in bytes.into_iter() {
    buf.push(*b);
  }
}

#[allow(unused)]
#[inline]
pub fn write_f32(num: f32, buf: &mut Vec<u8>, endian: Endian) {
  if endian == Endian::BigEndian {
    write_f32_be(num, buf)
  } else {
    write_f32_le(num, buf)
  }
}

#[allow(unused)]
#[inline]
pub fn write_f32_be(num: f32, buf: &mut Vec<u8>) {
  let bytes = num.to_be_bytes();
  for b in bytes.into_iter() {
    buf.push(b);
  }
}

#[allow(unused)]
#[inline]
pub fn write_f32_le(num: f32, buf: &mut Vec<u8>) {
  let bytes = num.to_le_bytes();
  for b in bytes.into_iter() {
    buf.push(b);
  }
}

#[allow(unused)]
#[inline]
pub fn write_f64(num: f64, buf: &mut Vec<u8>, endian: Endian) {
  if endian == Endian::BigEndian {
    write_f64_be(num, buf)
  } else {
    write_f64_le(num, buf)
  }
}

#[allow(unused)]
#[inline]
pub fn write_f64_be(num: f64, buf: &mut Vec<u8>) {
  let bytes = num.to_be_bytes();
  for b in bytes.into_iter() {
    buf.push(b);
  }
}

#[allow(unused)]
#[inline]
pub fn write_f64_le(num: f64, buf: &mut Vec<u8>) {
  let bytes = num.to_le_bytes();
  for b in bytes.into_iter() {
    buf.push(b);
  }
}
