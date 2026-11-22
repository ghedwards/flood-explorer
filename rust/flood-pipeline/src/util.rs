//! Shared helpers: JSON files, Python-style rounding, dates, distances,
//! CSV, zip archives and HTML entities.

use serde_json::Value;
use std::path::Path;

pub type R<T> = Result<T, String>;

pub const UA: &str = "flood-explorer (github.com/ghedwards/flood-explorer)";

/// Any error as a string.
pub fn err<E: std::fmt::Display>(e: E) -> String {
    e.to_string()
}

/// The first `n` characters (not bytes) of a string.
pub fn clip(s: &str, n: usize) -> String {
    s.chars().take(n).collect()
}

/// The last `n` characters of a string.
pub fn tail(s: &str, n: usize) -> String {
    let c: Vec<char> = s.chars().collect();
    c[c.len().saturating_sub(n)..].iter().collect()
}

/* ------------------------------------------------------------ JSON */

pub fn read_json(path: impl AsRef<Path>) -> R<Value> {
    let p = path.as_ref();
    let t = std::fs::read_to_string(p).map_err(|e| format!("{}: {}", p.display(), e))?;
    serde_json::from_str(&t).map_err(|e| format!("{}: {}", p.display(), e))
}

fn ensure_parent(p: &Path) -> R<()> {
    if let Some(d) = p.parent() {
        if !d.as_os_str().is_empty() {
            std::fs::create_dir_all(d).map_err(err)?;
        }
    }
    Ok(())
}

/// Write JSON with no spaces (Python's separators=(",", ":")).
pub fn write_json(path: impl AsRef<Path>, v: &Value) -> R<()> {
    let p = path.as_ref();
    ensure_parent(p)?;
    std::fs::write(p, serde_json::to_string(v).map_err(err)?).map_err(|e| format!("{}: {}", p.display(), e))
}

/// Write JSON indented by `n` spaces (Python's indent=n).
pub fn write_json_indent(path: impl AsRef<Path>, v: &Value, n: usize) -> R<()> {
    let p = path.as_ref();
    ensure_parent(p)?;
    let ind = " ".repeat(n);
    let mut buf = Vec::new();
    let fmt = serde_json::ser::PrettyFormatter::with_indent(ind.as_bytes());
    let mut ser = serde_json::Serializer::with_formatter(&mut buf, fmt);
    serde::Serialize::serialize(v, &mut ser).map_err(err)?;
    std::fs::write(p, buf).map_err(|e| format!("{}: {}", p.display(), e))
}

/// Build a JSON object from pairs, keeping their order.
#[macro_export]
macro_rules! obj {
    ($($k:expr => $v:expr),* $(,)?) => {{
        #[allow(unused_mut)]
        let mut m = serde_json::Map::new();
        $( m.insert(($k).to_string(), serde_json::Value::from($v)); )*
        serde_json::Value::Object(m)
    }};
}

/// A JSON number from a float, or null if it isn't finite.
pub fn num(v: f64) -> Value {
    serde_json::Number::from_f64(v).map(Value::Number).unwrap_or(Value::Null)
}

/// Python's truthiness for JSON values.
pub fn truthy(v: Option<&Value>) -> bool {
    match v {
        None | Some(Value::Null) => false,
        Some(Value::Bool(b)) => *b,
        Some(Value::Number(n)) => n.as_f64().is_some_and(|x| x != 0.0),
        Some(Value::String(s)) => !s.is_empty(),
        Some(Value::Array(a)) => !a.is_empty(),
        Some(Value::Object(o)) => !o.is_empty(),
    }
}

/// `a or b` for JSON values (Python).
pub fn or_v<'a>(a: Option<&'a Value>, b: Option<&'a Value>) -> Value {
    if truthy(a) {
        a.cloned().unwrap_or(Value::Null)
    } else {
        b.cloned().unwrap_or(Value::Null)
    }
}

/// Python's str() of a JSON scalar (as used to build ids and labels).
pub fn py_str(v: &Value) -> String {
    match v {
        Value::Null => "None".into(),
        Value::Bool(b) => if *b { "True".into() } else { "False".into() },
        Value::String(s) => s.clone(),
        Value::Number(n) => {
            if let Some(i) = n.as_i64() {
                i.to_string()
            } else if let Some(u) = n.as_u64() {
                u.to_string()
            } else {
                py_float(n.as_f64().unwrap_or(f64::NAN))
            }
        }
        other => other.to_string(),
    }
}

/// Python's repr of a float (shortest round-trip, with ".0" for whole numbers).
pub fn py_float(x: f64) -> String {
    if x.is_nan() {
        return "nan".into();
    }
    if x.is_infinite() {
        return if x > 0.0 { "inf".into() } else { "-inf".into() };
    }
    let s = format!("{}", x);
    if s.contains('.') || s.contains('e') {
        s
    } else {
        format!("{}.0", s)
    }
}

/// A string field, or "" (Python's `(p.get(k) or "")`).
pub fn s_or_empty(v: Option<&Value>) -> String {
    match v {
        Some(Value::String(s)) => s.clone(),
        Some(x) if truthy(Some(x)) => py_str(x),
        _ => String::new(),
    }
}

pub fn get_f64(v: &Value, k: &str) -> Option<f64> {
    v.get(k).and_then(|x| x.as_f64())
}

pub fn get_str<'a>(v: &'a Value, k: &str) -> Option<&'a str> {
    v.get(k).and_then(|x| x.as_str())
}

pub fn arr(v: Option<&Value>) -> &[Value] {
    v.and_then(|x| x.as_array()).map(|a| a.as_slice()).unwrap_or(&[])
}


/* ------------------------------------------------------ rounding */

/// Python's round(x, n): correctly rounded to n decimals.
pub fn round_to(x: f64, n: usize) -> f64 {
    if !x.is_finite() {
        return x;
    }
    format!("{:.*}", n, x).parse().unwrap_or(x)
}

/// Python's round(x): to the nearest whole number, ties to even.
pub fn round_even(x: f64) -> f64 {
    x.round_ties_even()
}

/* ----------------------------------------------------------- dates */

/// Days since 1970-01-01 for a civil date (proleptic Gregorian).
pub fn days_from_civil(y: i64, m: i64, d: i64) -> i64 {
    let y = if m <= 2 { y - 1 } else { y };
    let era = if y >= 0 { y } else { y - 399 } / 400;
    let yoe = y - era * 400;
    let mp = (m + 9) % 12;
    let doy = (153 * mp + 2) / 5 + d - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    era * 146097 + doe - 719468
}

/// (year, month, day) for days since 1970-01-01.
pub fn civil_from_days(z: i64) -> (i64, i64, i64) {
    let z = z + 719468;
    let era = if z >= 0 { z } else { z - 146096 } / 146097;
    let doe = z - era * 146097;
    let yoe = (doe - doe / 1460 + doe / 36524 - doe / 146096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    (if m <= 2 { y + 1 } else { y }, m, d)
}

pub fn valid_date(y: i64, m: i64, d: i64) -> bool {
    if !(1..=12).contains(&m) || d < 1 {
        return false;
    }
    let dim = [31, if (y % 4 == 0 && y % 100 != 0) || y % 400 == 0 { 29 } else { 28 }, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
    d <= dim[(m - 1) as usize]
}

/// Seconds since the epoch, now.
pub fn now_s() -> f64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_secs_f64()).unwrap_or(0.0)
}

/// An instant (UTC seconds) written in a fixed offset, Python isoformat style:
/// 2026-10-16T10:11:15+00:00.
pub fn iso(t: f64, offset_h: i64) -> String {
    let s = t.floor() as i64 + offset_h * 3600;
    let (y, m, d) = civil_from_days(s.div_euclid(86400));
    let r = s.rem_euclid(86400);
    let sign = if offset_h < 0 { '-' } else { '+' };
    format!("{:04}-{:02}-{:02}T{:02}:{:02}:{:02}{}{:02}:00", y, m, d, r / 3600, (r / 60) % 60, r % 60, sign, offset_h.abs())
}

/// Now, in UTC, to the second.
pub fn now_iso() -> String {
    iso(now_s(), 0)
}

/// Today's date (UTC) as YYYY-MM-DD.
pub fn today() -> String {
    let (y, m, d) = civil_from_days((now_s() / 86400.0).floor() as i64);
    format!("{:04}-{:02}-{:02}", y, m, d)
}

/// Parse an ISO date or date-time ("2022-02-26", "2022-02-26T10:00:00.000+10:00",
/// "...Z") to UTC seconds; times without an offset are taken at `default_h`.
pub fn parse_iso(s: &str, default_h: i64) -> Option<f64> {
    let s = s.trim();
    let b = s.as_bytes();
    if b.len() < 10 || b[4] != b'-' || b[7] != b'-' {
        return None;
    }
    let num = |a: usize, n: usize| -> Option<i64> { s.get(a..a + n)?.parse().ok() };
    let (y, mo, d) = (num(0, 4)?, num(5, 2)?, num(8, 2)?);
    if !valid_date(y, mo, d) {
        return None;
    }
    let mut secs = 0f64;
    let mut off = default_h * 3600;
    if b.len() > 10 {
        if b[10] != b'T' && b[10] != b' ' {
            return None;
        }
        let rest = &s[11..];
        // the offset: Z, +HH:MM or -HH:MM after the time
        let (time, tz) = match rest.find(['Z', '+', '-']) {
            Some(i) => (&rest[..i], Some(&rest[i..])),
            None => (rest, None),
        };
        let parts: Vec<&str> = time.split(':').collect();
        let h: i64 = parts.first()?.parse().ok()?;
        let mi: i64 = parts.get(1).map_or(Some(0), |x| x.parse().ok())?;
        let sec: f64 = parts.get(2).map_or(Some(0.0), |x| x.parse().ok())?;
        if h > 23 || mi > 59 {
            return None;
        }
        secs = (h * 3600 + mi * 60) as f64 + sec;
        if let Some(tz) = tz {
            off = if tz == "Z" {
                0
            } else {
                let sign = if tz.starts_with('-') { -1 } else { 1 };
                let t = &tz[1..];
                let (hh, mm) = match t.split_once(':') {
                    Some((a, b)) => (a.parse::<i64>().ok()?, b.parse::<i64>().ok()?),
                    None if t.is_ascii() && t.len() == 4 => (t[..2].parse().ok()?, t[2..].parse().ok()?),
                    None => (t.parse().ok()?, 0),
                };
                sign * (hh * 3600 + mm * 60)
            };
        }
    }
    Some(days_from_civil(y, mo, d) as f64 * 86400.0 + secs - off as f64)
}

/// The UTC offset (hours) written in an ISO string, or `default_h`.
pub fn iso_offset_h(s: &str, default_h: i64) -> i64 {
    let Some(rest) = s.get(11..) else {
        return default_h;
    };
    if rest.ends_with('Z') {
        return 0;
    }
    match rest.rfind(['+', '-']) {
        Some(i) => {
            let sign = if rest.as_bytes()[i] == b'-' { -1 } else { 1 };
            rest.get(i + 1..i + 3).and_then(|h| h.parse::<i64>().ok()).map(|h| sign * h).unwrap_or(default_h)
        }
        None => default_h,
    }
}

/* -------------------------------------------------------- distance */

/// Kilometres between two points (equirectangular, as the Python had it).
pub fn km(lat1: f64, lon1: f64, lat2: f64, lon2: f64) -> f64 {
    let dy = (lat1 - lat2) * 110.574;
    let dx = (lon1 - lon2) * 111.32 * ((lat1 + lat2) / 2.0).to_radians().cos();
    dx.hypot(dy)
}

/* ------------------------------------------------------------- CSV */

/// Rows of a CSV text (quoted fields, doubled quotes, CRLF), like Python's
/// csv.reader.
pub fn csv_rows(text: &str) -> Vec<Vec<String>> {
    let mut rows = Vec::new();
    let mut row: Vec<String> = Vec::new();
    let mut field = String::new();
    let mut quoted = false;
    let mut any = false;
    let mut it = text.chars().peekable();
    while let Some(c) = it.next() {
        if quoted {
            if c == '"' {
                if it.peek() == Some(&'"') {
                    field.push('"');
                    it.next();
                } else {
                    quoted = false;
                }
            } else {
                field.push(c);
            }
            continue;
        }
        match c {
            '"' => {
                quoted = true;
                any = true;
            }
            ',' => {
                row.push(std::mem::take(&mut field));
                any = true;
            }
            '\r' => {}
            '\n' => {
                if any || !field.is_empty() {
                    row.push(std::mem::take(&mut field));
                }
                rows.push(std::mem::take(&mut row));
                any = false;
            }
            _ => {
                field.push(c);
                any = true;
            }
        }
    }
    if any || !field.is_empty() {
        row.push(field);
        rows.push(row);
    }
    rows
}

/* ------------------------------------------------------------- zip */

/// The files in a zip archive: (name, contents). Stored and deflated
/// entries; directories are skipped.
pub fn unzip(b: &[u8]) -> R<Vec<(String, Vec<u8>)>> {
    let u16le = |p: usize| -> R<usize> { b.get(p..p + 2).map(|x| u16::from_le_bytes([x[0], x[1]]) as usize).ok_or("zip: truncated".into()) };
    let u32le = |p: usize| -> R<usize> {
        b.get(p..p + 4).map(|x| u32::from_le_bytes([x[0], x[1], x[2], x[3]]) as usize).ok_or("zip: truncated".into())
    };
    // end of central directory: the last "PK\x05\x06"
    let eocd = (0..b.len().saturating_sub(21)).rev().find(|&i| &b[i..i + 4] == b"PK\x05\x06").ok_or("zip: no directory")?;
    let n = u16le(eocd + 10)?;
    let mut p = u32le(eocd + 16)?;
    const MAX_ENTRY_BYTES: usize = 256 << 20;
    const MAX_TOTAL_BYTES: usize = 512 << 20;
    let mut total_bytes = 0usize;
    let mut out = Vec::new();
    for _ in 0..n {
        if b.get(p..p + 4) != Some(b"PK\x01\x02") {
            return Err("zip: bad directory entry".into());
        }
        let method = u16le(p + 10)?;
        let csize = u32le(p + 20)?;
        let usize_ = u32le(p + 24)?;
        let (nl, xl, cl) = (u16le(p + 28)?, u16le(p + 30)?, u16le(p + 32)?);
        let local = u32le(p + 42)?;
        let name_end = p.checked_add(46).and_then(|v| v.checked_add(nl)).ok_or("zip: offset overflow")?;
        let name = String::from_utf8_lossy(b.get(p + 46..name_end).ok_or("zip: truncated name")?).into_owned();
        p = name_end.checked_add(xl).and_then(|v| v.checked_add(cl)).ok_or("zip: offset overflow")?;
        if name.ends_with('/') {
            continue;
        }
        if b.get(local..local + 4) != Some(b"PK\x03\x04") {
            return Err(format!("zip: bad local header for {}", name));
        }
        let start = local
            .checked_add(30)
            .and_then(|v| v.checked_add(u16le(local + 26).ok()?))
            .and_then(|v| v.checked_add(u16le(local + 28).ok()?))
            .ok_or("zip: local offset overflow")?;
        let data_end = start.checked_add(csize).ok_or("zip: data offset overflow")?;
        let data = b.get(start..data_end).ok_or_else(|| format!("zip: {} truncated", name))?;
        let limit = usize_.max(1).saturating_mul(2).saturating_add(1024).min(MAX_ENTRY_BYTES);
        let body = match method {
            0 => {
                if data.len() > MAX_ENTRY_BYTES {
                    return Err(format!("zip: {} exceeds size limit", name));
                }
                data.to_vec()
            }
            8 => miniz_oxide::inflate::decompress_to_vec_with_limit(data, limit).map_err(|e| format!("zip: {}: {:?}", name, e))?,
            m => return Err(format!("zip: {} uses method {}", name, m)),
        };
        total_bytes = total_bytes.saturating_add(body.len());
        if total_bytes > MAX_TOTAL_BYTES {
            return Err("zip: archive exceeds total size limit".into());
        }
        out.push((name, body));
    }
    Ok(out)
}

/// Make a zip archive (stored entries), for tests.
#[cfg(test)]
pub fn zip_stored(files: &[(&str, &[u8])]) -> Vec<u8> {
    fn crc32(d: &[u8]) -> u32 {
        let mut c = 0xffff_ffffu32;
        for &x in d {
            c ^= x as u32;
            for _ in 0..8 {
                c = if c & 1 != 0 { (c >> 1) ^ 0xedb8_8320 } else { c >> 1 };
            }
        }
        !c
    }
    let mut out = Vec::new();
    let mut dir = Vec::new();
    for (name, data) in files {
        let off = out.len() as u32;
        let crc = crc32(data);
        let le16 = |v: u16| v.to_le_bytes();
        let le32 = |v: u32| v.to_le_bytes();
        out.extend_from_slice(b"PK\x03\x04");
        out.extend_from_slice(&le16(20));
        out.extend_from_slice(&le16(0));
        out.extend_from_slice(&le16(0));
        out.extend_from_slice(&le32(0));
        out.extend_from_slice(&le32(crc));
        out.extend_from_slice(&le32(data.len() as u32));
        out.extend_from_slice(&le32(data.len() as u32));
        out.extend_from_slice(&le16(name.len() as u16));
        out.extend_from_slice(&le16(0));
        out.extend_from_slice(name.as_bytes());
        out.extend_from_slice(data);
        dir.extend_from_slice(b"PK\x01\x02");
        dir.extend_from_slice(&le16(20));
        dir.extend_from_slice(&le16(20));
        dir.extend_from_slice(&le16(0));
        dir.extend_from_slice(&le16(0));
        dir.extend_from_slice(&le32(0));
        dir.extend_from_slice(&le32(crc));
        dir.extend_from_slice(&le32(data.len() as u32));
        dir.extend_from_slice(&le32(data.len() as u32));
        dir.extend_from_slice(&le16(name.len() as u16));
        dir.extend_from_slice(&[0; 12]);
        dir.extend_from_slice(&le32(off));
        dir.extend_from_slice(name.as_bytes());
    }
    let start = out.len() as u32;
    out.extend_from_slice(&dir);
    out.extend_from_slice(b"PK\x05\x06\0\0\0\0");
    out.extend_from_slice(&(files.len() as u16).to_le_bytes());
    out.extend_from_slice(&(files.len() as u16).to_le_bytes());
    out.extend_from_slice(&(dir.len() as u32).to_le_bytes());
    out.extend_from_slice(&start.to_le_bytes());
    out.extend_from_slice(&[0, 0]);
    out
}

/* ----------------------------------------------------- HTML text */

/// Decode HTML entities (named ones in common use, and numeric).
pub fn html_unescape(s: &str) -> String {
    if !s.contains('&') {
        return s.to_string();
    }
    let mut out = String::with_capacity(s.len());
    let mut rest = s;
    while let Some(i) = rest.find('&') {
        out.push_str(&rest[..i]);
        rest = &rest[i..];
        let end = rest[1..].find(|c: char| c == ';' || c == '&' || c.is_whitespace()).map(|j| j + 1);
        let (ent, semi) = match end {
            Some(j) if rest.as_bytes()[j] == b';' => (&rest[1..j], j + 1),
            _ => ("", 0),
        };
        let ch = if let Some(n) = ent.strip_prefix('#') {
            let v = if let Some(h) = n.strip_prefix('x').or_else(|| n.strip_prefix('X')) { u32::from_str_radix(h, 16).ok() } else { n.parse().ok() };
            v.and_then(char::from_u32).map(|c| c.to_string())
        } else {
            match ent {
                "amp" => Some("&".into()),
                "lt" => Some("<".into()),
                "gt" => Some(">".into()),
                "quot" => Some("\"".into()),
                "apos" => Some("'".into()),
                "nbsp" => Some("\u{a0}".into()),
                "ndash" => Some("–".into()),
                "mdash" => Some("—".into()),
                "deg" => Some("°".into()),
                _ => None,
            }
        };
        match ch {
            Some(c) if semi > 0 => {
                out.push_str(&c);
                rest = &rest[semi..];
            }
            _ => {
                out.push('&');
                rest = &rest[1..];
            }
        }
    }
    out.push_str(rest);
    out
}

/// Collapse runs of whitespace to single spaces and trim (" ".join(s.split())).
pub fn squash(s: &str) -> String {
    s.split_whitespace().collect::<Vec<_>>().join(" ")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn dates_round_trip() {
        assert_eq!(days_from_civil(1970, 1, 1), 0);
        assert_eq!(civil_from_days(days_from_civil(2024, 2, 29)), (2024, 2, 29));
        assert_eq!(iso(0.0, 0), "1970-01-01T00:00:00+00:00");
        let t = parse_iso("2022-02-26", 10).unwrap();
        assert_eq!(iso(t, 10), "2022-02-26T00:00:00+10:00");
        assert_eq!(parse_iso("2022-02-26T10:00:00.000+10:00", 0), Some(t + 36000.0));
        assert_eq!(parse_iso("2022-02-26T00:00:00Z", 10), Some(t + 36000.0));
        assert_eq!(parse_iso("2022-02-30", 0), None);
    }

    #[test]
    fn python_rounding_and_strings() {
        assert_eq!(round_to(150.0300000001, 5), 150.03);
        assert_eq!(round_to(2.675, 2), 2.67); // the binary value is just below
        assert_eq!(round_even(2.5), 2.0);
        assert_eq!(round_even(3.5), 4.0);
        assert_eq!(py_float(1.0), "1.0");
        assert_eq!(py_str(&serde_json::json!(540198)), "540198");
    }

    #[test]
    fn csv_and_zip() {
        let r = csv_rows("a,b\r\n\"x,1\",\"say \"\"hi\"\"\"\n,\n");
        assert_eq!(r, vec![vec!["a", "b"], vec!["x,1", "say \"hi\""], vec!["", ""]]);
        let z = zip_stored(&[("d/a.csv", b"1,2"), ("b.txt", b"hello")]);
        let f = unzip(&z).unwrap();
        assert_eq!(f[1], ("b.txt".to_string(), b"hello".to_vec()));
    }

    #[test]
    fn entities() {
        assert_eq!(html_unescape("Severe &amp; more &#8211; x &bogus; &"), "Severe & more – x &bogus; &");
        assert_eq!(squash("  a \n b  "), "a b");
    }
}
