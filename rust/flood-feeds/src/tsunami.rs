//! The latest bulletin of the NOAA/NWS Pacific Tsunami Warning Center, from its public Atom feed (https://www.tsunami.gov/events/xml/PHEBAtom.xml, no key). It is an
//! international bulletin for the Pacific and Indian Oceans, **not** an Australian warning: Australia's official tsunami warnings come from the Joint Australian Tsunami
//! Warning Centre (Bureau of Meteorology), whose machine-readable feed is for registered users only. So this is context, shown beside a link to the Bureau, and an empty or
//! old feed says nothing about whether a threat exists.

use serde_json::{json, Value};

pub const PTWC_ATOM_URL: &str = "https://www.tsunami.gov/events/xml/PHEBAtom.xml";
pub const PTWC_ATTRIBUTION: &str = "NOAA/NWS Pacific Tsunami Warning Center (public domain)";

// The text between the first `<name ...>` and its `</name>` in `xml`, if both are there.
fn tag<'a>(xml: &'a str, name: &str) -> Option<&'a str> {
    let open = xml.find(&format!("<{name}"))?;
    let start = open + xml[open..].find('>')? + 1;
    let end = start + xml[start..].find(&format!("</{name}>"))?;
    Some(&xml[start..end])
}

// An attribute of the first `<name ...>` whose attributes contain `needle`, e.g. the href of the link whose type is cap+xml.
fn link_with(xml: &str, needle: &str) -> Option<String> {
    let mut rest = xml;
    while let Some(i) = rest.find("<link") {
        let end = i + rest[i..].find('>')?;
        let element = &rest[i..end];
        if element.contains(needle) {
            let h = element.find("href=\"")? + 6;
            return Some(element[h..h + element[h..].find('"')?].to_string());
        }
        rest = &rest[end..];
    }
    None
}

fn unescape(s: &str) -> String { s.replace("&lt;", "<").replace("&gt;", ">").replace("&quot;", "\"").replace("&apos;", "'").replace("&amp;", "&") }

fn squeeze(s: &str) -> String { s.split_whitespace().collect::<Vec<_>>().join(" ") }

// The summary's "Key: value" pairs, with the markup removed.
fn fields(summary: &str) -> Vec<(String, String)> {
    let mut text = String::new();
    let mut in_tag = false;
    for c in summary.replace("<br/>", "\n").replace("<br />", "\n").chars() {
        match c { '<' => in_tag = true, '>' => in_tag = false, _ if !in_tag => text.push(c), _ => {} }
    }
    unescape(&text).lines().filter_map(|l| l.split_once(':').map(|(k, v)| (k.trim().to_lowercase(), v.trim().to_string()))).collect()
}

// "2026.10.25 02:27:01 UTC" -> "2026-10-25T02:27:01Z"
fn issue_time(s: &str) -> Option<String> {
    let s = s.trim().trim_end_matches("UTC").trim();
    let (date, time) = s.split_once(' ')?;
    let d: Vec<&str> = date.split('.').collect();
    if d.len() != 3 || time.split(':').count() != 3 || d.iter().any(|p| p.parse::<u32>().is_err()) { return None; }
    Some(format!("{}-{}-{}T{}Z", d[0], d[1], d[2], time))
}

/// The bulletins in the feed, newest first: `level` ("information", "advisory", "watch" or "warning", from the bulletin's category), the region, the preliminary magnitude (null
/// when it has none), the point, the issue time, the links, and `nearby`, whether the point lies in the western Pacific and Indian Ocean box around Australia (a hint for ordering,
/// not a judgement of threat). Entries without a category, a point or a readable time are skipped.
pub fn parse_ptwc_atom(xml: &str) -> Vec<Value> {
    let mut out = Vec::new();
    let mut rest = xml;
    while let Some(i) = rest.find("<entry") {
        let Some(len) = rest[i..].find("</entry>") else { break };
        let entry = &rest[i..i + len];
        rest = &rest[i + len..];
        let f = fields(tag(entry, "summary").unwrap_or(""));
        let get = |k: &str| f.iter().find(|(key, _)| key == k).map(|(_, v)| v.as_str());
        let level = match get("category").map(str::to_lowercase).as_deref() {
            Some("information") => "information", Some("advisory") => "advisory", Some("watch") => "watch", Some("warning") => "warning", _ => continue,
        };
        let (Some(lat), Some(lon)) = (tag(entry, "geo:lat").and_then(|v| v.trim().trim_end_matches('.').parse::<f64>().ok()), tag(entry, "geo:long").and_then(|v| v.trim().trim_end_matches('.').parse::<f64>().ok())) else { continue };
        let Some(issued) = get("bulletin issue time").and_then(issue_time) else { continue };
        let magnitude = get("preliminary magnitude").and_then(|m| m.split(|c: char| !(c.is_ascii_digit() || c == '.')).next().and_then(|n| n.parse::<f64>().ok()));
        let region = squeeze(&unescape(get("affected region").or_else(|| tag(entry, "title")).unwrap_or("")));
        let lon360 = if lon < 0.0 { lon + 360.0 } else { lon };
        out.push(json!({
            "id": tag(entry, "id").map(|v| v.trim().to_string()).unwrap_or_else(|| issued.clone()),
            "source": "PTWC", "level": level, "region": region, "magnitude": magnitude, "point": [lat, lon], "issued": issued,
            "nearby": (90.0..=180.0).contains(&lon360) && (-60.0..=10.0).contains(&lat),
            "bulletin": link_with(entry, "rel=\"alternate\""), "cap": link_with(entry, "cap+xml"),
        }));
    }
    out.sort_by(|a, b| b["issued"].as_str().cmp(&a["issued"].as_str()));
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    // a real bulletin from the feed (trimmed), then one made up to cover the other shapes
    const FEED: &str = r#"<?xml version="1.0" encoding="UTF-8"?>
    <feed xmlns="http://www.w3.org/2005/Atom" xmlns:geo="http://www.w3.org/2003/01/geo/wgs84_pos#">
    <title>        TSUNAMI INFORMATION STATEMENT NUMBER   1        </title>
    <updated>2026-10-25T02:27:01Z</updated>
   <entry>
    <title>BONIN ISLANDS  JAPAN REGION</title><updated>2026-10-25T02:27:01Z</updated>
<geo:lat>28.</geo:lat>
<geo:long>139.9</geo:long>
<summary type="xhtml"><div xmlns="http://www.w3.org/1999/xhtml">
     <strong>Category:</strong> Information<br/><strong>Bulletin Issue Time: </strong> 2026.10.25 02:27:01 UTC <br/><strong>Preliminary Magnitude: </strong>7.0(Mwp)<br/><strong>Lat/Lon: </strong>28. / 139.9<br/><strong>Affected Region: </strong>BONIN ISLANDS  JAPAN REGION<br/><b>Note:</b>  <br/><strong>Definition: </strong><a href="https://www.tsunami.gov/events/PHEB/2026/10/24/26297050/1/WEGM42/WEGM42.txt">View bulletin</a>
 </div></summary>
    <id>urn:uuid:ba64bc82-07f7-45fb-ab6c-25420fca6851</id><link rel="related" title="CapXML document" href="https://www.tsunami.gov/events/PHEB/2026/10/24/26297050/1/WEGM42/PHEBCAP.xml" type="application/cap+xml" />
<link rel="alternate" title="Bulletin" href="https://www.tsunami.gov/events/PHEB/2026/10/24/26297050/1/WEGM42/WEGM42.txt" type="application/xml" />
</entry>
<entry>
 <title>SOLOMON ISLANDS</title><updated>2026-10-26T09:00:00Z</updated><geo:lat>-8.5</geo:lat><geo:long>157.1</geo:long>
 <summary type="xhtml"><div xmlns="http://www.w3.org/1999/xhtml"><strong>Category:</strong> Warning<br/><strong>Bulletin Issue Time: </strong> 2026.10.26 09:00:00 UTC<br/><strong>Affected Region: </strong>SOLOMON ISLANDS &amp; VANUATU<br/></div></summary>
 <id>urn:uuid:two</id>
</entry>
<entry><title>NO CATEGORY</title><geo:lat>1</geo:lat><geo:long>2</geo:long><summary type="xhtml"><div><strong>Bulletin Issue Time: </strong> 2026.10.26 09:00:00 UTC</div></summary></entry>
</feed>"#;

    #[test]
    fn the_bulletins_are_read_newest_first_with_their_level_place_and_links() {
        let items = parse_ptwc_atom(FEED);
        assert_eq!(items.len(), 2, "the entry with no category is skipped");
        let newest = &items[0];
        assert_eq!((newest["level"].as_str(), newest["region"].as_str(), newest["issued"].as_str()), (Some("warning"), Some("SOLOMON ISLANDS & VANUATU"), Some("2026-10-26T09:00:00Z")));
        assert!(newest["magnitude"].is_null() && newest["nearby"] == true && newest["bulletin"].is_null() && newest["cap"].is_null());
        let older = &items[1];
        assert_eq!((older["level"].as_str(), older["region"].as_str(), older["issued"].as_str()), (Some("information"), Some("BONIN ISLANDS JAPAN REGION"), Some("2026-10-25T02:27:01Z")));
        assert_eq!(older["magnitude"], 7.0);
        assert_eq!((older["point"][0].as_f64(), older["point"][1].as_f64()), (Some(28.0), Some(139.9)));
        assert_eq!(older["nearby"], false, "north of the box around Australia");
        assert!(older["bulletin"].as_str().unwrap().ends_with("WEGM42.txt") && older["cap"].as_str().unwrap().ends_with("PHEBCAP.xml"));
        assert_eq!(older["id"], "urn:uuid:ba64bc82-07f7-45fb-ab6c-25420fca6851");
    }

    #[test]
    fn nonsense_gives_nothing_and_never_panics() {
        for text in ["", "not xml", "<feed></feed>", "<entry>", "<entry></entry>", "<entry><summary><strong>Category:</strong> Warning</summary></entry>"] { assert!(parse_ptwc_atom(text).is_empty(), "{text}"); }
        assert_eq!(issue_time("2026.10.25 02:27:01 UTC").as_deref(), Some("2026-10-25T02:27:01Z"));
        assert_eq!(issue_time("yesterday"), None);
    }
}
