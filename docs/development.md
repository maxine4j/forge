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
Epic coverage includes grouped unfinished rows, empty/completed sections, dialog
editing and child navigation, membership selectors, polling, keyboard disclosure,
storage recovery and mobile layouts. See [the epic contract](tickets.md#epics-and-grouped-backlog).
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
container is required.
Vite serves deterministic HTTP fixtures for projects, accounts, repository
branches/files/history, project workspaces, changes, pull-request reviews and
project chat history with clarification requests. Tasks includes sample epics
and ticket planning conversations. Board settings includes two
sample running containers with resource statistics.
Commit history opens shareable commit pages with parent navigation, structured
replacement hunks, renamed files, mode changes and binary placeholders. Preview
fixtures support unified/split rendering and whitespace filtering. Commit browser
coverage captures desktop/mobile screenshots under `artifacts/forge-browser/`.
Both sample projects can be opened. File navigation and client-side editor drafts
work; all API mutations return 405 and no terminal session or
WebSocket execution is provided. Unknown API paths, identities, branches and
files return JSON 404 responses. Fixtures are not persisted. Normal Vite mode
does not install the mock routes, and production builds exclude the mock API
even when invoked with `--mode mock`.

## Development databases

SQLite stores cost snapshots, epics, nullable ticket membership and independent
`TASK-n` and `EPIC-n` sequences. Ticket history initializes its tables additively
and bootstraps existing tickets idempotently; see [history recording](tickets.md#ticket-history).
This describes history initialization, without claiming migrations for unrelated
older schemas.

For an optional development reset, stop Forge and move `forge.sqlite`,
`forge.sqlite-wal` and `forge.sqlite-shm` together to a backup outside the active
data directory. Preserve repository/worktree directories and credential homes;
resource removal never erases them. Never delete an active database or credential
homes as part of an upgrade. Use an isolated data directory for throwaway tests.
See [architecture](architecture.md#persistence-and-recovery) and
[the board schema](tickets.md#agentic-ticket-board).

## Local pipeline verification

The image bundles checksum-verified act v0.2.97 for amd64/arm64 alongside the
existing Docker supervisor and nonroot application. Pipelines use digest-pinned
Ubuntu runner images on the internal daemon. Downloads require network access
but no live account credentials. See [the runtime limitations and APIs](git-and-ci.md#manual-local-pipelines).
Unit, real Git/SQLite integration and controlled browser tests cover discovery,
pinning, lifecycle, persistence, authorization, status parsing and polling.
The privileged image smoke also exercises real act workflows and runner Docker
commands against the internal socket, failed execution and recovery.

## Cost settings

Owner-only Config and `GET/PUT /api/settings` persist `localCurrency` and
`monthlyPlanLocal`, defaulting to AUD and A$30. The currency must be one of the
supported billing currencies and price must be finite and nonnegative. Changes
apply to future turns. AUD-specific billing environment settings are removed.

The injected exchange-rate client uses Frankfurter's documented
[`/v2/rate/USD/{currency}` API](https://frankfurter.dev/llms.txt).
An injected SQLite cache retains publication date separately from fetch time,
expires after four hours and coalesces concurrent refreshes. USD uses rate 1.
Expired rates are never used on failures: usage and API USD costs remain available,
while conversion and effective costs are explicitly unavailable. Each dispatch
persists its billing/FX/model-rate snapshot. The
[model table](../src/cost/api-pricing.ts) supplies USD rates per million tokens.

Controlled HTTP, SQLite, unit, integration and browser tests require no live
credentials or FX service. They cover cache hits/expiry/persistence, provider
outages, concurrent refresh, immutable dispatch snapshots, repeated notifications,
phase isolation, weighted quota conservation, unavailable inputs and mixed
historical currencies. Preview fixtures show all three metrics and phase costs.
See [agent usage](agents.md#cost-and-usage), [ticket costs](tickets.md#ticket-cost)
and [settings access](foundation.md#navigation).

## Image and deployment

The runtime uses a digest-pinned `docker/sandbox-templates:codex` base. It retains the
template's preinstalled development tooling, including Git, gh, Python, Go and uv,
and runs the application as `agent`, UID/GID 1000, under a root Docker supervisor.
Forge supplies its tested Node 24.22.0 runtime,
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

### Docker workloads

The image bundles Docker Engine/CLI 28.5.2, Compose 2.39.4 and Buildx 0.28.0,
without adding application dependencies or removing development tools. Tini stays
PID 1; `main.ts` composes a privileged supervisor which starts dockerd as root and
Forge as UID/GID 1000 with supplementary groups cleared. Docker startup or runtime
failure leaves HTTP and [Board controls](tickets.md#docker-containers) available.
Shutdown allows Forge 18 seconds before Docker's 7 seconds, within the deployment's
30-second timeout. Docker is not automatically restarted after failure.
The pinned Docker image's `dind` helper prepares nested cgroups and mount
propagation before executing the daemon.

`resources.app.privileged: true` is the agreed descriptor contract. Deployment
requires the owner's separate PaaS implementation of that field first. Local
image smoke tests require a Docker host able to run `--privileged` containers.
Privileged DinD and agent access to its root daemon expand Forge's trust boundary
to the host kernel, despite the application remaining nonroot; this is trusted
owner execution, not hostile workload isolation. See [architecture](architecture.md)
and [agent execution](agents.md#interactive-agents).

Docker listens only on `unix:///run/forge/docker.sock` (agent group, mode 0660).
No host socket mount or Docker TCP listener is configured. Backend CLI calls
always use that endpoint, with curated environments, argument arrays, a 4 MiB
output limit and 15-second deadlines (120 seconds for pruning). Workspaces used
as bind mounts refer to paths inside Forge, so `/data/worktrees/...` is available
to the internal daemon. Cleanup never traverses or deletes bind-mounted paths.

Daemon data lives at `/var/lib/forge-docker` and runtime state under
`/run/forge-docker`, outside persistent `/data`. Startup removes those fixed roots,
the socket and pidfile before starting dockerd. No Docker storage volume is
declared, persistent or anonymous. Restart and container replacement discard
workloads, images, volumes and caches while preserving `/data` and credentials.
The classic image store is selected explicitly with `containerd-snapshotter=false`
and the VFS storage driver. VFS copies complete layers, with substantially higher
disk usage and I/O costs than copy-on-write drivers; watch the outer writable
filesystem's capacity. No automatic resource limits or ticket cleanup are implied.

The privileged image smoke covers nested builds, Compose, networking, bind mounts,
statistics, both cleanup modes, shared-resource survival, the internal socket,
UID 1000, restart disposal and persistent data/credentials. These require real
privileged Docker validation; mocked browser and service tests cannot prove them.

The image includes a Forge-managed identity file from Git's system configuration.
Saving a name and email in [Config](foundation.md#forge-settings) updates the
default author and committer for new Git commands across the container, including
all Codex agents and workspace terminals. Normal Git configuration precedence
applies in shells. Forge's restricted Git commands receive the same identity
explicitly. The application restores the identity from SQLite before serving
requests after container replacement. Native development leaves the host's Git
configuration alone.

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
`ghcr.io/maxine4j/forge` alongside the independent checks and image validation
jobs. Publishing can succeed even when validation fails. A push to `main` publishes
the full commit SHA and `latest`. A `vX.X.X` tag publishes the full SHA and
release tag. The root descriptor selects the image by its full commit SHA.
Configure the platform to read the descriptor from this repository and retain
the [Forge ingress trust boundary](foundation.md#slice-1-foundation-contract).
