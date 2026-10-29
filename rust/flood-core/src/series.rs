//! Reading a wave series file: two columns, seconds from the start of the run and metres above the initial sea level, separated by commas, semicolons, tabs or spaces, with `#`
//! comments and one non-numeric header row allowed. Refuses anything it cannot trust, in the words the lab shows.

pub const MAX_ROWS: usize = 200_000;

// JavaScript's Number() on one token: empty is 0, otherwise a decimal (or hexadecimal/binary/octal) number; anything else is NaN.
fn number(token: &str) -> f64 {
    let t = token.trim();
    if t.is_empty() { return 0.0; }
    for (prefix, radix) in [("0x", 16), ("0X", 16), ("0b", 2), ("0B", 2), ("0o", 8), ("0O", 8)] {
        if let Some(rest) = t.strip_prefix(prefix) { return u64::from_str_radix(rest, radix).map_or(f64::NAN, |v| v as f64); }
    }
    match t {
        "Infinity" | "+Infinity" => f64::INFINITY,
        "-Infinity" => f64::NEG_INFINITY,
        // Rust also accepts words such as "inf" and "nan" that JavaScript does not
        _ if t.chars().any(|c| c.is_alphabetic() && !matches!(c, 'e' | 'E')) => f64::NAN,
        _ => t.parse().unwrap_or(f64::NAN),
    }
}

/// Seconds and metres from the text of a series file.
pub fn parse_series_csv(text: &str, max_rows: usize) -> Result<(Vec<f64>, Vec<f64>), String> {
    let (mut times, mut values): (Vec<f64>, Vec<f64>) = (Vec::new(), Vec::new());
    let mut header = true;
    for raw in text.split('\n') {
        let raw = raw.strip_suffix('\r').unwrap_or(raw);
        let line = raw.split('#').next().unwrap_or("").trim();
        if line.is_empty() { continue; }
        let cells: Vec<&str> = line.split(|c: char| c.is_whitespace() || c == ',' || c == ';').filter(|_| true).collect();
        // JavaScript's split on a run of separators gives no empty cells in the middle; an empty first or last cell is kept only at the ends, which trim() has already removed
        let cells: Vec<&str> = cells.into_iter().filter(|c| !c.is_empty()).collect();
        let numbers: Vec<f64> = cells.iter().take(2).map(|c| number(c)).collect();
        if cells.len() < 2 || numbers.iter().any(|v| !v.is_finite()) {
            if header && times.is_empty() { header = false; continue; }
            return Err(format!("Line \"{}\" is not \"seconds, metres\".", line.chars().take(40).collect::<String>()));
        }
        header = false;
        if times.last().is_some_and(|t| numbers[0] <= *t) { return Err("Times must increase down the file.".into()); }
        if numbers[1].abs() > 20.0 { return Err("Wave heights above 20 m are not accepted.".into()); }
        if times.len() >= max_rows { return Err(format!("Too many rows (limit {max_rows}).")); }
        times.push(numbers[0]);
        values.push(numbers[1]);
    }
    if times.len() < 2 { return Err("The series needs at least two rows of \"seconds, metres\".".into()); }
    Ok((times, values))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_series_file_with_comments_a_header_and_mixed_separators_parses() {
        let (t, v) = parse_series_csv("# DART-style export\nseconds,metres\n0,0\n60;0.5\n120\t1.0\n180 0.5\r\n240,0\n", MAX_ROWS).unwrap();
        assert_eq!(t, vec![0.0, 60.0, 120.0, 180.0, 240.0]);
        assert_eq!(v, vec![0.0, 0.5, 1.0, 0.5, 0.0]);
        let (t, _) = parse_series_csv("0, 1 # trailing comment\n\n   \n10 , 2\n", MAX_ROWS).unwrap();
        assert_eq!(t, vec![0.0, 10.0]);
    }

    #[test]
    fn what_cannot_be_trusted_is_refused_in_the_labs_words() {
        let err = |text: &str| parse_series_csv(text, MAX_ROWS).unwrap_err();
        assert!(err("0,0").contains("at least two rows"));
        assert!(err("0,0\n0,1").contains("Times must increase"));
        assert!(err("0,0\n10,1\n5,1").contains("Times must increase"));
        assert!(err("0,0\n5,abc").contains("not \"seconds, metres\""));
        assert!(err("0,0\n5,99").contains("above 20 m"));
        assert!(err("0,0\n5,inf").contains("not \"seconds, metres\""), "words Rust would read as numbers are not numbers here");
        assert!(err("0,0\n5,nan").contains("not \"seconds, metres\""));
        assert!(err("0\n1,1\n2,2\n3").contains("not \"seconds, metres\""), "only the first non-numeric line may be a header");
        assert!(err("a,b\nc,d\n0,0\n1,1").contains("Line \"c,d\""));
        let long: String = "x".repeat(60) + ",1\n0,0\n1,1";
        assert!(parse_series_csv(&format!("a,b\n{long}"), MAX_ROWS).unwrap_err().contains(&"x".repeat(40)), "the offending line is quoted up to 40 characters");
        assert!(parse_series_csv("0,0\n1,1\n2,2", 2).unwrap_err().contains("Too many rows (limit 2)"));
    }

    #[test]
    fn numbers_read_as_javascript_reads_them() {
        assert_eq!(number(""), 0.0);
        assert_eq!(number("1e3"), 1000.0);
        assert_eq!(number("-.5"), -0.5);
        assert_eq!(number("0x10"), 16.0);
        assert!(number("1e").is_nan() && number("--1").is_nan() && number("1,5").is_nan() && number("nan").is_nan() && number("inf").is_nan());
        assert!(number("Infinity").is_infinite());
        let (t, _) = parse_series_csv(",5\n10,1\n20,2", MAX_ROWS).unwrap();
        assert_eq!(t, vec![10.0, 20.0], "an empty first cell is not a number, so the line is a header");
    }
}
