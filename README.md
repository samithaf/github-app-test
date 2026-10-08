# github-app-credential-test

Checks that a GitHub App / GitHub Enterprise App credential set actually works, one step at a time.

It verifies, in order:

1. the private key parses and can sign a RS256 JWT
2. `GET /versions` - the configured API version is supported by the host (informational; warns but does not fail)
3. `GET /app` - the app id and the private key are a matching pair
4. `GET /app/installations[/{id}]` - the installation exists
5. `POST /app/installations/{id}/access_tokens` - an installation token can be minted
6. `GET /installation/repositories` - the token works, and every accessible repository is listed (all pages are fetched)

## Requirements

- Node >= 22.9 (runs TypeScript directly, no build step)

## Setup

```bash
npm install
cp .env.example .env
# fill in GITHUB_APP_ID and GITHUB_APP_PRIVATE_KEY
```

`GITHUB_APP_PRIVATE_KEY` accepts either a path to the `.pem` file or the PEM contents
inline (literal `\n` sequences are unwrapped automatically). Both PKCS#8
(`BEGIN PRIVATE KEY`) and PKCS#1 (`BEGIN RSA PRIVATE KEY`) keys are supported.

## Run

```bash
npm run check
```

Against a GitHub Enterprise Server instance:

```bash
GITHUB_HOST=github.acme.com npm run check
```

Machine-readable output:

```bash
npm run check -- --json
```

Requests are sent with `X-GitHub-Api-Version`, defaulting to the newest GitHub
API version (`2026-03-10`). If your GHE host only supports an older version,
set `GITHUB_API_VERSION` (e.g. `2022-11-28`); a value that is not supported is
reported as a warning against `GET /versions`. The `410 Gone` error means the
resource is gone, or the configured API version has closed down.

## Environment variables

| Variable | Required | Description |
| --- | --- | --- |
| `GITHUB_APP_ID` | yes | App id from the app settings page |
| `GITHUB_APP_PRIVATE_KEY` | yes | Path to the `.pem`, or the PEM contents inline |
| `GITHUB_INSTALLATION_ID` | no | Installation to test; otherwise the first installation is used |
| `GITHUB_HOST` | no | `github.com` (default) or a GHE host such as `github.acme.com`; `http://` is honoured if given (useful against a local mock) |
| `GITHUB_API_VERSION` | no | REST API version header, default `2026-03-10`; a date such as `2022-11-28` |
| `GITHUB_TIMEOUT_MS` | no | Per-request timeout, default `15000` |

## Exit codes

| Code | Meaning |
| --- | --- |
| `0` | every check passed |
| `1` | at least one check failed (details and a hint are printed) |
| `2` | configuration problem (missing env var, unreadable key file) |

## Failure hints

- `HTTP 401` on `GET /app` - the JWT itself was rejected: clock skew, or the PEM is not a valid private key.
- `HTTP 404: Integration not found` on `GET /app` - the app id and private key are not a recognised pair.
- `HTTP 404` on the installation step - wrong `GITHUB_INSTALLATION_ID`, or the app is not installed on that host.
- `HTTP 403` - the app lacks the required permissions, or SAML SSO has not authorized the app.
- `HTTP 410` - the app was deleted, or the configured `GITHUB_API_VERSION` is no longer supported (check `GET /versions`).
- network errors - check `GITHUB_HOST`, DNS/VPN, and TLS (GHE often uses an internal CA).

## Style

The source follows the [Google TypeScript Style Guide](https://google.github.io/styleguide/tsguide.html).
Run `npm run typecheck` (strict `tsc --noEmit`) after changing it.

Two deliberate deviations, each commented where it occurs:

- API response interfaces keep GitHub's `snake_case` field names so the JSON can
  be read without a mapping layer.
- `GitHubApiError` assigns its fields in the constructor instead of using
  parameter properties, because Node's TypeScript type stripping rejects
  parameter properties.
