//! Geospatial pieces the Python pipeline took from rasterio, pyproj,
//! pyshp and Pillow: map projections (transverse Mercator by the Krüger
//! series, Lambert conformal conic, Web Mercator) from EPSG codes or WKT,
//! GeoTIFF reading and writing, shapefile lines, polygon rasterising and
//! PNG images with a palette.
//!
//! Datums: GDA94, GDA2020 and WGS84 are treated as the same (they differ
//! by under two metres), as is enough for screening maps.

use crate::util::*;
use regex::Regex;
use std::f64::consts::PI;

pub const GRS80: (f64, f64) = (6378137.0, 1.0 / 298.257222101);
pub const WGS84: (f64, f64) = (6378137.0, 1.0 / 298.257223563);
pub const R_MERC: f64 = 6378137.0;

/* ----------------------------------------------------- projections */

#[derive(Clone, Debug, PartialEq)]
pub enum Proj {
    /// longitude, latitude in degrees
    Geographic,
    /// transverse Mercator: lon0, lat0 (degrees), k0, false easting, false northing, (a, f)
    Tm { lon0: f64, lat0: f64, k0: f64, fe: f64, fnn: f64, ell: (f64, f64) },
    /// Lambert conformal conic (two standard parallels)
    Lcc { lon0: f64, lat0: f64, lat1: f64, lat2: f64, fe: f64, fnn: f64, ell: (f64, f64) },
    /// spherical Web Mercator (EPSG:3857)
    WebMercator,
}

impl Proj {
    /// Projections for the EPSG codes Australian data comes in.
    pub fn from_epsg(code: u32) -> Option<Proj> {
        let utm = |zone: u32, ell| Proj::Tm { lon0: zone as f64 * 6.0 - 183.0, lat0: 0.0, k0: 0.9996, fe: 500000.0, fnn: 10000000.0, ell };
        Some(match code {
            4326 | 4283 | 7844 | 4167 | 4202 | 4203 => Proj::Geographic,
            3857 | 900913 | 102100 => Proj::WebMercator,
            7846..=7859 => utm(code - 7800, GRS80),   // GDA2020 / MGA
            28346..=28359 => utm(code - 28300, GRS80), // GDA94 / MGA
            32746..=32760 => utm(code - 32700, WGS84), // WGS84 / UTM south
            3308 => Proj::Lcc { lon0: 147.0, lat0: -33.25, lat1: -30.75, lat2: -35.75, fe: 9300000.0, fnn: 4500000.0, ell: GRS80 }, // NSW Lambert
            8058 => Proj::Lcc { lon0: 147.0, lat0: -33.25, lat1: -30.75, lat2: -35.75, fe: 9300000.0, fnn: 4500000.0, ell: GRS80 },
            3111 | 7899 => Proj::Lcc { lon0: 145.0, lat0: -37.0, lat1: -36.0, lat2: -38.0, fe: 2500000.0, fnn: 2500000.0, ell: GRS80 }, // Vicgrid
            3112 | 7845 => Proj::Lcc { lon0: 134.0, lat0: 0.0, lat1: -18.0, lat2: -36.0, fe: 0.0, fnn: 0.0, ell: GRS80 }, // Geoscience Australia Lambert
            _ => return None,
        })
    }

    /// "EPSG:7856" and the like.
    pub fn from_name(s: &str) -> Option<Proj> {
        let s = s.trim().to_uppercase();
        let code = s.strip_prefix("EPSG:")?.parse().ok()?;
        Proj::from_epsg(code)
    }

    /// A projection from WKT (a shapefile's .prj, ESRI or OGC style).
    pub fn from_wkt(wkt: &str) -> Option<Proj> {
        let low = wkt.to_lowercase();
        if let Some(c) = Regex::new(r#"(?i)authority\["epsg",\s*"?(\d+)"?\]\s*\]\s*$"#).unwrap().captures(wkt.trim()) {
            if let Some(p) = Proj::from_epsg(c[1].parse().ok()?) {
                return Some(p);
            }
        }
        if !low.starts_with("projcs") && !low.starts_with("projcrs") {
            return Some(Proj::Geographic);
        }
        let param = |names: &[&str]| -> Option<f64> {
            for n in names {
                let re = Regex::new(&format!(r#"(?i)parameter\["{}",\s*([-+0-9.eE]+)"#, regex::escape(n))).unwrap();
                if let Some(c) = re.captures(wkt) {
                    return c[1].parse().ok();
                }
            }
            None
        };
        let ell = Regex::new(r#"(?i)(?:spheroid|ellipsoid)\["[^"]*",\s*([0-9.eE+]+),\s*([0-9.eE+]+)"#)
            .unwrap()
            .captures(wkt)
            .and_then(|c| Some((c[1].parse::<f64>().ok()?, c[2].parse::<f64>().ok()?)))
            .map(|(a, inv)| (a, if inv > 0.0 { 1.0 / inv } else { 0.0 }))
            .unwrap_or(GRS80);
        let fe = param(&["false_easting"]).unwrap_or(0.0);
        let fnn = param(&["false_northing"]).unwrap_or(0.0);
        let lon0 = param(&["central_meridian", "longitude_of_center", "longitude_of_origin"]).unwrap_or(0.0);
        let lat0 = param(&["latitude_of_origin", "latitude_of_center"]).unwrap_or(0.0);
        if low.contains("transverse_mercator") || low.contains("transverse mercator") {
            let k0 = param(&["scale_factor"]).unwrap_or(1.0);
            return Some(Proj::Tm { lon0, lat0, k0, fe, fnn, ell });
        }
        if low.contains("lambert_conformal_conic") || low.contains("lambert conformal conic") {
            let lat1 = param(&["standard_parallel_1"]).unwrap_or(lat0);
            let lat2 = param(&["standard_parallel_2"]).unwrap_or(lat1);
            return Some(Proj::Lcc { lon0, lat0, lat1, lat2, fe, fnn, ell });
        }
        if low.contains("mercator_auxiliary_sphere") || low.contains("pseudo-mercator") || low.contains("popular visualisation") {
            return Some(Proj::WebMercator);
        }
        None
    }

    /// Projected coordinates to (lon, lat) degrees.
    pub fn to_lonlat(&self, x: f64, y: f64) -> (f64, f64) {
        match *self {
            Proj::Geographic => (x, y),
            Proj::WebMercator => ((x / R_MERC).to_degrees(), (2.0 * (y / R_MERC).exp().atan() - PI / 2.0).to_degrees()),
            Proj::Tm { lon0, lat0, k0, fe, fnn, ell } => {
                let k = Kruger::new(ell);
                let y0 = if lat0 != 0.0 { k.forward(lat0.to_radians(), 0.0).1 } else { 0.0 };
                let (lat, dl) = k.inverse((x - fe) / k0, (y - fnn) / k0 + y0);
                (lon0 + dl.to_degrees(), lat.to_degrees())
            }
            Proj::Lcc { lon0, lat0, lat1, lat2, fe, fnn, ell } => {
                let l = Lcc::new(lat0, lat1, lat2, ell);
                let (lat, dl) = l.inverse(x - fe, y - fnn);
                (lon0 + dl.to_degrees(), lat.to_degrees())
            }
        }
    }

    /// (lon, lat) degrees to projected coordinates.
    pub fn project_lonlat(&self, lon: f64, lat: f64) -> (f64, f64) {
        match *self {
            Proj::Geographic => (lon, lat),
            Proj::WebMercator => (R_MERC * lon.to_radians(), R_MERC * (PI / 4.0 + lat.to_radians() / 2.0).tan().ln()),
            Proj::Tm { lon0, lat0, k0, fe, fnn, ell } => {
                let k = Kruger::new(ell);
                let y0 = if lat0 != 0.0 { k.forward(lat0.to_radians(), 0.0).1 } else { 0.0 };
                let (x, y) = k.forward(lat.to_radians(), (lon - lon0).to_radians());
                (fe + k0 * x, fnn + k0 * (y - y0))
            }
            Proj::Lcc { lon0, lat0, lat1, lat2, fe, fnn, ell } => {
                let l = Lcc::new(lat0, lat1, lat2, ell);
                let (x, y) = l.forward(lat.to_radians(), (lon - lon0).to_radians());
                (fe + x, fnn + y)
            }
        }
    }
}

/// Transverse Mercator on the ellipsoid by Krüger's series to sixth order
/// (Karney 2011): accurate to well under a millimetre within a zone.
struct Kruger {
    e: f64,
    a_: f64,
    alpha: [f64; 6],
    beta: [f64; 6],
}

impl Kruger {
    fn new((a, f): (f64, f64)) -> Kruger {
        let n = f / (2.0 - f);
        let (n2, n3, n4, n5, n6) = (n * n, n.powi(3), n.powi(4), n.powi(5), n.powi(6));
        Kruger {
            e: (f * (2.0 - f)).sqrt(),
            a_: a / (1.0 + n) * (1.0 + n2 / 4.0 + n4 / 64.0 + n6 / 256.0),
            alpha: [
                n / 2.0 - 2.0 * n2 / 3.0 + 5.0 * n3 / 16.0 + 41.0 * n4 / 180.0 - 127.0 * n5 / 288.0 + 7891.0 * n6 / 37800.0,
                13.0 * n2 / 48.0 - 3.0 * n3 / 5.0 + 557.0 * n4 / 1440.0 + 281.0 * n5 / 630.0 - 1983433.0 * n6 / 1935360.0,
                61.0 * n3 / 240.0 - 103.0 * n4 / 140.0 + 15061.0 * n5 / 26880.0 + 167603.0 * n6 / 181440.0,
                49561.0 * n4 / 161280.0 - 179.0 * n5 / 168.0 + 6601661.0 * n6 / 7257600.0,
                34729.0 * n5 / 80640.0 - 3418889.0 * n6 / 1995840.0,
                212378941.0 * n6 / 319334400.0,
            ],
            beta: [
                n / 2.0 - 2.0 * n2 / 3.0 + 37.0 * n3 / 96.0 - n4 / 360.0 - 81.0 * n5 / 512.0 + 96199.0 * n6 / 604800.0,
                n2 / 48.0 + n3 / 15.0 - 437.0 * n4 / 1440.0 + 46.0 * n5 / 105.0 - 1118711.0 * n6 / 3870720.0,
                17.0 * n3 / 480.0 - 37.0 * n4 / 840.0 - 209.0 * n5 / 4480.0 + 5569.0 * n6 / 90720.0,
                4397.0 * n4 / 161280.0 - 11.0 * n5 / 504.0 - 830251.0 * n6 / 7257600.0,
                4583.0 * n5 / 161280.0 - 108847.0 * n6 / 3991680.0,
                20648693.0 * n6 / 638668800.0,
            ],
        }
    }

    /// (lat, lon from the central meridian) radians -> (x, y) metres, scale 1
    fn forward(&self, lat: f64, dl: f64) -> (f64, f64) {
        let s = lat.sin();
        let t = (s.atanh() - self.e * (self.e * s).atanh()).sinh();
        let xi1 = t.atan2(dl.cos());
        let eta1 = (dl.sin() / (1.0 + t * t).sqrt()).atanh();
        let (mut xi, mut eta) = (xi1, eta1);
        for (j, a) in self.alpha.iter().enumerate() {
            let k = 2.0 * (j + 1) as f64;
            xi += a * (k * xi1).sin() * (k * eta1).cosh();
            eta += a * (k * xi1).cos() * (k * eta1).sinh();
        }
        (self.a_ * eta, self.a_ * xi)
    }

    /// (x, y) metres at scale 1 -> (lat, lon from the central meridian) radians
    fn inverse(&self, x: f64, y: f64) -> (f64, f64) {
        let (xi, eta) = (y / self.a_, x / self.a_);
        let (mut xi1, mut eta1) = (xi, eta);
        for (j, b) in self.beta.iter().enumerate() {
            let k = 2.0 * (j + 1) as f64;
            xi1 -= b * (k * xi).sin() * (k * eta).cosh();
            eta1 -= b * (k * xi).cos() * (k * eta).sinh();
        }
        let tau1 = xi1.sin() / (eta1.sinh().powi(2) + xi1.cos().powi(2)).sqrt();
        let dl = eta1.sinh().atan2(xi1.cos());
        let e = self.e;
        let mut tau = tau1;
        for _ in 0..20 {
            let sigma = (e * (e * tau / (1.0 + tau * tau).sqrt()).atanh()).sinh();
            let taui = tau * (1.0 + sigma * sigma).sqrt() - sigma * (1.0 + tau * tau).sqrt();
            let d = (tau1 - taui) / (1.0 + taui * taui).sqrt() * (1.0 + (1.0 - e * e) * tau * tau) / ((1.0 - e * e) * (1.0 + tau * tau).sqrt());
            tau += d;
            if d.abs() < 1e-14 {
                break;
            }
        }
        (tau.atan(), dl)
    }
}

/// Lambert conformal conic on the ellipsoid (Snyder 1987, 15).
struct Lcc {
    e: f64,
    a: f64,
    n: f64,
    f_: f64,
    rho0: f64,
}

impl Lcc {
    fn new(lat0: f64, lat1: f64, lat2: f64, (a, f): (f64, f64)) -> Lcc {
        let e = (f * (2.0 - f)).sqrt();
        let m = |p: f64| p.cos() / (1.0 - e * e * p.sin().powi(2)).sqrt();
        let t = |p: f64| (PI / 4.0 - p / 2.0).tan() / ((1.0 - e * p.sin()) / (1.0 + e * p.sin())).powf(e / 2.0);
        let (p0, p1, p2) = (lat0.to_radians(), lat1.to_radians(), lat2.to_radians());
        let n = if (p1 - p2).abs() < 1e-12 { p1.sin() } else { (m(p1).ln() - m(p2).ln()) / (t(p1).ln() - t(p2).ln()) };
        let f_ = m(p1) / (n * t(p1).powf(n));
        Lcc { e, a, n, f_, rho0: a * f_ * t(p0).powf(n) }
    }
    fn t(&self, p: f64) -> f64 {
        let e = self.e;
        (PI / 4.0 - p / 2.0).tan() / ((1.0 - e * p.sin()) / (1.0 + e * p.sin())).powf(e / 2.0)
    }
    fn forward(&self, lat: f64, dl: f64) -> (f64, f64) {
        let rho = self.a * self.f_ * self.t(lat).powf(self.n);
        let th = self.n * dl;
        (rho * th.sin(), self.rho0 - rho * th.cos())
    }
    fn inverse(&self, x: f64, y: f64) -> (f64, f64) {
        let sn = self.n.signum();
        let rho = sn * (x * x + (self.rho0 - y).powi(2)).sqrt();
        let t = (rho / (self.a * self.f_)).powf(1.0 / self.n);
        let th = (sn * x).atan2(sn * (self.rho0 - y));
        let e = self.e;
        let mut p = PI / 2.0 - 2.0 * t.atan();
        for _ in 0..30 {
            let np = PI / 2.0 - 2.0 * (t * ((1.0 - e * p.sin()) / (1.0 + e * p.sin())).powf(e / 2.0)).atan();
            let done = (np - p).abs() < 1e-14;
            p = np;
            if done {
                break;
            }
        }
        (p, th / self.n)
    }
}

/// Web Mercator metres to (lon, lat) degrees.
pub fn merc_to_lonlat(x: f64, y: f64) -> (f64, f64) {
    Proj::WebMercator.to_lonlat(x, y)
}

/* ------------------------------------------------------- GeoTIFF */

/// A single-band raster with its georeferencing.
#[derive(Clone, Debug)]
pub struct Raster {
    pub w: usize,
    pub h: usize,
    pub data: Vec<f64>,
    pub nodata: Option<f64>,
    /// (x of the left edge, pixel width, y of the top edge, pixel height > 0)
    pub x0: f64,
    pub dx: f64,
    pub y0: f64,
    pub dy: f64,
    pub epsg: Option<u32>,
}

impl Raster {
    pub fn get(&self, col: usize, row: usize) -> f64 {
        self.data[row * self.w + col]
    }
    pub fn is_nodata(&self, v: f64) -> bool {
        !v.is_finite() || (self.nodata == Some(v))
    }
    /// Bilinear sample at a map position (pixel centres as in GDAL),
    /// weighting only cells with data; None where there are none.
    #[cfg(test)]
    pub fn bilinear(&self, x: f64, y: f64) -> Option<f64> {
        let fx = (x - self.x0) / self.dx - 0.5;
        let fy = (self.y0 - y) / self.dy - 0.5;
        if fx < -0.5 || fy < -0.5 || fx > self.w as f64 - 0.5 || fy > self.h as f64 - 0.5 {
            return None;
        }
        let (c0, r0) = (fx.floor(), fy.floor());
        let (tx, ty) = (fx - c0, fy - r0);
        let (mut sum, mut wsum) = (0.0, 0.0);
        for (dc, dr, w) in [(0.0, 0.0, (1.0 - tx) * (1.0 - ty)), (1.0, 0.0, tx * (1.0 - ty)), (0.0, 1.0, (1.0 - tx) * ty), (1.0, 1.0, tx * ty)] {
            let (c, r) = ((c0 + dc).clamp(0.0, self.w as f64 - 1.0) as usize, (r0 + dr).clamp(0.0, self.h as f64 - 1.0) as usize);
            let v = self.get(c, r);
            if w > 0.0 && !self.is_nodata(v) {
                sum += w * v;
                wsum += w;
            }
        }
        if wsum > 0.0 { Some(sum / wsum) } else { None }
    }
}

/// Read band 1 of a GeoTIFF (any sample type), with its georeferencing.
pub fn read_geotiff(bytes: &[u8]) -> R<Raster> {
    use tiff::decoder::{Decoder, DecodingResult, Limits};
    use tiff::tags::Tag;
    let mut limits = Limits::default();
    limits.decoding_buffer_size = 512 << 20;
    limits.ifd_value_size = 64 << 20;
    limits.intermediate_buffer_size = 512 << 20;
    let mut d = Decoder::new(std::io::Cursor::new(bytes)).map_err(err)?.with_limits(limits);
    let (w, h) = d.dimensions().map_err(err)?;
    let scale = d.get_tag_f64_vec(Tag::ModelPixelScaleTag).ok();
    let tie = d.get_tag_f64_vec(Tag::ModelTiepointTag).ok();
    let geokeys = d.get_tag_u16_vec(Tag::GeoKeyDirectoryTag).unwrap_or_default();
    let nodata = d.get_tag_ascii_string(Tag::GdalNodata).ok().and_then(|s| s.trim().trim_end_matches('\0').trim().parse::<f64>().ok());
    let key = |id: u16| -> Option<u16> {
        geokeys.get(4..)?.chunks(4).find(|k| k.len() == 4 && k[0] == id && k[1] == 0).map(|k| k[3])
    };
    let epsg = key(3072).filter(|&c| c != 0 && c != 32767).or_else(|| key(2048).filter(|&c| c != 0 && c != 32767)).map(|c| c as u32);
    let point = key(1025) == Some(2);
    let data: Vec<f64> = match d.read_image().map_err(err)? {
        DecodingResult::F16(v) => v.into_iter().map(|x| x.to_f64()).collect(),
        DecodingResult::F32(v) => v.into_iter().map(|x| x as f64).collect(),
        DecodingResult::F64(v) => v,
        DecodingResult::U8(v) => v.into_iter().map(|x| x as f64).collect(),
        DecodingResult::U16(v) => v.into_iter().map(|x| x as f64).collect(),
        DecodingResult::U32(v) => v.into_iter().map(|x| x as f64).collect(),
        DecodingResult::U64(v) => v.into_iter().map(|x| x as f64).collect(),
        DecodingResult::I8(v) => v.into_iter().map(|x| x as f64).collect(),
        DecodingResult::I16(v) => v.into_iter().map(|x| x as f64).collect(),
        DecodingResult::I32(v) => v.into_iter().map(|x| x as f64).collect(),
        DecodingResult::I64(v) => v.into_iter().map(|x| x as f64).collect(),
    };
    let (w, h) = (w as usize, h as usize);
    // more than one sample per pixel: keep the first band
    let spp = data.len() / (w * h).max(1);
    let data = if spp > 1 { data.chunks(spp).map(|c| c[0]).collect() } else { data };
    let (dx, dy) = scale.as_ref().filter(|s| s.len() >= 2).map_or((1.0, 1.0), |s| (s[0], s[1]));
    let (mut x0, mut y0) = tie.as_ref().filter(|t| t.len() >= 5).map_or((0.0, 0.0), |t| (t[3] - t[0] * dx, t[4] + t[1] * dy));
    if point {
        x0 -= dx / 2.0;
        y0 += dy / 2.0;
    }
    Ok(Raster { w, h, data, nodata, x0, dx, y0, dy, epsg })
}

/// Write a float32 GeoTIFF (deflate) in a projected CRS given by EPSG code.
#[expect(clippy::too_many_arguments, reason = "GeoTIFF writer takes explicit grid geometry and band metadata")]
pub fn write_geotiff_f32(path: &std::path::Path, w: usize, h: usize, data: &[f32], x0: f64, y0: f64, cell: f64, epsg: u32, nodata: f64) -> R<()> {
    use tiff::encoder::{colortype, Compression, TiffEncoder};
    use tiff::tags::Tag;
    let f = std::fs::File::create(path).map_err(err)?;
    let mut enc = TiffEncoder::new(std::io::BufWriter::new(f)).map_err(err)?.with_compression(Compression::Deflate(Default::default()));
    let mut img = enc.new_image::<colortype::Gray32Float>(w as u32, h as u32).map_err(err)?;
    let geographic = Proj::from_epsg(epsg) == Some(Proj::Geographic);
    let keys: Vec<u16> = if geographic {
        vec![1, 1, 0, 3, 1024, 0, 1, 2, 1025, 0, 1, 1, 2048, 0, 1, epsg as u16]
    } else {
        vec![1, 1, 0, 3, 1024, 0, 1, 1, 1025, 0, 1, 1, 3072, 0, 1, epsg as u16]
    };
    img.encoder().write_tag(Tag::ModelPixelScaleTag, &[cell, cell, 0.0][..]).map_err(err)?;
    img.encoder().write_tag(Tag::ModelTiepointTag, &[0.0, 0.0, 0.0, x0, y0, 0.0][..]).map_err(err)?;
    img.encoder().write_tag(Tag::GeoKeyDirectoryTag, &keys[..]).map_err(err)?;
    img.encoder().write_tag(Tag::GdalNodata, &*format!("{}", nodata)).map_err(err)?;
    img.rows_per_strip(16).map_err(err)?;
    img.write_data(data).map_err(err)?;
    Ok(())
}

/* ------------------------------------------------------ shapefiles */

/// A shapefile record index and the coordinates of one line part.
pub type ShapeLine = (usize, Vec<(f64, f64)>);

/// Line parts of a shapefile (.shp): polylines and polygon outlines, with
/// each record's index. Other shapes are skipped.
pub fn shp_lines(b: &[u8]) -> R<Vec<ShapeLine>> {
    if b.len() < 100 || u32::from_be_bytes([b[0], b[1], b[2], b[3]]) != 9994 {
        return Err("not a shapefile".into());
    }
    let le_i32 = |p: usize| i32::from_le_bytes([b[p], b[p + 1], b[p + 2], b[p + 3]]);
    let le_f64 = |p: usize| f64::from_le_bytes(b[p..p + 8].try_into().unwrap());
    let mut out = Vec::new();
    let mut p = 100;
    let mut rec = 0;
    while p + 8 <= b.len() {
        let len = u32::from_be_bytes([b[p + 4], b[p + 5], b[p + 6], b[p + 7]]) as usize * 2;
        let s = p + 8;
        if s + len > b.len() || len < 4 {
            break;
        }
        let ty = le_i32(s);
        if [3, 13, 23, 5, 15, 25].contains(&ty) && len >= 44 {
            let nparts = le_i32(s + 36).max(0) as usize;
            let npts = le_i32(s + 40).max(0) as usize;
            let parts_at = s + 44;
            let pts_at = parts_at + 4 * nparts;
            if pts_at + 16 * npts <= s + len {
                let mut starts: Vec<usize> = (0..nparts).map(|k| le_i32(parts_at + 4 * k).max(0) as usize).collect();
                starts.push(npts);
                for k in 0..nparts {
                    let (a, z) = (starts[k].min(npts), starts[k + 1].min(npts));
                    let line = (a..z).map(|i| (le_f64(pts_at + 16 * i), le_f64(pts_at + 16 * i + 8))).collect();
                    out.push((rec, line));
                }
            }
        }
        rec += 1;
        p = s + len;
    }
    Ok(out)
}

/// The attribute table (.dbf): field names and each record's values as text.
pub fn dbf_records(b: &[u8]) -> R<(Vec<String>, Vec<Vec<String>>)> {
    if b.len() < 32 {
        return Err("not a dbf".into());
    }
    let n = u32::from_le_bytes([b[4], b[5], b[6], b[7]]) as usize;
    let hlen = (u16::from_le_bytes([b[8], b[9]]) as usize).min(b.len());
    let rlen = u16::from_le_bytes([b[10], b[11]]) as usize;
    if rlen == 0 {
        return Err("dbf: zero record length".into());
    }
    let mut fields = Vec::new();
    let mut p = 32;
    while p + 32 <= hlen && b[p] != 0x0d {
        let name = String::from_utf8_lossy(&b[p..p + 11]).trim_end_matches('\0').trim().to_string();
        fields.push((name, b[p + 16] as usize));
        p += 32;
    }
    let mut recs = Vec::new();
    for r in 0..n {
        let Some(s) = r.checked_mul(rlen).and_then(|v| hlen.checked_add(v)) else { break };
        if s.checked_add(rlen).is_none_or(|end| end > b.len()) {
            break;
        }
        let mut q = s + 1; // deletion flag
        let mut vals = Vec::new();
        for (_, l) in &fields {
            let end = q.saturating_add(*l).min(b.len());
            let start = q.min(end);
            vals.push(String::from_utf8_lossy(&b[start..end]).trim().to_string());
            q = end;
        }
        recs.push(vals);
    }
    Ok((fields.into_iter().map(|f| f.0).collect(), recs))
}

/* ---------------------------------------------- rasterising shapes */

/// Burn polygons (rings: outer and holes, even-odd) into a grid: a pixel
/// takes the value when its centre is inside (rasterio's default).
/// `x0, y0`: top-left corner; `cell`: pixel size.
#[expect(clippy::too_many_arguments, reason = "Rasterizer takes explicit grid geometry, polygons and burn value")]
pub fn rasterize(grid: &mut [u8], w: usize, h: usize, x0: f64, y0: f64, cell: f64, rings: &[Vec<(f64, f64)>], value: u8) {
    let mut ymin = f64::INFINITY;
    let mut ymax = f64::NEG_INFINITY;
    for r in rings {
        for p in r {
            ymin = ymin.min(p.1);
            ymax = ymax.max(p.1);
        }
    }
    if !ymin.is_finite() {
        return;
    }
    let r0 = (((y0 - ymax) / cell - 0.5).floor().max(0.0)) as usize;
    let r1 = ((((y0 - ymin) / cell - 0.5).ceil()).min(h as f64 - 1.0).max(-1.0)) as i64;
    let mut xs: Vec<f64> = Vec::new();
    for row in r0..=(r1.max(-1) as usize).min(h.saturating_sub(1)) {
        if r1 < 0 {
            break;
        }
        let yc = y0 - (row as f64 + 0.5) * cell;
        xs.clear();
        for r in rings {
            let n = r.len();
            for i in 0..n {
                let (a, b) = (r[i], r[(i + 1) % n]);
                if (a.1 > yc) != (b.1 > yc) {
                    xs.push(a.0 + (yc - a.1) * (b.0 - a.0) / (b.1 - a.1));
                }
            }
        }
        xs.sort_by(|a, b| a.partial_cmp(b).unwrap_or(std::cmp::Ordering::Equal));
        for pair in xs.chunks(2) {
            if pair.len() < 2 {
                break;
            }
            // pixel centres x0 + (c + 0.5) cell within [pair0, pair1)
            let c0 = ((pair[0] - x0) / cell - 0.5).ceil().max(0.0);
            let c1 = ((pair[1] - x0) / cell - 0.5).ceil().min(w as f64);
            let (c0, c1) = (c0 as usize, c1.max(0.0) as usize);
            for c in c0..c1.min(w) {
                grid[row * w + c] = value;
            }
        }
    }
}

/* ------------------------------------------------------------- PNG */

/// Write a palette PNG: `pixels` index into `palette` (RGB triples);
/// `alpha` gives the palette's transparency (shorter is opaque after).
pub fn write_png_indexed(path: &std::path::Path, w: usize, h: usize, pixels: &[u8], palette: &[[u8; 3]], alpha: &[u8]) -> R<()> {
    let f = std::fs::File::create(path).map_err(err)?;
    let mut e = png::Encoder::new(std::io::BufWriter::new(f), w as u32, h as u32);
    e.set_color(png::ColorType::Indexed);
    e.set_depth(png::BitDepth::Eight);
    e.set_compression(png::Compression::High);
    e.set_palette(palette.iter().flatten().copied().collect::<Vec<u8>>());
    if !alpha.is_empty() {
        e.set_trns(alpha.to_vec());
    }
    let mut wr = e.write_header().map_err(err)?;
    wr.write_image_data(pixels).map_err(err)?;
    Ok(())
}

/// Decode a PNG to RGBA.
pub fn decode_png_rgba(b: &[u8]) -> R<(usize, usize, Vec<u8>)> {
    let mut dec = png::Decoder::new(std::io::Cursor::new(b));
    dec.set_transformations(png::Transformations::EXPAND | png::Transformations::STRIP_16);
    let mut r = dec.read_info().map_err(err)?;
    let mut buf = vec![0; r.output_buffer_size().ok_or("PNG output is too large")?];
    let info = r.next_frame(&mut buf).map_err(err)?;
    let (w, h) = (info.width as usize, info.height as usize);
    let px = &buf[..info.buffer_size()];
    let rgba: Vec<u8> = match info.color_type {
        png::ColorType::Rgba => px.to_vec(),
        png::ColorType::Rgb => px.chunks(3).flat_map(|c| [c[0], c[1], c[2], 255]).collect(),
        png::ColorType::GrayscaleAlpha => px.chunks(2).flat_map(|c| [c[0], c[0], c[0], c[1]]).collect(),
        png::ColorType::Grayscale => px.iter().flat_map(|&g| [g, g, g, 255]).collect(),
        png::ColorType::Indexed => return Err("indexed PNG not expanded".into()),
    };
    Ok((w, h, rgba))
}

/// Reduce an RGBA image to at most `n` colours (median cut over the
/// visible pixels; fully transparent pixels share one entry). Returns
/// (indexes, palette, alpha per palette entry).
pub fn quantize(rgba: &[u8], n: usize) -> (Vec<u8>, Vec<[u8; 3]>, Vec<u8>) {
    let px: Vec<[u8; 4]> = rgba.chunks(4).map(|c| [c[0], c[1], c[2], c[3]]).collect();
    let has_clear = px.iter().any(|p| p[3] == 0);
    let mut colours: std::collections::HashMap<[u8; 4], u32> = std::collections::HashMap::new();
    for p in &px {
        if p[3] != 0 {
            *colours.entry(*p).or_insert(0) += 1;
        }
    }
    let budget = n.max(2) - usize::from(has_clear);
    let mut boxes: Vec<Vec<([u8; 4], u32)>> = vec![colours.into_iter().collect()];
    loop {
        if boxes.len() >= budget {
            break;
        }
        // split the box with the widest channel range (weighted by pixels)
        let mut best: Option<(usize, usize, u64)> = None;
        for (i, b) in boxes.iter().enumerate() {
            if b.len() < 2 {
                continue;
            }
            for ch in 0..4 {
                let lo = b.iter().map(|c| c.0[ch]).min().unwrap() as u64;
                let hi = b.iter().map(|c| c.0[ch]).max().unwrap() as u64;
                let count: u64 = b.iter().map(|c| c.1 as u64).sum();
                let score = (hi - lo) * (count as f64).sqrt() as u64 + (hi - lo);
                if best.is_none_or(|x| score > x.2) {
                    best = Some((i, ch, score));
                }
            }
        }
        let Some((i, ch, score)) = best else { break };
        if score == 0 {
            break;
        }
        let mut b = boxes.swap_remove(i);
        b.sort_by_key(|c| c.0[ch]);
        let total: u64 = b.iter().map(|c| c.1 as u64).sum();
        let mut acc = 0u64;
        let mut cut = 1;
        for (k, c) in b.iter().enumerate() {
            acc += c.1 as u64;
            if acc * 2 >= total {
                cut = (k + 1).clamp(1, b.len() - 1);
                break;
            }
        }
        let rest = b.split_off(cut);
        boxes.push(b);
        boxes.push(rest);
    }
    let mut palette = Vec::new();
    let mut alpha = Vec::new();
    let mut lookup: std::collections::HashMap<[u8; 4], u8> = std::collections::HashMap::new();
    if has_clear {
        palette.push([0, 0, 0]);
        alpha.push(0);
    }
    for b in &boxes {
        if b.is_empty() {
            continue;
        }
        let total: f64 = b.iter().map(|c| c.1 as f64).sum();
        let avg = |ch: usize| (b.iter().map(|c| c.0[ch] as f64 * c.1 as f64).sum::<f64>() / total).round() as u8;
        let idx = palette.len() as u8;
        palette.push([avg(0), avg(1), avg(2)]);
        alpha.push(avg(3));
        for c in b {
            lookup.insert(c.0, idx);
        }
    }
    let idx: Vec<u8> = px.iter().map(|p| if p[3] == 0 { 0 } else { lookup[p] }).collect();
    // trailing opaque entries need no alpha
    while alpha.last() == Some(&255) {
        alpha.pop();
    }
    (idx, palette, alpha)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn mga_round_trip_and_known_point() {
        let p = Proj::from_name("EPSG:7856").unwrap();
        // Brisbane City gauge
        let (x, y) = p.project_lonlat(153.0305, -27.4741);
        assert!((x - 502_990.0).abs() < 50.0 && (y - 6_961_000.0).abs() < 1500.0, "{} {}", x, y);
        let (lon, lat) = p.to_lonlat(x, y);
        assert!((lon - 153.0305).abs() < 1e-9 && (lat + 27.4741).abs() < 1e-9);
        // the central meridian at the equator is the false origin
        let (x, y) = p.project_lonlat(153.0, 0.0);
        assert!((x - 500000.0).abs() < 1e-6 && (y - 10000000.0).abs() < 1e-6);
        // one degree of latitude along the meridian, scaled by k0
        let (_, y1) = p.project_lonlat(153.0, -1.0);
        assert!(((10000000.0 - y1) - 0.9996 * 110574.4).abs() < 1.0, "{}", 10000000.0 - y1);
    }

    #[test]
    fn lambert_round_trip_and_wkt() {
        let wkt = r#"PROJCS["GDA_1994_NSW_Lambert",GEOGCS["GCS_GDA_1994",DATUM["D_GDA_1994",SPHEROID["GRS_1980",6378137.0,298.257222101]],PRIMEM["Greenwich",0.0],UNIT["Degree",0.0174532925199433]],PROJECTION["Lambert_Conformal_Conic"],PARAMETER["False_Easting",9300000.0],PARAMETER["False_Northing",4500000.0],PARAMETER["Central_Meridian",147.0],PARAMETER["Standard_Parallel_1",-30.75],PARAMETER["Standard_Parallel_2",-35.75],PARAMETER["Latitude_Of_Origin",-33.25],UNIT["Meter",1.0]]"#;
        let p = Proj::from_wkt(wkt).unwrap();
        assert_eq!(p, Proj::from_epsg(3308).unwrap());
        let (x, y) = p.project_lonlat(147.0, -33.25);
        assert!((x - 9300000.0).abs() < 1e-6 && (y - 4500000.0).abs() < 1e-6);
        let (lon, lat) = p.to_lonlat(p.project_lonlat(150.9, -30.1).0, p.project_lonlat(150.9, -30.1).1);
        assert!((lon - 150.9).abs() < 1e-9 && (lat + 30.1).abs() < 1e-9);
        let mga = Proj::from_wkt(r#"PROJCS["GDA_1994_MGA_Zone_56",GEOGCS["GCS_GDA_1994",DATUM["D_GDA_1994",SPHEROID["GRS_1980",6378137.0,298.257222101]]],PROJECTION["Transverse_Mercator"],PARAMETER["False_Easting",500000.0],PARAMETER["False_Northing",10000000.0],PARAMETER["Central_Meridian",153.0],PARAMETER["Scale_Factor",0.9996],PARAMETER["Latitude_Of_Origin",0.0],UNIT["Meter",1.0]]"#).unwrap();
        assert_eq!(mga, Proj::from_epsg(28356).unwrap());
        assert_eq!(Proj::from_wkt(r#"GEOGCS["GCS_GDA_1994",DATUM["D_GDA_1994"]]"#), Some(Proj::Geographic));
    }

    #[test]
    fn web_mercator() {
        let (lon, lat) = merc_to_lonlat(153.0f64.to_radians() * R_MERC, 0.0);
        assert!((lon - 153.0).abs() < 1e-9 && lat.abs() < 1e-9);
        let y = R_MERC * (PI / 4.0 + (-27.47f64).to_radians() / 2.0).tan().ln();
        assert!((merc_to_lonlat(0.0, y).1 + 27.47).abs() < 1e-9);
    }

    #[test]
    fn geotiff_round_trip() {
        let p = std::env::temp_dir().join(format!("gt-{}.tif", std::process::id()));
        let data: Vec<f32> = (0..12).map(|i| i as f32).collect();
        write_geotiff_f32(&p, 4, 3, &data, 500000.0, 7000000.0, 40.0, 7856, -9999.0).unwrap();
        let r = read_geotiff(&std::fs::read(&p).unwrap()).unwrap();
        assert_eq!((r.w, r.h, r.epsg, r.nodata), (4, 3, Some(7856), Some(-9999.0)));
        assert_eq!((r.x0, r.y0, r.dx, r.dy), (500000.0, 7000000.0, 40.0, 40.0));
        assert_eq!(r.get(3, 2), 11.0);
        // bilinear at a pixel centre is the pixel; between two, the mean
        assert_eq!(r.bilinear(500000.0 + 60.0, 7000000.0 - 20.0), Some(1.0));
        assert_eq!(r.bilinear(500000.0 + 40.0, 7000000.0 - 20.0), Some(0.5));
        let _ = std::fs::remove_file(p);
    }

    #[test]
    fn rasterize_centres_and_holes() {
        let mut g = vec![0u8; 100];
        let outer = vec![(0.0, 0.0), (0.0, 10.0), (10.0, 10.0), (10.0, 0.0)];
        let hole = vec![(4.0, 4.0), (6.0, 4.0), (6.0, 6.0), (4.0, 6.0)];
        rasterize(&mut g, 10, 10, 0.0, 10.0, 1.0, &[outer, hole], 3);
        assert_eq!(g.iter().filter(|&&v| v == 3).count(), 96);
        assert_eq!(g[4 * 10 + 4], 0);
    }

    #[test]
    fn quantize_keeps_transparency_and_few_colours() {
        let mut rgba = Vec::new();
        for i in 0..400u32 {
            if i % 5 == 0 {
                rgba.extend([0, 0, 0, 0]);
            } else {
                rgba.extend([(i % 200) as u8, 100, (i % 7 * 30) as u8, 200]);
            }
        }
        let (idx, pal, alpha) = quantize(&rgba, 16);
        assert!(pal.len() <= 16);
        assert_eq!(alpha[0], 0);
        assert_eq!(idx[0], 0);
        assert!(idx[1] != 0);
    }

    #[test]
    fn shapefile_polyline() {
        // one polyline record with two points
        let mut rec = Vec::new();
        rec.extend(3i32.to_le_bytes());
        rec.extend([0u8; 32]);
        rec.extend(1i32.to_le_bytes());
        rec.extend(2i32.to_le_bytes());
        rec.extend(0i32.to_le_bytes());
        for v in [1.0f64, 2.0, 3.0, 4.0] {
            rec.extend(v.to_le_bytes());
        }
        let mut b = vec![0u8; 100];
        b[..4].copy_from_slice(&9994u32.to_be_bytes());
        b.extend(1u32.to_be_bytes());
        b.extend(((rec.len() / 2) as u32).to_be_bytes());
        b.extend(rec);
        assert_eq!(shp_lines(&b).unwrap(), vec![(0, vec![(1.0, 2.0), (3.0, 4.0)])]);
    }
}
