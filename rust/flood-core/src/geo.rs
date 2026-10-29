//! GDA2020 / GDA94 MGA (UTM) coordinates: the transverse Mercator projection on the GRS80 ellipsoid by Krüger's series, accurate to about a millimetre inside a
//! zone. The same transform as `viewer/tsunami-extents.js` (checked there against Geoscience Australia's Flinders Peak reference), here for the nesting model.

const A: f64 = 6378137.0;
const FLAT: f64 = 1.0 / 298.257222101;
const K0: f64 = 0.9996;
const FALSE_E: f64 = 500000.0;
const FALSE_N: f64 = 10000000.0;

struct Series { r: f64, alpha: [f64; 3], beta: [f64; 3], delta: [f64; 3], n: f64 }

fn series() -> Series {
    let n = FLAT / (2.0 - FLAT);
    let (n2, n3, n4) = (n * n, n * n * n, n * n * n * n);
    Series {
        n,
        r: A / (1.0 + n) * (1.0 + n2 / 4.0 + n4 / 64.0),
        alpha: [n / 2.0 - 2.0 * n2 / 3.0 + 5.0 * n3 / 16.0, 13.0 * n2 / 48.0 - 3.0 * n3 / 5.0, 61.0 * n3 / 240.0],
        beta: [n / 2.0 - 2.0 * n2 / 3.0 + 37.0 * n3 / 96.0, n2 / 48.0 + n3 / 15.0, 17.0 * n3 / 480.0],
        delta: [2.0 * n - 2.0 * n2 / 3.0 - 2.0 * n3, 7.0 * n2 / 3.0 - 8.0 * n3 / 5.0, 56.0 * n3 / 15.0],
    }
}

pub fn central_meridian(zone: i32) -> f64 { (zone * 6 - 183) as f64 }

/// Latitude and longitude (degrees) to easting and northing (m) in an MGA zone.
pub fn to_mga(lat: f64, lon: f64, zone: i32) -> (f64, f64) {
    let s = series();
    let (phi, lam) = (lat.to_radians(), (lon - central_meridian(zone)).to_radians());
    let e = 2.0 * s.n.sqrt() / (1.0 + s.n);
    let t = (phi.sin().atanh() - e * (e * phi.sin()).atanh()).sinh();
    let (xi, eta) = (t.atan2(lam.cos()), (lam.sin() / t.hypot(1.0)).atanh());
    let (mut x, mut y) = (xi, eta);
    for (i, a) in s.alpha.iter().enumerate() {
        let j = 2.0 * (i as f64 + 1.0);
        x += a * (j * xi).sin() * (j * eta).cosh();
        y += a * (j * xi).cos() * (j * eta).sinh();
    }
    (FALSE_E + K0 * s.r * y, FALSE_N + K0 * s.r * x)
}

/// The inverse: easting and northing (m) to latitude and longitude (degrees).
pub fn from_mga(easting: f64, northing: f64, zone: i32) -> (f64, f64) {
    let s = series();
    let (xi, eta) = ((northing - FALSE_N) / (K0 * s.r), (easting - FALSE_E) / (K0 * s.r));
    let (mut xi1, mut eta1) = (xi, eta);
    for (i, b) in s.beta.iter().enumerate() {
        let j = 2.0 * (i as f64 + 1.0);
        xi1 -= b * (j * xi).sin() * (j * eta).cosh();
        eta1 -= b * (j * xi).cos() * (j * eta).sinh();
    }
    let chi = (xi1.sin() / eta1.cosh()).asin();
    let mut phi = chi;
    for (i, d) in s.delta.iter().enumerate() { phi += d * (2.0 * (i as f64 + 1.0) * chi).sin(); }
    (phi.to_degrees(), central_meridian(zone) + eta1.sinh().atan2(xi1.cos()).to_degrees())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn matches_geoscience_australias_flinders_peak_and_inverts() {
        let (lat, lon) = (-(37.0 + 57.0 / 60.0 + 3.7203 / 3600.0), 144.0 + 25.0 / 60.0 + 29.5244 / 3600.0);
        let (e, n) = to_mga(lat, lon, 55);
        assert!((e - 273741.297).abs() < 0.005 && (n - 5796489.777).abs() < 0.005, "{e} {n}");
        let (la, lo) = from_mga(e, n, 55);
        assert!((la - lat).abs() < 1e-9 && (lo - lon).abs() < 1e-9);
        let (e0, n0) = to_mga(0.0, 153.0, 56);
        assert!((e0 - 500000.0).abs() < 1.0 && (n0 - 10000000.0).abs() < 1.0);
        let (la, lo) = from_mga(540000.0, 6908000.0, 56);
        let (e1, n1) = to_mga(la, lo, 56);
        assert!((e1 - 540000.0).abs() < 0.005 && (n1 - 6908000.0).abs() < 0.005);
    }
}
