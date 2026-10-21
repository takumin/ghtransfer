# ghtransfer

[![CI](https://github.com/takumin/ghtransfer/actions/workflows/ci.yml/badge.svg)](https://github.com/takumin/ghtransfer/actions/workflows/ci.yml)
[![License](https://img.shields.io/badge/license-Apache--2.0-blue.svg)](LICENSE)

A Cloudflare Worker that, once a day, transfers every archived repository a personal
account owns to an organization set aside for archives.

## How it works

On each cron trigger (`0 19 * * *`, 04:00 JST) the Worker:

1. Exchanges the refresh token stored in KV for a fresh user access token, and stores
   the refresh token GitHub returns in its place.
2. Lists the repositories the source owner owns (`GET /user/repos`, so private ones
   are included) and keeps the archived ones.
3. Transfers up to 30 of them to the target owner, one at a time. The rest wait for
   the next run.
4. Writes one structured log entry for the run.

The Worker has no fetch handler and does not answer HTTP requests.

### Why a user access token

`POST /repos/{owner}/{repo}/transfer` accepts user access tokens only; a GitHub App
installation token cannot call it. So the Worker acts as the source owner through a
GitHub App's user authorization. That authorization is limited to the App's
permissions, and its access token expires after eight hours.

GitHub accepts a refresh token only once. The Worker therefore writes the new one to
KV before doing anything else. A refresh token that is not used for six months
expires; the daily run renews it every day.

## Configuration

| Name                       | Kind   | Where            | Meaning                                    |
| -------------------------- | ------ | ---------------- | ------------------------------------------ |
| `SOURCE_OWNER`             | var    | `wrangler.jsonc` | The account whose archived repos are moved |
| `TARGET_OWNER`             | var    | `wrangler.jsonc` | The organization they are moved to         |
| `GITHUB_APP_CLIENT_ID`     | var    | `wrangler.jsonc` | The GitHub App's client ID                 |
| `GITHUB_APP_CLIENT_SECRET` | secret | Workers Secret   | The GitHub App's client secret             |
| `TOKENS`                   | KV     | `wrangler.jsonc` | Holds the current refresh token            |

## Setup

### 1. Create the GitHub App

Under the source account's **Settings → Developer settings → GitHub Apps → New GitHub App**:

- **Webhook**: uncheck **Active**.
- **Enable Device Flow**: check it. The first authorization uses the device flow.
- **Expire user authorization tokens**: leave it checked. Without it GitHub issues
  no refresh token.
- **Repository permissions → Administration**: Read and write. (Metadata: Read-only
  is added automatically.)
- **Where can this GitHub App be installed?**: **Any account**, so that it can be
  installed on the target organization as well as on the source account.

Then generate a client secret, and put the client ID into `wrangler.jsonc`'s
`GITHUB_APP_CLIENT_ID`.

### 2. Install the App

Install it on the source account with **All repositories** (a user access token
reaches only repositories the App is installed on), and on the target organization.

### 3. Deploy and store the secret

```sh
task deploy
task wrangler -- secret put GITHUB_APP_CLIENT_SECRET
```

The first deploy also creates the `TOKENS` KV namespace.

### 4. Seed the refresh token

```sh
task authorize -- <client-id> takumin
```

This runs the device flow (open the printed URL and enter the code), checks that the
authorizing account is the source owner, and stores the refresh token in KV.

Then uncheck **Enable Device Flow** on the GitHub App again. The client ID is public,
so while the device flow is on, anyone can start one and phish you into entering
their code, which hands them a user access token with the App's Administration
permission for eight hours. Check it again only when you re-run `task authorize`.

To try a run without waiting for the cron trigger, run `task dev` and request
`http://localhost:8787/cdn-cgi/handler/scheduled`. Note that this uses the _local_
KV, which has to be seeded separately.

## Observability

Each run logs exactly one entry. Its `outcome` is one of:

| `outcome`               | `level` | Meaning                                                                         |
| ----------------------- | ------- | ------------------------------------------------------------------------------- |
| `completed`             | `info`  | Every archived repository was transferred, or there were none                   |
| `completed`             | `warn`  | Some were deferred to the next run (`deferred`)                                 |
| `completed`             | `error` | GitHub refused at least one transfer (`failed`, e.g. the name already exists)   |
| `missing-credentials`   | `error` | `GITHUB_APP_CLIENT_ID` or `GITHUB_APP_CLIENT_SECRET` is not set                 |
| `missing-refresh-token` | `error` | KV holds no refresh token yet; run `task authorize`                             |
| `internal-error`        | `error` | The refresh, the KV write or the listing threw; the cron event is marked failed |

If the refresh fails with `bad_refresh_token`, the stored token is spent or revoked.
Run `task authorize` again to replace it.

## Development

The toolchain (node, pnpm, task and the linters) is pinned with
[aqua](https://aquaproj.github.io/) under `.aqua/`, and each task installs what it
needs on first use. `.aqua/aqua-checksums.json` locks every package's checksum.

On a glibc Linux host that also has the `musl` package installed, aqua takes the
musl loader for the system libc and picks musl builds of node and pnpm. Set
`AQUA_LIBC=glibc` in that case.

```sh
task          # every CI gate: format, typegen, reviewdog, typecheck, test, build
task test
```

## License

[Apache-2.0](LICENSE)
