//! HTTP (ureq, rustls) and anonymous FTP, with retries and Python-style
//! URL encoding.

use crate::util::*;
use std::io::{Read, Write};
use std::time::Duration;
use ureq::ResponseExt;

/// A failed request: an HTTP status (with the body's start), or a
/// connection problem.
#[derive(Debug, Clone)]
pub enum NetErr {
    Status(u16, String),
    Transport(String),
}

impl std::fmt::Display for NetErr {
    fn fmt(&self, f: &mut std::fmt::Formatter) -> std::fmt::Result {
        match self {
            NetErr::Status(c, _) => write!(f, "HTTP Error {}", c),
            NetErr::Transport(s) => write!(f, "{}", s),
        }
    }
}

pub struct Resp {
    pub body: Vec<u8>,
    pub url: String,
    pub content_type: String,
}

impl Resp {
    pub fn text(&self) -> String {
        String::from_utf8_lossy(&self.body).into_owned()
    }
}

fn agent(timeout_s: u64) -> ureq::Agent {
    ureq::Agent::config_builder()
        .timeout_connect(Some(Duration::from_secs(timeout_s.min(60))))
        // ureq 3 budgets each transfer phase rather than each socket read.
        .timeout_send_request(Some(Duration::from_secs(timeout_s)))
        .timeout_send_body(Some(Duration::from_secs(timeout_s)))
        .timeout_recv_response(Some(Duration::from_secs(timeout_s)))
        .timeout_recv_body(Some(Duration::from_secs(timeout_s)))
        .max_redirects(8)
        .http_status_as_error(false)
        .build()
        .into()
}

/// One request: method, URL, headers, optional body.
pub fn request(method: &str, url: &str, headers: &[(&str, &str)], body: Option<&[u8]>, timeout_s: u64) -> Result<Resp, NetErr> {
    if url.starts_with("ftp://") {
        return ftp_get(url, timeout_s).map_err(NetErr::Transport);
    }
    let mut req = ureq::http::Request::builder().method(method).uri(url);
    let mut has_ua = false;
    for (k, v) in headers {
        has_ua |= k.eq_ignore_ascii_case("user-agent");
        req = req.header(*k, *v);
    }
    if !has_ua {
        req = req.header("User-Agent", UA);
    }
    let req = req.body(body.unwrap_or_default()).map_err(|e| NetErr::Transport(e.to_string()))?;
    let mut r = agent(timeout_s).run(req).map_err(|e| NetErr::Transport(e.to_string()))?;
    let code = r.status().as_u16();
    if code >= 400 {
        let mut b = Vec::new();
        let _ = r.body_mut().as_reader().take(4000).read_to_end(&mut b);
        return Err(NetErr::Status(code, String::from_utf8_lossy(&b).into_owned()));
    }
    let url = r.get_uri().to_string();
    let content_type = r.headers().get("Content-Type").and_then(|v| v.to_str().ok()).unwrap_or("").to_string();
    let mut body = Vec::new();
    r.body_mut().as_reader().read_to_end(&mut body).map_err(|e| NetErr::Transport(e.to_string()))?;
    Ok(Resp { body, url, content_type })
}

pub fn get(url: &str, headers: &[(&str, &str)], timeout_s: u64) -> Result<Resp, NetErr> {
    request("GET", url, headers, None, timeout_s)
}

/// One request with an extension method (WebDAV PROPFIND and friends).
/// ureq 3 rejects methods outside its HTTP/1.1 allowlist before sending, so
/// this goes through ureq 2, which accepts any method string.
pub fn request_ext(method: &str, url: &str, headers: &[(&str, &str)], body: Option<&[u8]>, timeout_s: u64) -> Result<Resp, NetErr> {
    let mut r = ureq2::request(method, url);
    let mut has_ua = false;
    for (k, v) in headers {
        has_ua |= k.eq_ignore_ascii_case("user-agent");
        r = r.set(k, v);
    }
    if !has_ua {
        r = r.set("User-Agent", UA);
    }
    let r = r.timeout(Duration::from_secs(timeout_s));
    let resp = match body {
        Some(b) => r.send_bytes(b),
        None => r.call(),
    }
    .map_err(|e| {
        // ureq 2 turns HTTP statuses into errors; keep the body's start
        match e {
            ureq2::Error::Status(c, r) => {
                let mut b = Vec::new();
                let _ = r.into_reader().take(4000).read_to_end(&mut b);
                NetErr::Status(c, String::from_utf8_lossy(&b).into_owned())
            }
            ureq2::Error::Transport(t) => NetErr::Transport(t.to_string()),
        }
    })?;
    let code = resp.status();
    if code >= 400 {
        let mut b = Vec::new();
        let _ = resp.into_reader().take(4000).read_to_end(&mut b);
        return Err(NetErr::Status(code, String::from_utf8_lossy(&b).into_owned()));
    }
    let url = resp.get_url().to_string();
    let content_type = resp.header("Content-Type").unwrap_or("").to_string();
    let mut body = Vec::new();
    resp.into_reader().read_to_end(&mut body).map_err(|e| NetErr::Transport(e.to_string()))?;
    Ok(Resp { body, url, content_type })
}

/// GET and parse JSON.
pub fn get_json(url: &str, headers: &[(&str, &str)], timeout_s: u64) -> R<serde_json::Value> {
    let r = get(url, headers, timeout_s).map_err(|e| format!("{}: {}", clip(url, 120), e))?;
    serde_json::from_slice(&r.body).map_err(|_| format!("not JSON: {:?}", String::from_utf8_lossy(&r.body[..r.body.len().min(80)])))
}

/* ------------------------------------------------- URL encoding */

/// Python's urllib.parse.quote_plus on a value.
pub fn quote_plus(s: &str) -> String {
    let mut o = String::new();
    for b in s.bytes() {
        match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'_' | b'.' | b'-' | b'~' => o.push(b as char),
            b' ' => o.push('+'),
            _ => o.push_str(&format!("%{:02X}", b)),
        }
    }
    o
}

/// Python's urllib.parse.quote(s, safe=...) (also keeps '/' unless removed from safe).
pub fn quote(s: &str, safe: &str) -> String {
    let mut o = String::new();
    for b in s.bytes() {
        let keep = matches!(b, b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'_' | b'.' | b'-' | b'~') || safe.as_bytes().contains(&b);
        if keep {
            o.push(b as char);
        } else {
            o.push_str(&format!("%{:02X}", b));
        }
    }
    o
}

/// Percent-decoding (urllib.parse.unquote).
pub fn unquote(s: &str) -> String {
    let b = s.as_bytes();
    let mut out = Vec::with_capacity(b.len());
    let mut i = 0;
    while i < b.len() {
        if b[i] == b'%' && i + 2 < b.len() {
            if let Ok(v) = u8::from_str_radix(&s[i + 1..i + 3], 16) {
                out.push(v);
                i += 3;
                continue;
            }
        }
        out.push(b[i]);
        i += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

/// Python's urlencode for (key, value) pairs.
pub fn urlencode<K: AsRef<str>, V: AsRef<str>>(pairs: &[(K, V)]) -> String {
    pairs.iter().map(|(k, v)| format!("{}={}", quote_plus(k.as_ref()), quote_plus(v.as_ref()))).collect::<Vec<_>>().join("&")
}

/// Append query parameters to a URL.
pub fn with_query<K: AsRef<str>, V: AsRef<str>>(url: &str, pairs: &[(K, V)]) -> String {
    if pairs.is_empty() {
        return url.to_string();
    }
    format!("{}{}{}", url, if url.contains('?') { "&" } else { "?" }, urlencode(pairs))
}

/* ------------------------------------------------------------- FTP */

/// Fetch a file by anonymous FTP in passive mode, asking for the full path
/// without changing directory (some servers refuse CWD but serve RETR).
pub fn ftp_get(url: &str, timeout_s: u64) -> R<Resp> {
    let rest = url.strip_prefix("ftp://").ok_or("not an ftp URL")?;
    let (host, path) = rest.split_once('/').ok_or("ftp URL without a path")?;
    let path = format!("/{}", path);
    let (host, port) = match host.split_once(':') {
        Some((h, p)) => (h.to_string(), p.parse::<u16>().map_err(err)?),
        None => (host.to_string(), 21),
    };
    let to = Duration::from_secs(timeout_s);
    let connect = |h: &str, p: u16| -> R<std::net::TcpStream> {
        use std::net::ToSocketAddrs;
        let addr = (h, p).to_socket_addrs().map_err(err)?.next().ok_or("no address")?;
        let s = std::net::TcpStream::connect_timeout(&addr, to).map_err(err)?;
        s.set_read_timeout(Some(to)).map_err(err)?;
        s.set_write_timeout(Some(to)).map_err(err)?;
        Ok(s)
    };
    let mut ctl = connect(&host, port)?;
    let mut rd = std::io::BufReader::new(ctl.try_clone().map_err(err)?);
    let reply = |rd: &mut std::io::BufReader<std::net::TcpStream>| -> R<(u32, String)> {
        use std::io::BufRead;
        let mut line = String::new();
        rd.read_line(&mut line).map_err(err)?;
        let code: u32 = line.get(..3).and_then(|c| c.parse().ok()).ok_or_else(|| format!("ftp: odd reply {:?}", line))?;
        let mut all = line.clone();
        if line.as_bytes().get(3) == Some(&b'-') {
            loop {
                let mut l = String::new();
                if rd.read_line(&mut l).map_err(err)? == 0 {
                    break;
                }
                all.push_str(&l);
                if l.starts_with(&format!("{} ", code)) {
                    break;
                }
            }
        }
        Ok((code, all.trim().to_string()))
    };
    let cmd = |ctl: &mut std::net::TcpStream, rd: &mut std::io::BufReader<std::net::TcpStream>, c: &str| -> R<(u32, String)> {
        ctl.write_all(format!("{}\r\n", c).as_bytes()).map_err(err)?;
        reply(rd)
    };
    let (c, m) = reply(&mut rd)?;
    if c != 220 {
        return Err(format!("ftp: {}", m));
    }
    let (c, m) = cmd(&mut ctl, &mut rd, "USER anonymous")?;
    if c == 331 {
        let (c2, m2) = cmd(&mut ctl, &mut rd, "PASS anonymous@")?;
        if c2 != 230 {
            return Err(format!("ftp: {}", m2));
        }
    } else if c != 230 {
        return Err(format!("ftp: {}", m));
    }
    cmd(&mut ctl, &mut rd, "TYPE I")?;
    let (c, m) = cmd(&mut ctl, &mut rd, "PASV")?;
    if c != 227 {
        return Err(format!("ftp: {}", m));
    }
    let inner = m.split('(').nth(1).and_then(|x| x.split(')').next()).ok_or("ftp: odd PASV reply")?;
    let n: Vec<u16> = inner.split(',').filter_map(|x| x.trim().parse().ok()).collect();
    if n.len() != 6 {
        return Err(format!("ftp: odd PASV reply {}", m));
    }
    let mut data = connect(&host, n[4] * 256 + n[5])?;
    let (c, m) = cmd(&mut ctl, &mut rd, &format!("RETR {}", path))?;
    if c != 150 && c != 125 {
        return Err(format!("ftp: {}", m));
    }
    let mut body = Vec::new();
    data.read_to_end(&mut body).map_err(err)?;
    drop(data);
    let _ = reply(&mut rd);
    let _ = cmd(&mut ctl, &mut rd, "QUIT");
    Ok(Resp { body, url: url.to_string(), content_type: String::new() })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn mock_http(responses: Vec<String>) -> (String, std::thread::JoinHandle<Vec<String>>) {
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let url = format!("http://{}", listener.local_addr().unwrap());
        let handle = std::thread::spawn(move || {
            responses.into_iter().map(|response| {
                let (mut socket, _) = listener.accept().unwrap();
                socket.set_read_timeout(Some(Duration::from_secs(5))).unwrap();
                let mut bytes = Vec::new();
                let mut byte = [0];
                while !bytes.ends_with(b"\r\n\r\n") {
                    socket.read_exact(&mut byte).unwrap();
                    bytes.push(byte[0]);
                }
                let headers = String::from_utf8(bytes.clone()).unwrap();
                let length = headers.lines().find_map(|line| {
                    let (name, value) = line.split_once(':')?;
                    name.eq_ignore_ascii_case("content-length").then(|| value.trim().parse::<usize>().unwrap())
                }).unwrap_or(0);
                let mut body = vec![0; length];
                socket.read_exact(&mut body).unwrap();
                bytes.extend(body);
                socket.write_all(response.as_bytes()).unwrap();
                String::from_utf8(bytes).unwrap()
            }).collect()
        });
        (url, handle)
    }

    #[test]
    fn http_redirect_preserves_final_url_and_headers() {
        let (url, server) = mock_http(vec![
            "HTTP/1.1 302 Found\r\nLocation: /final\r\nContent-Length: 0\r\nConnection: close\r\n\r\n".into(),
            "HTTP/1.1 200 OK\r\nContent-Type: text/plain\r\nContent-Length: 5\r\nConnection: close\r\n\r\nhello".into(),
        ]);
        let r = get(&format!("{url}/start"), &[("User-Agent", "flood-test")], 5).unwrap();
        assert_eq!(r.url, format!("{url}/final"));
        assert_eq!(r.content_type, "text/plain");
        assert_eq!(r.body, b"hello");
        let requests = server.join().unwrap();
        assert!(requests[1].starts_with("GET /final HTTP/1.1"));
        assert!(requests[1].to_lowercase().contains("user-agent: flood-test"));
    }

    #[test]
    fn http_post_body_and_error_excerpt() {
        let body = "x".repeat(5000);
        let (url, server) = mock_http(vec![format!("HTTP/1.1 503 Unavailable\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}", body.len(), body)]);
        match request("POST", &url, &[("Content-Type", "application/json")], Some(b"{}"), 5) {
            Err(NetErr::Status(503, text)) => assert_eq!(text, "x".repeat(4000)),
            _ => panic!("expected an HTTP status error with a bounded body excerpt"),
        }
        let requests = server.join().unwrap();
        assert!(requests[0].starts_with("POST / HTTP/1.1"));
        assert!(requests[0].ends_with("\r\n\r\n{}"));
    }

    #[test]
    fn encoding_matches_python() {
        assert_eq!(urlencode(&[("where", "1=1"), ("outFields", "a,b"), ("q", "tide gauge")]), "where=1%3D1&outFields=a%2Cb&q=tide+gauge");
        assert_eq!(quote("/v1 1/HPT.tif", "/"), "/v1%201/HPT.tif");
        assert_eq!(unquote("/a%20b/c"), "/a b/c");
        assert_eq!(with_query("https://x/y?a=1", &[("b", "2")]), "https://x/y?a=1&b=2");
    }
}
