# Flood Explorer — desktop (Tauri) shell

Phase 1 proof-of-life: a Tauri 2 app that launches the `flood-broker`
sidecar in local mode and loads the built web app.

## Prerequisites

- Rust toolchain (see `rust-toolchain.toml`).
- Node.js + npm.
- Tauri CLI: `cargo install tauri-cli --version "^2"` (or `npm i -g @tauri-apps/cli`).
- The broker binary built for the host target, copied to
  `desktop/binaries/flood-broker-<target-triple>` (Tauri's sidecar naming).

## Build the broker sidecar

```
cd rust
cargo build --release -p flood-broker
# copy + rename for the host triple, e.g. on macOS arm64:
cp target/release/flood-broker ../desktop/binaries/flood-broker-aarch64-apple-darwin
chmod +x ../desktop/binaries/flood-broker-aarch64-apple-darwin
```

## Build the frontend

```
FLOOD_BROKER_URL=http://127.0.0.1:8787 npm run build   # outputs to site/
```

## Run in dev

```
cd desktop
cargo tauri dev
```

## Build installers

```
cd desktop
cargo tauri build
```

Produces `.dmg`/`.app` (macOS), `.msi`/`.exe` (Windows), `.AppImage`/`.deb`
(Linux) under `desktop/target/release/bundle/`.

## Notes

- The broker runs on port 8787 by default; `ALLOWED_ORIGINS` is set to
  `http://localhost,tauri://localhost` for the webview.
- Data is stored under `~/.flood-explorer/` (readings.json + .gz).
- The refresh loop runs in-process every 15 minutes.
- National data (`site/data/national/*`) is bundled via `bundle.resources`.
EOF