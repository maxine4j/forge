# Forge access and application foundation

## Navigation

Forge opens the global [Tasks board](tickets.md#agentic-ticket-board) at `/tasks`.
Global destinations are Tasks, Repos (`/repos`), Costs (`/costs`) and Config
(`/config`). Repository creation, import, retry and browsing live under Repos.
Browser routes under `/projects` are removed without redirects. Internal
repository management APIs keep their `/api/projects` namespace; tickets use
owner-authorized `GET/POST /api/tickets` and ticket-ID routes instead. See the
[workspace navigation contract](workspaces.md#slice-2-integrated-manual-workspace-and-pr-review).

The global header and browser favicon share the Forge anvil mark.
Config's Cost tracking section uses the owner-only settings API to persist local
currency and monthly plan price (AUD and A$30 by default). Validate a supported
currency and a finite, nonnegative amount. Changes affect future turns. Cost APIs are owner-only and
project-independent. See [cost settings](development.md#cost-settings) and
[ticket cost contracts](tickets.md#ticket-cost).

## Shared selection dropdowns

All selection dropdowns use the shared frontend `Dropdown` and `DropdownSurface`
primitives, browser auto popovers and CSS anchor positioning. The dark surfaces
appear above dialogs, flip around their triggers, stay within the viewport and
scroll long lists. Form triggers fill their fields; composer and toolbar triggers
remain compact. Composer autocomplete and disclosure controls are separate.

Single selects are controlled labelled comboboxes with listboxes exposing selected
and disabled options. Options carry a value, display label, plain-text matching
label, optional decorative icon and disabled state; declarative `DropdownOption`
children provide the same data contract. Enter, Space and arrows open the popup.
Arrows and Home/End move the active option without saving; Enter/Space commits.
Case-insensitive prefix typeahead resets after 700 ms and repeated characters
cycle matches. Matching labels can include newline-separated aliases, including
epic keys and titles; currency matching uses codes independently of flag icons.
The active option stays visible. Disabled options are skipped, and disabling a
single-select control or enclosing fieldset dismisses its open popup. Refreshing
options never commits a value, including retained unavailable model values.

Single selection closes and restores trigger focus. Escape dismisses only the
popup, including inside ticket dialogs. Tab dismisses and continues focus traversal
from the trigger. Outside clicks dismiss without moving focus back to the trigger.
The [repository multiselect](tickets.md#ticket-execution-settings) shares the
surface and dismissal contract, retains checkboxes and chips, supports keyboard
navigation and repository-name typeahead, and keeps the popup open for toggles,
including while immediate saves temporarily disable its controls and then restore
checkbox focus when the user has not moved elsewhere.
See [epic membership](tickets.md#epics-and-grouped-backlog) for icon and save behavior.

## Shared notifications

The application-level React `ToastProvider` exposes `useToast().notify(message,
variant?)`, with `error` as the default variant and `success` for existing repository
success notifications. Queue state lives in memory across route changes. API clients
do not notify. Views report browser-safe errors at the failed request or validation
attempt, suppress aborted and stale responses, and retain local state for loading,
validation styling and retry controls. Native form validation also uses the shared
notification. Saved failure explanations announce once on display or a meaningful
change; unchanged polling snapshots and rerenders do not repeat them. Failed status
indicators, historical conversation and log content remain in their relevant views.
Retained hidden views use `ToastVisibility` to suppress background notifications;
saved failures announce when their view becomes visible.

One toast is visible at a time. Distinct messages queue in arrival order and each
receives three seconds starting when visible. Exact message matches merge across
the active entry and queue: the first shows its original text, then `2x message`,
`3x message`, and so on. An active repeat restarts its full timeout and subtle
background sweep; a queued repeat keeps its position. Click, tap, Enter or Space
dismisses the focused toast and advances the queue. Removed messages start fresh
at count one. Retry controls and drafts survive expiry. Teardown clears timers,
listeners and queue state.

The clipped viewport slides the next toast upward over 180ms. Queued messages are
absent from the accessibility tree; active errors use an atomic alert live region.
The focusable dismissal button never takes focus automatically or submits/closes
the surrounding dialog. Reduced motion removes entry and sweep animation while
keeping the timeout. Default placement is bottom-left with 16px spacing, safe-area
insets and a 420px maximum width constrained to the visual viewport. At widths up
to 600 CSS pixels, visible chat composers register an anchor: the toast sits 8px
above the entire composer, including controls. Resize, scroll, visual viewport,
keyboard and chat visibility changes recalculate placement; hidden chats cannot
anchor. Tablets and laptops retain bottom-left placement.

Native modal open/close lifecycle registers the topmost active dialog as the toast
host. The single viewport uses a manual popover to escape clipping and remain
interactive above nested dialogs. Rehosting preserves the queue and deadline.
See [workspace notifications](workspaces.md#slice-2-integrated-manual-workspace-and-pr-review),
[agent chats](agents.md#interactive-agents), [ticket workflow](tickets.md#agentic-ticket-board)
and [pipelines](git-and-ci.md#manual-local-pipelines).

## Account login and application access

Retain the account setup experience from `codex-runner`, without remote-device
pairing:

- Provide ChatGPT account sign-in in Forge: verification link, one-time code,
  pending/completed/failed states, cancellation, and retry.
- Prefer app-server's structured `chatgptDeviceCode` login operation rather than
  parsing Codex terminal output. Use only fields supported by the pinned version;
  do not fabricate expiry values.
- Retain the GitHub `gh` account login flow for repository pushes and Actions
  access, with verified account status and actionable failures.
- Persist Codex and GitHub credentials in restricted volume directories. Do not
  expose credentials or raw CLI diagnostics in API responses or browser events.
- Account device-code authentication is distinct from remote-device pairing.
  Do not implement mobile pairing codes, remote-control enrollment, or paired
  device management: users interact with agents through Forge's web GUI.
- Initially deploy as a private, single-owner application behind authenticated
  PaaS HTTPS ingress. Validate browser origins for mutations and WebSockets.
- Forge access, ChatGPT login, GitHub login, and Git HTTPS credentials are separate
  concerns. Implement explicit authorization for terminal, file, review, and Git
  operations; do not assume upstream ingress supplies an application actor.
- Authenticated Git HTTPS access must work for ordinary Git clients. Resolve its
  credential and ingress arrangement explicitly before exposing Git hosting; a
  browser session alone is not a Git credential.

### Slice 1 foundation contract

Forge uses the [PaaS authenticated workload identity
headers](https://github.com/maxine4j/homelab-paas/blob/main/docs/networking-and-auth.md#authenticated-workload-identity-headers).
Private ingress (`public: false`) and no published HTTP host port are mandatory:
Envoy strips client identity headers and supplies `X-WEBAUTH-USER`. Forge validates
that GitHub username and authorizes only the configured `FORGE_OWNER`, compared
case-insensitively. Missing, malformed, duplicate, or disallowed identities fail
closed. Optional email/full-name headers never grant access. These assertions are
trusted only on the private proxy path; Forge does not authenticate direct HTTP
clients. Every mutation and future WebSocket handshake requires the exact
configured `FORGE_ORIGIN` HTTPS origin. Services recheck owner authorization.

Backend foundation configuration:

| Variable               | Contract                                                                          |
| ---------------------- | --------------------------------------------------------------------------------- |
| `FORGE_OWNER`          | Required GitHub username; the single application owner.                           |
| `FORGE_ORIGIN`         | Required canonical HTTPS origin, without path/trailing slash.                     |
| `FORGE_DATA_DIRECTORY` | Absolute persistent directory; defaults to `/data`.                               |
| `FORGE_PORT`           | HTTP listener port; defaults to `8080`; no host publication.                      |
| `FORGE_IMPORT_HOSTS`   | Optional comma-separated exact DNS host allowlist; defaults to no remote imports. |

### Forge settings

The top-level **Config** tab lets the owner choose the
[inference provider for new agents](agents.md#codex-harness-and-lifecycle), set
OpenAI model and thinking defaults, edit multiline instructions for
[ticket planners and implementers](tickets.md#agentic-ticket-board) and the
[container-wide Git identity](development.md#image-and-deployment). Forge stores
these settings in SQLite. Unset agent defaults delegate to Codex. Each instruction field accepts
up to 4,000 characters. Set both Git identity fields or clear both together.

**Version control upstream** contains GitHub sign-in and Git identity.
**Inference provider** contains ChatGPT sign-in and the provider selector.
Older settings default to OpenAI. Ollama requires a model tag and a container-reachable
HTTP or HTTPS Responses API base URL, such as `http://ollama.internal:11434/v1`.
The URL cannot contain credentials, a query, or a fragment. Saving settings
does not contact the Ollama endpoint. Switching providers retains both configurations.

The owner-only `GET /api/settings` and `PUT /api/settings` routes use
`@forge/contracts/settings`. PUT replaces the settings and requires the
configured HTTPS origin. `GET /api/settings/model-options` provides the owner with
the Codex catalog used to validate changes to `defaultAgentModel` and
`defaultAgentReasoningEffort`. Unsupported selections return 400 and unavailable
settings or catalog lookups return 503. The owner can clear both defaults or save
unrelated settings during a catalog outage.

### Repositories and imports

Repository management retains the internal project API: `GET/POST /api/projects`,
`GET /api/projects/:id`, and `POST /api/projects/:id/retry`. Inputs and responses
use `@forge/contracts`. Public project values contain ID, name, creation
timestamp, and `creating/ready/failed` status. Ready projects eligible for
[upstream sync](git-and-ci.md#sync-with-upstream) also include `upstreamSyncAvailable: true`,
derived from actual Git remote presence, independently of the saved source.
Repository IDs initially
equal project UUIDs. Inputs are limited to a 120-character name and optional
2048-character HTTPS source; JSON bodies are limited to 16 KiB. The initial store
supports at most 1000 projects. Errors expose fixed codes, never credentials,
paths, source URLs, SQL, or subprocess diagnostics. `GET /health` is an internal
liveness endpoint and discloses only `{"status":"up"}`.

Creation persists a `creating` intent before Git operations. Bare repositories are
prepared beneath an owned staging directory and published by rename. An exclusive
sibling claim file reserves staging ownership before directory creation; recovery
can complete interrupted initialization without adopting unclaimed directories.
Ownership markers and bare-repository validation are required before adopting any existing
path. Startup reconciles `creating` intents and verifies `ready` paths before
serving requests. Failures retain intent and data as `failed`; only explicit retry
repeats failed work. Recovery never deletes or overwrites unrelated paths. Import
fetches heads/tags idempotently and preserves the remote symbolic HEAD when
available. Before publication, the validated source is saved as Git remote
`upstream`. Interrupted imports and startup recovery add missing upstream remotes
from saved sources without overwriting existing remote configuration, refs,
objects or credentials. Newly created repositories have no upstream. Git
configuration remains authoritative; no remote URL is exposed by the project API.
Imports do not create a checkout or run hooks/submodules.

Remote import supports credential-free HTTPS on port 443 only, without query or
fragment, against the configured exact host allowlist. The owner must trust the
configured hosts and their DNS/network destinations. Redirects, local paths,
other Git protocols, credential helpers, interactive prompts, hooks, and global
Git configuration are disabled. Each Git command has a 120-second deadline and
1 MiB output bound. Private-repository credentials and authenticated Git HTTPS
hosting are deferred; no Git hosting endpoint is exposed by the foundation.

Pinned Node 24.22.0 was evaluated with built-in SQLite 3.53.4. `DatabaseSync` runs
in a dedicated worker behind an asynchronous contract, with WAL, foreign keys,
full synchronous durability, a five-second busy timeout, serialized requests,
at most 100 statements per transaction, 100 queued requests, and 1000 result rows.
Worker startup/exit failures reject pending operations; close drains accepted work.
Startup must set `umask(0o077)`, create/restrict the data directory to `0700`, and
complete database/schema initialization and project recovery before listening.
The runtime must retain the single-instance `recreate` deployment policy.

The account backend pins `@openai/codex` to `0.164.0`. Its supported account
protocol was checked against that binary's generated JSON schemas and exercised
with a credential-free stdio initialization/account-read integration test. Live
ChatGPT/GitHub sign-in remains a manual validation; automated tests use no live
credentials. One
long-lived private app-server connection initializes once, sends `initialized`,
correlates numeric request IDs, and accepts only the three account operations
needed here. Requests have a 15-second deadline, at most 32 pending requests,
and a 1 MiB maximum JSON frame. A malformed frame, process exit, or missed
deadline rejects pending work and invalidates the connection; no request is
replayed. Status polling may reconnect and read actual account state, but never
starts login or agent execution.

Account APIs are `GET /api/accounts` and
`POST /api/accounts/:provider/{login,retry,cancel}`, where provider is `codex` or
`github`. Mutations accept no fields. They use the same owner and origin policy
as project APIs. Browser-safe contracts expose provider connection availability,
an optional verified account name, and login state
`idle/pending/completed/failed/cancelled/uncertain`. Only pending states carry a
validated provider verification URL and one-time code; expiry is not fabricated.
Failures contain fixed actionable codes: `unavailable` (check CLI installation
and credential-home permissions), `verification-failed` (check connectivity and
account access), `login-failed` (request a fresh code and check device-login
settings), or `connection-lost` (outcome uncertain; verify then explicitly cancel
or retry). Raw CLI diagnostics remain operator-only. Successful login requires
an actual ChatGPT `account/read` or GitHub `gh api user` result; a completion
notification or zero exit code alone is insufficient.

SQLite `account_login_attempts` stores only pending intent, never codes, IDs or
credentials. Intent precedes login. After application restart, an interrupted
attempt remains uncertain alongside the verified current account until explicit
cancel/retry. An uncertain Codex attempt resets the old app-server connection
before another login; late notifications cannot complete a replacement attempt.
GitHub login uses `gh auth login --web --insecure-storage --scopes workflow`
against `github.com` with HTTPS Git. The `workflow` scope supplements the CLI's default scopes so
authenticated pushes can update `.github/workflows/*`, including through
[Code tab sync](git-and-ci.md#sync-with-upstream). Each owner-initiated
login requests this scope; existing credentials are preserved without automatic
refresh or scope detection. Login validates the known device prompt, bounds
prompt/verification commands to 15 seconds and 64 KiB output, and stops an outstanding login after
a local 15-minute deadline. This deadline is not a provider code-expiry claim.

Account process initialization creates/restricts `/data/codex` and `/data/github`
to `0700` and existing credential files to `0600`. Startup's `0077` umask applies
to new credentials. Codex uses `cli_auth_credentials_store="file"`; GitHub uses
`GH_CONFIG_DIR`. Child environments exclude ambient API keys and GitHub tokens,
so verified account status reflects persistent credentials. One process adapter
owns at most one app-server. Children run in dedicated Unix process groups;
shutdown sends TERM, waits up to one second, then KILLs the group and awaits
direct-child stream closure. A naturally exiting leader also terminates remaining
group members. Descendants that deliberately escape their process group are
outside this boundary; container startup must provide an init process to reap
orphaned descendants. Long-lived Codex stderr retains a bounded 64 KiB diagnostic
tail rather than accumulating without limit. Recreate deployment remains mandatory
to prevent multiple application instances sharing account homes.

Slice 1 serves a responsive React interface from the same application as its API.
Owners can list/create/import/retry repositories and connect ChatGPT/GitHub using
verification links, one-time codes, cancellation, verification and explicit retry.
The Repos list updates automatically. Create repo opens the creation and import
form in a dialog.
Account polling is serialized with actions, aborts on unmount, and never blocks
project use. Failed creation refreshes durable project intent for explicit retry.
All API responses are validated by the browser; device links are limited to the
provider's exact verification page. No editor, terminal, tickets, PRs or agent-turn
UI is included in this slice.

Production startup restricts the data root, initializes SQLite/schema and recovers
projects before listening. Codex initializes asynchronously after HTTP starts;
unavailable account processes/homes do not withhold health or project access.
Account checks/retries reattempt credential-home initialization after permission
repairs. GitHub verification uses bounded, separate stdout/stderr: `gh api
--include user` must return a validated HTTP 200 and username; HTTP 401 means
signed out, other failed verification stays unavailable. Shutdown closes HTTP,
GitHub and Codex before SQLite, in reverse acquisition order. HTTP stops accepting
requests, then cancels owned Git process groups before waiting for request drain;
SQLite remains available to persist failed import intents. Git helpers are also
terminated on leader exit and the 120-second deadline, with a 1 MiB combined
output bound and injected timers. Interrupted startup recovery finishes recording
its result before database closure. Expected process
shutdown does not report a provider failure. Partial startup and listener errors
exit unsuccessfully after registered cleanup.

Built assets require owner access, reject traversal/symlinks, and serve only
approved public file types. Navigation falls back to the frontend; unknown
`/api` paths return JSON 404 and missing assets never fall back. Hashed assets
use private immutable caching; HTML/API responses use no-store. CSP permits
same-origin scripts and styles, allows inline style elements needed by the editor
and terminal, and blocks framing; device pages open separately. The explicit
`style-src-elem 'self' 'unsafe-inline'` exception does not authorize inline scripts,
eval or inline style attributes. Browser validation configures Zod's supported
`jitless` mode before loading schemas, avoiding its eval capability probe.
