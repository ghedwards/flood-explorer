//! Decoding stored and downloaded bytes: the one-byte hazard rates of the tsunami extents, and Terrarium elevation tiles.

// ---- the stored rates: one byte per cell, 0 = never, else log10(rate per year) = code / 40 - 6 ----
pub const CODE_SCALE: f64 = 40.0;
pub const CODE_OFFSET: f64 = 6.0;

/// Classes by how often (years between): rarest first. A cell never reached, or reached less often than the last class, is not drawn.
pub const CLASS_YEARS: [f64; 5] = [2500.0, 1000.0, 500.0, 250.0, 100.0];

pub fn encode_rate(rate: f64) -> u8 {
    if rate.is_nan() || rate <= 0.0 { return 0; }
    // Math.round: halves go up
    ((rate.log10() + CODE_OFFSET) * CODE_SCALE + 0.5).floor().clamp(1.0, 255.0) as u8
}

pub fn decode_rate(code: u8) -> f64 {
    if code == 0 { 0.0 } else { 10f64.powf(code as f64 / CODE_SCALE - CODE_OFFSET) }
}

/// 0: rarer than 1 in 2,500 years ... 5: more often than 1 in 100; -1 for a rate that is not drawn (never, or rarer than 1 in 10,000 years).
pub fn class_of_rate(rate: f64) -> i32 {
    if rate.is_nan() || rate <= 0.0 || rate < 1.0 / CLASS_YEARS[0] / 4.0 { return -1; }
    CLASS_YEARS.iter().take_while(|years| rate >= 1.0 / **years).count() as i32
}

pub const SEA_LEVEL: f64 = -1.5;

/// Heights in metres of an `n` x `n` Terrarium tile (RGBA bytes), the sea floor clamped to the same -1.5 m sea level the DEM path uses so the sea is flat.
pub fn decode_terrarium(rgba: &[u8], n: usize) -> Vec<f32> {
    (0..n * n).map(|i| {
        let h = rgba[i * 4] as f64 * 256.0 + rgba[i * 4 + 1] as f64 + rgba[i * 4 + 2] as f64 / 256.0 - 32768.0;
        (if h < SEA_LEVEL { SEA_LEVEL } else { h }) as f32
    }).collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rates_round_trip_within_a_few_percent_and_never_is_zero() {
        for rate in [1e-5, 3e-4, 0.002, 0.01, 0.05, 0.9] { assert!((decode_rate(encode_rate(rate)) / rate - 1.0).abs() < 0.06, "{rate}"); }
        assert_eq!((encode_rate(0.0), decode_rate(0), encode_rate(f64::NAN), encode_rate(-1.0)), (0, 0.0, 0, 0));
        assert_eq!((encode_rate(1e-30), encode_rate(1e9)), (1, 255), "codes stay in 1..=255");
    }

    #[test]
    fn rates_fall_into_the_classes_by_how_often() {
        let got: Vec<i32> = [0.0, 1e-5, 1.0 / 5000.0, 1.0 / 2000.0, 1.0 / 800.0, 1.0 / 300.0, 1.0 / 150.0, 1.0 / 50.0].map(class_of_rate).to_vec();
        assert_eq!(got, vec![-1, -1, 0, 1, 2, 3, 4, 5]);
        assert_eq!(class_of_rate(f64::NAN), -1);
    }

    #[test]
    fn terrarium_pixels_become_heights_with_the_sea_floor_flattened() {
        // r*256 + g + b/256 - 32768: 128,10,128 is 10.5 m; 127,0,0 is -256 m, flattened to -1.5 m
        let h = decode_terrarium(&[128, 10, 128, 255, 127, 0, 0, 255, 128, 0, 0, 255, 128, 1, 0, 255], 2);
        assert_eq!(h, vec![10.5, -1.5, 0.0, 1.0]);
    }
}
