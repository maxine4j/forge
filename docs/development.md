# Forge development and deployment

## Development checks

Run `nvm use` from the repository root before the following commands:

```sh
pnpm install --frozen-lockfile
pnpm check
pnpm test
pnpm test:integration
pnpm build
pnpm test:browser
pnpm image
pnpm test:image
```

Browser tests use controlled API responses in Chromium, including mobile layout,
account setup states and project recovery controls. They do not claim production
ingress authentication or live login. Install the repository's pinned Chromium
with `pnpm --filter @forge/frontend exec playwright install chromium` if
needed. Screenshots/diagnostics live under ignored `artifacts/forge*/`.
The image smoke uses a disposable Docker volume and internal container HTTP,
with no host ports. It checks nonroot execution, restricted directories, real
Git/SQLite recovery, synthetic credential-home file persistence, bundled Codex
initialization/account-read, shipped gh flags and signed-out verification,
the exact `nvm use >/dev/null && pwd` command under Codex's shell environment,
orphan reaping, graceful signals, partial startup and listener failures. A separate
composition test uses a controlled Git CLI peer for a hanging remote fetch:
real HTTP/SQLite shutdown cancels its group and preserves a failed project for
explicit retry. It does not claim a live remote import or bypass HTTPS validation.
The gh
signed-out check reaches GitHub's credential-free `/user` endpoint; it needs
network connectivity. It never performs a real login. Real credential persistence
and successful live ChatGPT/GitHub login remain manual checks.

`pnpm dev` builds the workspace and watches the backend;
set `FORGE_OWNER`, `FORGE_ORIGIN` and an absolute writable `FORGE_DATA_DIRECTORY`
first. This is a private proxy workload: browse through authenticated HTTPS PaaS
ingress. The standalone Vite server is used for controlled browser tests; it does
not inject a trusted application identity or provide an alternative login.

For isolated frontend iteration, run `pnpm dev:mock` from the repository
root and open `http://127.0.0.1:5174`. This builds only Forge's browser contracts
and starts Vite in explicit `mock` mode; no backend, database, credentials, or
container is required. A visible banner identifies the read-only preview.
Vite serves deterministic HTTP fixtures for projects, accounts, repository
branches/files/history, project workspaces, changes, pull-request reviews and
project chat history with clarification requests.
Both sample projects can be opened. File navigation and client-side editor drafts
work; all API mutations return 405 and no terminal session or
WebSocket execution is provided. Unknown API paths, identities, branches and
files return JSON 404 responses. Fixtures are not persisted. Normal Vite mode
does not install the mock routes, and production builds exclude the mock API
and banner, including builds invoked with `--mode mock`.

## Cost settings

The [Cost tab](agents.md#cost-and-usage) uses `FORGE_CODEX_MONTHLY_AUD` for the
monthly subscription amount (default A$30). Update it when the plan price changes.
Forge retains the configured amount with each recorded turn.

API equivalents use the same dated FX rate throughout the dashboard. Set
`FORGE_COST_AUD_PER_USD` and `FORGE_COST_EXCHANGE_DATE` (YYYY-MM-DD) together to
override the default of 1 AUD / 0.6924 USD from the
[RBA's 10 November 2026 release](https://www.rba.gov.au/statistics/frequency/exchange-rates.html).
The [model rate table](../src/cost/api-pricing.ts) records the pricing snapshot.
The read-only frontend preview includes sample usage and quota data.

## Image and deployment

The runtime uses a digest-pinned `docker/sandbox-templates:codex` base. It retains the
template's preinstalled development tooling, including Git, gh, Python, Go and uv,
and runs as `agent`, UID/GID 1000. Forge supplies its tested Node 24.22.0 runtime,
lockfile-pinned Codex 0.164.0 (first on PATH), nvm 0.40.8 and the template's tini
as PID 1. Nvm lives at
`/opt/nvm`, writable by the runtime user, with Node 24.22.0 preinstalled and set
as its default. The global Bash login profile loads it even with Codex's
`HOME=/data`; `/bin/bash -lc 'nvm use >/dev/null && pwd'` works in a project
whose `.nvmrc` selects that version. Other Node versions require an explicit
`nvm install` and network access; the image does not auto-install project versions.
Additional nvm versions are ephemeral container files; `/data` remains persistent.
The supplied system Node still runs Forge itself. Template digest or dependency
changes require revalidation. Tini
reaps orphaned descendants. Process-group cleanup covers ordinary descendants;
deliberately escaped live processes are outside that application-level boundary.

`forge.sd.yaml` uses private ingress, one replica, recreate rollout and persistent
`/data`, with no HTTP host ports. Its deployment defaults set `FORGE_OWNER` to
`maxine4j`, derive `FORGE_ORIGIN` from `https://${SERVICE_DOMAIN}`, and allow
credential-free HTTPS imports from `github.com` through `FORGE_IMPORT_HOSTS`.
No owner secret file is required. The production cluster must allow `maxine4j`
through its GitHub login and provide authenticated HTTPS ingress on port 443.
For another deployment, edit the literal owner, origin or exact DNS import
allowlist as appropriate; an empty import allowlist disables remote imports.
The [PaaS service secret file](https://github.com/maxine4j/homelab-paas/blob/main/docs/configuration.md#environment-variables-and-secrets)
can supply an environment value only when its descriptor entry uses `secret: true`;
undeclared secret-file entries are not injected. Keep credentials out of literal
descriptor values. Private-repository imports remain unsupported, including after
GitHub account sign-in.
Build locally with `pnpm image`. GitHub Actions publishes
`ghcr.io/maxine4j/forge` after the checks pass. A push to `main` publishes
the full commit SHA and `latest`. A `vX.X.X` tag publishes the full SHA and
release tag. The root descriptor selects the image by its full commit SHA.
Configure the platform to read the descriptor from this repository and retain
the [Forge ingress trust boundary](foundation.md#slice-1-foundation-contract).
