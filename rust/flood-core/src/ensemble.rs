//! A small sensitivity ensemble: a baseline, each uncertain input pushed low and high on its own, and two combined cases (all towards more flooding, all towards less).
//! It brackets the model's response to those inputs; it is not a sample from probability distributions. The plan works out the factors of each run (duplicates caused by
//! clamping are dropped); the page words the labels. `summarise` is the minimum and maximum of each measure over the finished runs.

#[derive(Clone, Copy, PartialEq, Debug)]
pub struct Factors { pub amplitude: f64, pub tide: f64, pub roughness: f64, pub terrain: f64 }

/// Which run of the plan this is.
#[derive(Clone, Copy, PartialEq, Debug)]
pub enum Kind { Base, Low(Input), High(Input), Severe, Mild }

#[derive(Clone, Copy, PartialEq, Debug)]
pub enum Input { Amplitude, Tide, Roughness, Terrain }

pub const INPUTS: [Input; 4] = [Input::Amplitude, Input::Tide, Input::Roughness, Input::Terrain];

pub struct Spread { pub amplitude_percent: f64, pub tide_metres: f64, pub roughness_percent: f64, pub terrain_metres: f64 }

impl Default for Spread {
    fn default() -> Self { Spread { amplitude_percent: 50.0, tide_metres: 0.5, roughness_percent: 50.0, terrain_metres: 0.5 } }
}

pub struct Member { pub kind: Kind, pub factors: Factors }

fn set(f: Factors, input: Input, v: f64) -> Factors {
    let mut f = f;
    match input { Input::Amplitude => f.amplitude = v, Input::Tide => f.tide = v, Input::Roughness => f.roughness = v, Input::Terrain => f.terrain = v }
    f
}

/// The runs of an ensemble around `base` (amplitude, tide, roughness; terrain is a uniform vertical shift of the bed in metres, negative lowers the ground and floods more).
pub fn plan(base: Factors, spread: &Spread, terrain: bool, amplitude: bool) -> Vec<Member> {
    let mid = Factors { terrain: 0.0, ..base };
    let band = |centre: f64, half: f64, low: f64, high: f64| ((centre - half).clamp(low, high), (centre + half).clamp(low, high));
    let amp = if amplitude { band(base.amplitude, base.amplitude * spread.amplitude_percent / 100.0, 0.05, 3.0) } else { (base.amplitude, base.amplitude) };
    let tide = band(base.tide, spread.tide_metres, -1.0, 2.0);
    let rough = band(base.roughness, base.roughness * spread.roughness_percent / 100.0, 0.0, 0.2);
    let ter = if terrain { (-spread.terrain_metres, spread.terrain_metres) } else { (0.0, 0.0) };
    let ranges = [amp, tide, rough, ter];
    let mut members = vec![Member { kind: Kind::Base, factors: mid }];
    let mut add = |kind: Kind, factors: Factors| { if !members.iter().any(|m| m.factors == factors) { members.push(Member { kind, factors }); } };
    for (input, (low, high)) in INPUTS.into_iter().zip(ranges) {
        add(Kind::Low(input), set(mid, input, low));
        add(Kind::High(input), set(mid, input, high));
    }
    add(Kind::Severe, Factors { amplitude: amp.1, tide: tide.1, roughness: rough.0, terrain: ter.0 });
    add(Kind::Mild, Factors { amplitude: amp.0, tide: tide.0, roughness: rough.1, terrain: ter.1 });
    members
}

#[derive(Clone, Copy, PartialEq, Debug)]
pub struct Span { pub min: f64, pub max: f64, pub missing: usize }

/// Minimum and maximum over the finite values; the rest (a gauge that was not reached) are counted as missing, and the span is NaN when none are finite.
pub fn span(values: impl IntoIterator<Item = f64>) -> Span {
    let (mut min, mut max, mut missing) = (f64::INFINITY, f64::NEG_INFINITY, 0);
    for v in values { if v.is_finite() { min = min.min(v); max = max.max(v); } else { missing += 1; } }
    if min > max { Span { min: f64::NAN, max: f64::NAN, missing } } else { Span { min, max, missing } }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn base() -> Factors { Factors { amplitude: 2.5, tide: 0.0, roughness: 0.025, terrain: 0.0 } }
    fn spread() -> Spread { Spread { amplitude_percent: 50.0, tide_metres: 0.5, roughness_percent: 40.0, terrain_metres: 0.5 } }

    #[test]
    fn a_plan_brackets_each_input_on_its_own_and_in_combination_without_duplicates() {
        let plan = plan(base(), &spread(), true, true);
        assert_eq!(plan.len(), 11);
        assert_eq!(plan[0].factors, base());
        for (i, a) in plan.iter().enumerate() { assert!(plan[i + 1..].iter().all(|b| b.factors != a.factors)); }
        let differing = |m: &Member| [m.factors.amplitude != base().amplitude, m.factors.tide != base().tide, m.factors.roughness != base().roughness, m.factors.terrain != base().terrain].iter().filter(|d| **d).count();
        for m in &plan { if matches!(m.kind, Kind::Low(_) | Kind::High(_)) { assert_eq!(differing(m), 1); } }
        let find = |k: Kind| plan.iter().find(|m| m.kind == k).unwrap().factors;
        let (severe, mild) = (find(Kind::Severe), find(Kind::Mild));
        assert!(severe.amplitude > mild.amplitude && severe.tide > mild.tide && severe.roughness < mild.roughness && severe.terrain < mild.terrain);
    }

    #[test]
    fn clamping_merges_runs_that_would_repeat() {
        let clamped = plan(Factors { amplitude: 3.0, tide: 2.0, roughness: 0.0, terrain: 0.0 }, &Spread::default(), false, true);
        for (i, a) in clamped.iter().enumerate() { assert!(clamped[i + 1..].iter().all(|b| b.factors != a.factors)); }
        assert!(clamped.iter().all(|m| m.factors.amplitude <= 3.0 && m.factors.tide <= 2.0 && m.factors.terrain == 0.0));
        assert!(clamped.len() < 11);
        assert!(plan(base(), &Spread::default(), true, false).iter().all(|m| m.factors.amplitude == 2.5));
    }

    #[test]
    fn spans_count_unreached_gauges_as_missing() {
        assert_eq!(span([10.0, 20.0]), Span { min: 10.0, max: 20.0, missing: 0 });
        let none = span([f64::NAN, f64::NAN]);
        assert!(none.min.is_nan() && none.max.is_nan() && none.missing == 2);
        let some = span([f64::NAN, 4.0, -1.0]);
        assert_eq!((some.min, some.max, some.missing), (-1.0, 4.0, 1));
    }
}
