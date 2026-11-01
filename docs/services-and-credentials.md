# Services, accounts and credentials

Setup inventory checked against code and official provider guidance on
1 November 2026. This records what to configure, not whether the project's
accounts, approvals, keys or subscriptions are currently active.

The map and local models work without registering for the optional feeds below.
For this repository's hosted setup, GitHub hosts the site and AWS runs the live
broker. Desktop runs its broker locally and does not require an AWS account.

## Signup checklist

| Service | When needed | Signup / account action | Configuration consumed by this project |
|---|---|---|---|
| GitHub | Publish Pages, run Actions or distribute releases | Use the existing repository account/organisation; ensure maintainers can manage Actions variables/secrets and Pages | Repository variables/secrets below; Actions supplies `github.token` automatically |
| AWS | Host the shared web broker on Lambda/S3; optional for local/desktop use | Use/create an AWS account and deploy the CloudFormation stack with a repository-scoped OIDC role | `AWS_DEPLOY_ROLE_ARN`, `AWS_REGION` and broker variables; no stored AWS access key needed for Actions |
| Google Cloud + Flood Forecasting | Optional Google flood forecasts | Google account, Cloud project, API access approval, enabled API and restricted API key | Secret `FLOOD_FORECASTING_API_KEY` in the site build / pipeline environment |
| Transport for NSW Open Data | Optional NSW official traffic/road events | Register, activate the account, sign in and create an API token | Secret/environment/settings key `NSW_TRAFFIC_API_KEY`; enter the raw token without the `apikey` prefix |
| QLDTraffic | Dedicated key for QLD road events; optional because a shared public key is built in | Request registration using the API specification's process | Secret/environment/settings key `QLD_TRAFFIC_API_KEY`; blank retains the shared key |
| Apple Developer | Trusted macOS signing and notarisation; optional for ad-hoc builds | Enrol, obtain a Developer ID Application certificate and create an app-specific notarisation password | Six `APPLE_*` secrets below |
| Tauri update signing | Distribute signed self-updates | No service signup: generate a dedicated signing key and back it up | `FLOOD_UPDATER_PUBLIC_KEY`, `TAURI_SIGNING_PRIVATE_KEY` and its password |

Provider instructions:

- **Google:** join the waitlist from the [API overview](https://developers.google.com/flood-forecasting).
  After approval, follow the email's project-identification instructions, enable
  the API and create a key restricted to it. Google's [access guide](https://support.google.com/flood-hub/answer/16364306?hl=en)
  currently asks for the Cloud project ID; retain both ID and number in the
  private account register. A Cloud account alone does not grant API access.
- **NSW:** the [official user guide](https://opendata.prod.transport.nsw.gov.au/developers/userguide)
  describes profile → API Tokens → Create API Token. Keep the token at creation;
  the broker adds the required `Authorization: apikey …` header.
- **QLD:** the [developer page](https://qldtraffic.qld.gov.au/more/Developers-and-Data/)
  links the API specification. Its registration section requests organisation,
  contact person, email and application name by email to QLDTraffic. A dedicated
  key avoids relying on the shared key's quota; it does not remove service limits.
- **AWS:** follow [our stack instructions](../broker/aws/README.md) and
  [GitHub's AWS OIDC guide](https://docs.github.com/en/actions/how-tos/secure-your-work/security-harden-deployments/oidc-in-aws).
  Use the deploy-role output, not the Lambda execution role.
- **Apple:** [enrolment](https://developer.apple.com/programs/enroll/) and
  [Tauri macOS signing](https://v2.tauri.app/distribute/sign/macos/) explain
  certificate and notarisation setup. Follow [our release guide](../desktop/README.md).
- **Tauri:** [our key-generation and release steps](../desktop/README.md#one-time-signing-setup)
  cover the separate updater key. It is not the Apple certificate.

## Configuration templates and login records

| Template | Private working copy | How it is used |
|---|---|---|
| [`.env.example`](../.env.example) | `.env.local` | Explicitly export into the shell before local npm/Cargo/pipeline commands |
| [`settings.example.ini`](../settings.example.ini) | `settings.ini`, or `~/.flood-explorer/settings.ini` for desktop | Loaded by the standalone broker / desktop settings reader |
| [`github-actions.example.json`](../config/github-actions.example.json) | `config/github-actions.local.json` if needed | Inventory to enter manually under GitHub Settings → Secrets and variables → Actions; not automatically imported |
| [`service-accounts.example.md`](../config/service-accounts.example.md) | `config/service-accounts.local.md` | Operator-only register for account email, owner, project/team ID, approval, renewal and password-manager reference |

All working copies above are ignored by Git. Keep passwords, recovery codes,
certificate/private-key files and token values in a password manager or ignored
`.credentials/` directory, not in the tracked examples. No application login
password is required for Google, NSW or QLD feeds: the application uses API keys.
AWS console credentials and GitHub personal passwords are also not app settings.
`APPLE_PASSWORD` is an app-specific password, never the Apple account password.

To load local environment configuration, from the repository root:

```sh
umask 077
cp .env.example .env.local
# Edit .env.local, then load it into this shell:
set -a
. ./.env.local
set +a
```

The root file is not automatically read by npm, Cargo or the pipeline. The
frontend build reads `FLOOD_BROKER_URL` and `DATA_SOURCE` from the process
environment. These are public build values. Keep private keys out of `VITE_*`
variables, frontend assets and URLs.

The standalone broker accepts `--settings PATH` or `FLOOD_SETTINGS`; desktop
uses `~/.flood-explorer/settings.ini` unless `FLOOD_DATA_DIR`/`FLOOD_SETTINGS`
override it. Non-empty environment values override file values. Blank QLD uses
the shared key; blank NSW disables that feed. Removing an environment override
is necessary before clearing a key in the file can take effect.

## Desktop Settings

The gear button provides masked QLD/NSW traffic-key inputs, signup instructions
and links that open in the system browser. Blank QLD retains the shared key;
blank NSW disables that feed. Keys are loaded/saved through native commands to
the local settings file and cleared from the form when it closes. A failed load
keeps Save disabled so it cannot accidentally replace stored keys with blanks.

Google's signup link and approval requirements are also shown. Its forecast
files still come from the published data build; entering a local Google key is
not supported by the desktop broker. Hosting, account-login records and release
signing remain maintainer configuration, documented here rather than editable
runtime fields.

## GitHub Actions variables (public configuration)

| Variable | Example/default | Consumer |
|---|---|---|
| `DATA_SOURCE` | `build`; set `runtime` once the broker is deployed | Site build / refresh scheduling |
| `FLOOD_BROKER_URL` | Blank, or the deployed HTTPS function URL | Viewer build and broker checks |
| `AWS_DEPLOY_ROLE_ARN` | Stack output `DeployRoleArn`; blank skips deployment | Broker deployment OIDC |
| `AWS_REGION` | `ap-southeast-2` | Broker deployment |
| `BROKER_ALLOWED_ORIGINS` | `https://ghedwards.github.io` (origin, without repository path) | Deployed broker CORS |
| `BROKER_MAX_CONCURRENCY` | `5` | Lambda concurrency cap |
| `BROKER_REFRESH_MINUTES` | `15`; match the stack's schedule | Readings refresh/cache timing |
| `FLOOD_UPDATER_PUBLIC_KEY` | Generated updater public key | Desktop build and release checks |

## GitHub Actions secrets

| Secret | Used by | If absent |
|---|---|---|
| `FLOOD_FORECASTING_API_KEY` | `build.yml` → `flood floodhub` | Forecast output reports not connected |
| `QLD_TRAFFIC_API_KEY` | `broker-deploy.yml` → Lambda environment → roads refresh | Uses built-in shared QLD key |
| `NSW_TRAFFIC_API_KEY` | `broker-deploy.yml` → Lambda environment → roads refresh | Skips NSW traffic feed |
| `TAURI_SIGNING_PRIVATE_KEY` | Desktop signed release build | Update-enabled release fails; verification-only builds remain available |
| `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` | Desktop signing | May be empty for an unencrypted updater key |
| `APPLE_CERTIFICATE` | macOS desktop signing | Uses ad-hoc signing when trusted signing is not configured |
| `APPLE_CERTIFICATE_PASSWORD` | Password for the base64 P12 certificate | May be empty if that P12 is unencrypted |
| `APPLE_SIGNING_IDENTITY` | Developer ID Application identity | Workflow defaults to ad-hoc `-` |
| `APPLE_ID` | Apple account email for notarisation | Notarisation is not configured |
| `APPLE_PASSWORD` | Apple app-specific notarisation password | Notarisation is not configured |
| `APPLE_TEAM_ID` | Apple Developer team identifier | Notarisation is not configured |

Configure the Apple signing/notarisation set together. The workflow omits empty
Apple variables for ad-hoc builds; exporting empty values locally can make Tauri
treat them as configured credentials. The private updater key must remain stable
and backed up: installed clients trust its matching public key.

The Lambda deployment builds its full environment from this workflow. Add
traffic keys as repository secrets, rather than editing Lambda's environment
manually and expecting the next deployment to preserve those edits. Optional
empty traffic secrets are omitted from the deployed environment. The temporary
environment file is private and removed when the deployment step exits.

## Services that currently require no account/key

The current clients use public endpoints for Bureau FTP/Water Data Online,
Queensland WMIP, GA elevation, public Copernicus tiles, DEA water/satellite
products, ABS census data, Overpass/OpenStreetMap, the configured council/state
map services, public tide/rain sources and the PTWC bulletin. Public WA, SA, NT,
Tasmania and ACT road feeds are also wired without user credentials.

No Google Maps key, Mapbox token or paid weather account is used by the current
viewer. Public access still has provider terms, quotas and availability limits;
a signup does not fix a missing archive, CORS restriction or unpublished dataset.

## Future integrations: no working credential field yet

- **Victoria road disruptions:** [Transport Victoria Open Data](https://opendata.transport.vic.gov.au/)
  is a candidate integration. There is currently no Victoria road-fetch job or
  `VIC_*` key consumer in the broker; registering does not enable it.
- **Windows trusted code signing:** the release workflow has no certificate or
  signing-provider integration yet. The Tauri updater signature is already
  supported but is separate from Windows installer trust.
- **Restricted floor-height, levee, IFD and historical warning data:** obtain a
  permitted source or access agreement before defining credentials or download
  code. No generic username/password placeholder enables these datasets.

## Operator verification

1. Record account owners and approval status in the private account register.
2. Use `gh variable list` and `gh secret list` to check configured names (not
   secret values); no live GitHub/AWS account audit was performed for this doc.
3. Run the site build after adding the Google key and confirm connected forecast
   output; check broker `/health` and the Data status panel after traffic setup.
4. Test desktop keys using the local Settings panel and allow the feed's next
   scheduled refresh; an existing cache can delay a new key's first request.
5. Use verification-only desktop builds before following the signed release
   checklist. Review installers and updates before publication.
