//! Running on AWS Lambda behind a function URL, without the AWS runtime
//! crates: the Lambda runtime API is a plain HTTP loop on localhost (ask
//! for the next event, post its response), and a function URL hands over
//! each request as an API Gateway v2 event.
//! https://docs.aws.amazon.com/lambda/latest/dg/runtimes-api.html

use crate::{Broker, Request, Response};
use serde_json::{json, Map, Value};
use std::io::Read;

/// The parts of a function URL event the broker needs.
pub struct Event {
    pub method: String,
    pub target: String,
    pub origin: Option<String>,
    pub client: String,
}

pub fn parse_event(e: &Value) -> Event {
    let http = e.pointer("/requestContext/http");
    let s = |v: Option<&Value>| v.and_then(Value::as_str).unwrap_or("").to_string();
    let path = s(e.get("rawPath"));
    let q = s(e.get("rawQueryString"));
    let header = |k: &str| e.get("headers").and_then(|h| h.as_object()).and_then(|h| h.iter().find(|(n, _)| n.eq_ignore_ascii_case(k))).and_then(|(_, v)| v.as_str()).map(String::from);
    Event {
        method: s(http.and_then(|h| h.get("method"))).to_ascii_uppercase(),
        target: format!("{}{}", if path.is_empty() { "/".into() } else { path }, if q.is_empty() { String::new() } else { format!("?{}", q) }),
        origin: header("origin"),
        // the address Lambda saw the request come from (not a header the
        // caller can set)
        client: s(http.and_then(|h| h.get("sourceIp"))),
    }
}

pub fn to_lambda(r: &Response) -> Value {
    let mut h = Map::new();
    for (k, v) in &r.headers {
        h.insert(k.to_ascii_lowercase(), json!(v));
    }
    json!({"statusCode": r.status, "headers": Value::Object(h), "body": String::from_utf8_lossy(&r.body), "isBase64Encoded": false})
}

pub fn handle_event(broker: &Broker, e: &Value) -> Value {
    // the schedule's own event: refresh the readings (not an HTTP request)
    if e.get("flood_broker").and_then(Value::as_str) == Some("refresh") {
        let r = broker.refresh_readings();
        println!("refresh {}", r);
        return r;
    }
    let ev = parse_event(e);
    let r = broker.handle(&Request { method: &ev.method, target: &ev.target, origin: ev.origin.as_deref(), client: &ev.client });
    to_lambda(&r)
}

/// The runtime loop: never returns.
pub fn run(api: &str, broker: &Broker) -> ! {
    // no timeouts: "next" waits until there is a request
    let agent: ureq::Agent = ureq::Agent::config_builder().http_status_as_error(false).build().into();
    let base = format!("http://{}/2018-06-01/runtime", api);
    loop {
        let mut next = match agent.get(&format!("{}/invocation/next", base)).call() {
            Ok(r) => r,
            Err(e) => {
                eprintln!("flood-broker: runtime API: {}", e);
                std::thread::sleep(std::time::Duration::from_millis(200));
                continue;
            }
        };
        let id = next.headers().get("Lambda-Runtime-Aws-Request-Id").and_then(|v| v.to_str().ok()).unwrap_or("").to_string();
        let mut body = Vec::new();
        let _ = next.body_mut().as_reader().take(6 << 20).read_to_end(&mut body);
        let out = match serde_json::from_slice::<Value>(&body) {
            Ok(e) => std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| handle_event(broker, &e)))
                .unwrap_or_else(|_| json!({"statusCode": 500, "headers": {"content-type": "application/json"}, "body": "{\"error\":\"broker error\"}"})),
            Err(e) => json!({"statusCode": 400, "headers": {"content-type": "application/json"}, "body": json!({"error": format!("bad event: {}", e)}).to_string()}),
        };
        if let Err(e) = agent.post(&format!("{}/invocation/{}/response", base, id)).header("Content-Type", "application/json").send(out.to_string()) {
            eprintln!("flood-broker: posting the response: {}", e);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn function_url_events() {
        let e = json!({
            "version": "2.0", "rawPath": "/v1/levels", "rawQueryString": "sites=143001C,130005A",
            "headers": {"origin": "https://ghedwards.github.io", "x-forwarded-for": "6.6.6.6"},
            "requestContext": {"http": {"method": "GET", "path": "/v1/levels", "sourceIp": "203.0.113.9"}},
        });
        let ev = parse_event(&e);
        assert_eq!(ev.method, "GET");
        assert_eq!(ev.target, "/v1/levels?sites=143001C,130005A");
        assert_eq!(ev.origin.as_deref(), Some("https://ghedwards.github.io"));
        assert_eq!(ev.client, "203.0.113.9", "not the forwarded-for header");
        let ev = parse_event(&json!({"rawPath": "", "requestContext": {"http": {"method": "options"}}}));
        assert_eq!((ev.method.as_str(), ev.target.as_str(), ev.origin), ("OPTIONS", "/", None));
    }

    #[test]
    fn responses_for_lambda() {
        let r = Response { status: 200, headers: vec![("Content-Type".into(), "application/json".into()), ("Access-Control-Allow-Origin".into(), "https://x".into())], body: b"{\"ok\":true}".to_vec() };
        let v = to_lambda(&r);
        assert_eq!(v["statusCode"], 200);
        assert_eq!(v["headers"]["access-control-allow-origin"], "https://x");
        assert_eq!(v["body"], "{\"ok\":true}");
        assert_eq!(v["isBase64Encoded"], false);
    }
}
