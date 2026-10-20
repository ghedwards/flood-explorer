# Flood Explorer live data broker

A small web service that gets live river levels for the map. State water
portals either don't let a web page ask them directly (no CORS headers) or
ask callers not to hammer them, so the map asks this broker instead. It asks
the portal once for everyone, keeps each answer for 10 minutes and replies
with CORS headers for the map's own address.

So far it covers Queensland: hourly river levels from the Water Monitoring
Information Portal, about an hour behind. Water Data Online, which the
build uses for every state, runs about a day behind. Data © State of
Queensland, CC BY 4.0.

```
GET /v1/levels?sites=143001C,130005A
{ "source": "...", "attribution": "© State of Queensland ...",
  "sites": { "143001C": { "latest": ["2026-10-20T17:00:00+10:00", 2.25],
                          "series": [[time, level], ...], "checked": "..." } },
  "missing": [] }

GET /health
{ "ok": true, "cachedSites": 12, "upstreamErrors": 0, ... }
```

It's a small Rust program, `flood-broker` (source in `rust/flood-broker`),
built with the rest of the Rust workspace: a single binary of about 2.5 MB
using a few MB of memory. The smallest VPS will do.

## Run it on AWS Lambda (no server)

See [aws/README.md](aws/README.md): GitHub Actions builds it and deploys it
to a Lambda function URL in your AWS account, inside the free tier.

## Or run it on a server

The map is served over HTTPS, so the broker must be too. The simplest way is
Caddy in front, which gets and renews the certificate itself.

1. Point a DNS name at the server, e.g. `broker.example.com`.
2. Install Caddy (Debian/Ubuntu: `apt install caddy`).
3. Build the broker (on the server, or on a machine of the same CPU type
   and copy the binary over), and add a user for it:
   ```sh
   # needs Rust: https://rustup.rs
   git clone https://github.com/ghedwards/flood-explorer && cd flood-explorer/rust
   cargo build --locked --release -p flood-broker
   sudo install -m 755 target/release/flood-broker /usr/local/bin/
   sudo useradd --system --no-create-home flood-broker
   ```
4. Install the service: copy `deploy/flood-broker.service` to
   `/etc/systemd/system/`, then
   `sudo systemctl enable --now flood-broker`.
5. Put Caddy in front: put your name into `deploy/Caddyfile`, copy it to
   `/etc/caddy/Caddyfile` and `sudo systemctl reload caddy`.
6. Check: `curl https://broker.example.com/health`, and
   `curl 'https://broker.example.com/v1/levels?sites=143001C'`.

Or with Docker (Caddy or another TLS proxy still in front):

```sh
docker build -f broker/Dockerfile -t flood-broker .
docker run -d --restart unless-stopped -p 127.0.0.1:8787:8787 \
  -e TRUST_PROXY=1 flood-broker
```

## Point the map at it

In the GitHub repository: Settings → Secrets and variables → Actions →
Variables → New repository variable `FLOOD_BROKER_URL` =
`https://broker.example.com`. The next build uses it. With no variable set,
the map uses the build's readings only, as before.

Locally: `FLOOD_BROKER_URL=http://127.0.0.1:8787 npm run dev`, with the broker
started as `ALLOWED_ORIGINS=http://127.0.0.1:8000 cargo run --release -p flood-broker`
(in `rust/`).

## Settings (environment)

| Name | Default | |
|---|---|---|
| `PORT` | 8787 | |
| `HOST` | 127.0.0.1 | only reachable through the proxy |
| `ALLOWED_ORIGINS` | https://ghedwards.github.io | comma-separated sites that may call it from a browser |
| `CACHE_MINUTES` | 10 | how long one portal answer is shared |
| `TRUST_PROXY` | off | `1` behind Caddy, so rate limits use the real client address |
| `WORKERS` | 16 | request threads |

## Behaviour

- Only well-formed station numbers on the portal's open-station list are
  passed on, at most 60 per request, in batches of 25. No more than two
  portal calls run at once.
- Viewers asking at the same time share one portal call.
- Each address gets about 60 requests a minute (bursts of 30).
- If the portal stops answering, readings up to 6 hours old are served,
  marked `"stale": true`. After that the reply is a 502.

Tests: `cargo test -p flood-broker` in `rust/` (a stand-in portal, no
network); CI runs them with the rest of the workspace. The 2D screenshot
workflow also runs the broker against the real portal and checks a
Queensland gauge report shows the live level (`tests/broker-live.js`).
