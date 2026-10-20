//! Just enough Amazon S3 for the broker to keep one shared readings file:
//! GET and PUT of an object, signed with AWS Signature Version 4 (ring's
//! HMAC-SHA256, already in the build for TLS). Credentials come from the
//! Lambda environment (AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY,
//! AWS_SESSION_TOKEN).
//! https://docs.aws.amazon.com/AmazonS3/latest/API/sig-v4-header-based-auth.html

use ring::{digest, hmac};
use std::io::Read;
use std::time::Duration;

pub struct Creds {
    pub key: String,
    pub secret: String,
    pub token: Option<String>,
}

impl Creds {
    pub fn from_env() -> Option<Creds> {
        let v = |k: &str| std::env::var(k).ok().filter(|s| !s.is_empty());
        Some(Creds { key: v("AWS_ACCESS_KEY_ID")?, secret: v("AWS_SECRET_ACCESS_KEY")?, token: v("AWS_SESSION_TOKEN") })
    }
}

pub fn hex(b: &[u8]) -> String {
    b.iter().map(|x| format!("{:02x}", x)).collect()
}

pub fn sha256_hex(b: &[u8]) -> String {
    hex(digest::digest(&digest::SHA256, b).as_ref())
}

fn hmac_sha256(key: &[u8], msg: &str) -> Vec<u8> {
    hmac::sign(&hmac::Key::new(hmac::HMAC_SHA256, key), msg.as_bytes()).as_ref().to_vec()
}

/// "20130524T000000Z" for milliseconds since 1970.
pub fn amz_date(ms: i64) -> String {
    let iso = crate::wmip::iso_utc(ms); // 2013-05-24T00:00:00Z
    iso.replace(['-', ':'], "")
}

/// The Authorization header for a request whose headers (lower-case names)
/// include host, x-amz-date and x-amz-content-sha256.
#[allow(clippy::too_many_arguments)]
pub fn authorization(method: &str, path: &str, query: &str, headers: &[(&str, String)], payload_hash: &str, region: &str, service: &str, creds: &Creds) -> String {
    let mut h: Vec<(String, String)> = headers.iter().map(|(k, v)| (k.to_ascii_lowercase(), v.trim().to_string())).collect();
    h.sort();
    let canonical_headers: String = h.iter().map(|(k, v)| format!("{}:{}\n", k, v)).collect();
    let signed: String = h.iter().map(|(k, _)| k.as_str()).collect::<Vec<_>>().join(";");
    let canonical = format!("{}\n{}\n{}\n{}\n{}\n{}", method, path, query, canonical_headers, signed, payload_hash);
    let date_time = &h.iter().find(|(k, _)| k == "x-amz-date").expect("x-amz-date").1;
    let date = &date_time[..8];
    let scope = format!("{}/{}/{}/aws4_request", date, region, service);
    let to_sign = format!("AWS4-HMAC-SHA256\n{}\n{}\n{}", date_time, scope, sha256_hex(canonical.as_bytes()));
    let k = hmac_sha256(format!("AWS4{}", creds.secret).as_bytes(), date);
    let k = hmac_sha256(&k, region);
    let k = hmac_sha256(&k, service);
    let k = hmac_sha256(&k, "aws4_request");
    let sig = hex(&hmac_sha256(&k, &to_sign));
    format!("AWS4-HMAC-SHA256 Credential={}/{}, SignedHeaders={}, Signature={}", creds.key, scope, signed, sig)
}

pub enum Got {
    /// the object and S3's ETag for it
    Body(Vec<u8>, Option<String>),
    Unchanged,
    Missing,
}

pub struct Bucket {
    pub name: String,
    pub region: String,
}

impl Bucket {
    fn host(&self) -> String {
        format!("{}.s3.{}.amazonaws.com", self.name, self.region)
    }

    fn send(&self, method: &str, key: &str, body: Option<(&[u8], &str)>, if_none_match: Option<&str>, now_ms: i64) -> Result<(u16, Vec<u8>, Option<String>), String> {
        let creds = Creds::from_env().ok_or("no AWS credentials in the environment")?;
        let path = format!("/{}", key.split('/').map(crate::wmip::encode).collect::<Vec<_>>().join("/"));
        let payload = sha256_hex(body.map_or(&[][..], |b| b.0));
        let mut headers: Vec<(&str, String)> = vec![("host", self.host()), ("x-amz-content-sha256", payload.clone()), ("x-amz-date", amz_date(now_ms))];
        if let Some(t) = &creds.token {
            headers.push(("x-amz-security-token", t.clone()));
        }
        if let Some((_, ct)) = body {
            headers.push(("content-type", ct.to_string()));
        }
        let auth = authorization(method, &path, "", &headers, &payload, &self.region, "s3", &creds);
        let t = Some(Duration::from_secs(20));
        let agent: ureq::Agent = ureq::Agent::config_builder().timeout_connect(t).timeout_recv_response(t).timeout_recv_body(t).timeout_send_body(t).http_status_as_error(false).build().into();
        let url = format!("https://{}{}", self.host(), path);
        let mut req = ureq::http::Request::builder().method(method).uri(&url).header("Authorization", auth);
        // not signed: S3 accepts unsigned conditional headers
        if let Some(e) = if_none_match {
            req = req.header("If-None-Match", e);
        }
        for (k, v) in &headers {
            if *k != "host" {
                req = req.header(*k, v);
            }
        }
        let req = req.body(body.map_or(Vec::new(), |b| b.0.to_vec())).map_err(|e| e.to_string())?;
        let mut r = agent.run(req).map_err(|e| e.to_string())?;
        let code = r.status().as_u16();
        let etag = r.headers().get("ETag").and_then(|v| v.to_str().ok()).map(String::from);
        let mut out = Vec::new();
        r.body_mut().as_reader().take(32 << 20).read_to_end(&mut out).map_err(|e| e.to_string())?;
        Ok((code, out, etag))
    }

    /// The object unless it is unchanged since `if_none_match` (S3's ETag).
    pub fn get(&self, key: &str, if_none_match: Option<&str>, now_ms: i64) -> Result<Got, String> {
        match self.send("GET", key, None, if_none_match, now_ms)? {
            (200, b, e) => Ok(Got::Body(b, e)),
            (304, _, _) => Ok(Got::Unchanged),
            (404, _, _) => Ok(Got::Missing),
            (c, b, _) => Err(format!("S3 GET {}: HTTP {} {}", key, c, String::from_utf8_lossy(&b[..b.len().min(200)]))),
        }
    }

    pub fn put(&self, key: &str, body: &[u8], content_type: &str, now_ms: i64) -> Result<(), String> {
        match self.send("PUT", key, Some((body, content_type)), None, now_ms)? {
            (200, _, _) => Ok(()),
            (c, b, _) => Err(format!("S3 PUT {}: HTTP {} {}", key, c, String::from_utf8_lossy(&b[..b.len().min(200)]))),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    // AWS's worked example: GET /test.txt from examplebucket, 24 May 2013
    // https://docs.aws.amazon.com/AmazonS3/latest/API/sig-v4-header-based-auth.html
    #[test]
    fn signature_matches_the_aws_example() {
        let creds = Creds { key: "AKIAIOSFODNN7EXAMPLE".into(), secret: "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY".into(), token: None };
        let empty = sha256_hex(b"");
        assert_eq!(empty, "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
        let headers = [("host", "examplebucket.s3.amazonaws.com".to_string()), ("range", "bytes=0-9".to_string()), ("x-amz-content-sha256", empty.clone()), ("x-amz-date", "20130524T000000Z".to_string())];
        let auth = authorization("GET", "/test.txt", "", &headers, &empty, "us-east-1", "s3", &creds);
        assert_eq!(auth, "AWS4-HMAC-SHA256 Credential=AKIAIOSFODNN7EXAMPLE/20130524/us-east-1/s3/aws4_request, SignedHeaders=host;range;x-amz-content-sha256;x-amz-date, Signature=f0e8bdb87c964420e857bd35b5d6ed310bd44f0170aba48dd91039c6036bdb41");
    }

    #[test]
    fn dates() {
        assert_eq!(amz_date(crate::wmip::epoch_ms("2013-05-24T00:00:00Z").unwrap()), "20130524T000000Z");
    }
}
