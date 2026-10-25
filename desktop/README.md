# Flood Explorer desktop (Tauri)

The Tauri 2 app runs the broker in the same process and loads the built web
viewer. A separate broker binary is not needed.

## Prerequisites

- Rust toolchain from `rust-toolchain.toml`.
- Node.js + npm (`npm ci` at the repository root).
- Tauri CLI: `cargo install tauri-cli --version "^2"`.
- National data under `viewer/data/national/` (see the main README).

## Run and build

From `desktop/`:

```sh
cargo tauri dev
cargo tauri build
```

Both commands copy `viewer/data/` into `site/data/`, verify the national
datasets exist, and build the frontend with
`FLOOD_BROKER_URL=http://127.0.0.1:8787 DATA_SOURCE=runtime`. Installers are
written under `desktop/target/release/bundle/`.

## GitHub downloads

The `Desktop installers` workflow builds macOS Apple Silicon and Intel DMGs,
Windows x64 NSIS setup, and Linux x64 DEB and AppImage packages. It generates
one national dataset shared by all builds; it does not depend on ignored local
files or bundle traffic API keys. Full historical datasets from the hosted
site's nightly pipeline are not bundled by this workflow.

After committing and pushing the changes:

1. Set the same version in `desktop/tauri.conf.json` and `desktop/Cargo.toml`
   (and regenerate `desktop/Cargo.lock` if the package version changed).
2. Run `Desktop installers` from GitHub Actions on the intended commit, or push
   a matching tag such as `desktop-v0.1.0`.
3. All four platform builds must pass before a draft prerelease is created.
   Installers and `SHA256SUMS.txt` are attached. Failed builds retain their
   successful platform artifacts for 14 days.
4. Test the installers and review `desktop/RELEASE_NOTES.md`, then publish the
   draft from the repository's [Releases page](https://github.com/ghedwards/flood-explorer/releases).
   Published releases are not overwritten; increase the version for a new one.

Manual runs create the version tag at the selected commit. Rerunning an
existing draft updates its assets, so use a new version when switching commits.
Drafts are visible to repository collaborators; public downloads become
available after publication. In-app automatic updates are not enabled.

Mac builds default to ad-hoc signing. For Apple signing and notarization,
configure repository secrets `APPLE_CERTIFICATE` (base64 P12),
`APPLE_CERTIFICATE_PASSWORD`, `APPLE_SIGNING_IDENTITY` (Developer ID Application),
`APPLE_ID`, `APPLE_PASSWORD` (app-specific), and `APPLE_TEAM_ID`.
Follow [Tauri's signing guide](https://v2.tauri.app/distribute/sign/macos/).
Windows packages currently have no code-signing certificate. Without trusted
signing, users may see operating-system installation warnings.

## Local data and settings

The broker listens on `127.0.0.1:8787`. Startup fails if that port is occupied;
stop the other broker before opening the app. The address matches the one
compiled into the viewer.

Readings are stored in `~/.flood-explorer/` (`readings.json` and `.gz`).
`FLOOD_DATA_DIR` overrides this directory. Refresh runs every 15 minutes;
`READINGS_REFRESH_MINUTES=0` disables it.

The gear button edits QLD and NSW traffic API keys in `settings.ini` inside
the data directory. `FLOOD_SETTINGS` overrides the file path. Keys are read
again when road feeds are next refreshed; existing road-feed cache intervals
still apply. Non-empty environment variables take precedence over file values.
An empty QLD key uses the public key; an empty NSW key disables that feed
unless its environment variable is set. The web build's keys are managed by
its broker host, so it does not display the local Settings button.

Desktop elevation requests go through `/v1/elev` on the local broker to avoid
WebKit CORS restrictions. Hosted web builds also use their configured broker,
with direct GA access as a fallback if the proxy fails.
