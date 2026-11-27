# Forge architecture

## Product and stack

Forge is an all-in-one agentic development platform: local Git hosting, a Kanban
board, pull requests, a browser IDE, and Codex agent interaction in one web GUI.
The global Tasks board owns tickets. Repos manages Git repositories independently;
tickets reference an ordered list and execute in the first selected repository
once it is ready. See
[ticket persistence and execution](tickets.md#agentic-ticket-board) and
[navigation](workspaces.md#slice-2-integrated-manual-workspace-and-pr-review).

- Build using Node.js 24, TypeScript ES
  modules, pnpm, Koa, React, Vite, Zod, Pino, Vitest, Playwright, and Oxc stack.
- Use SQLite for application metadata and local Git repositories for source data.
- Keep the frontend and browser-safe contracts as packages in the workspace.
- Run one Forge Node.js application in one container. The application serves the
  built frontend, HTTP API, live connections, Git HTTPS endpoints, and background
  scheduler. Codex CLI, Git, terminals, and project commands run as child
  processes inside that same container; this is not literally one OS process.
- A root supervisor runs a dedicated Docker daemon alongside the nonroot Forge
  process. Workload containers are disposable and share Forge's trusted-owner
  boundary. Never mount a host Docker socket. See [deployment](development.md#docker-workloads)
  and [Board cleanup](tickets.md#docker-containers).
- Do not add a separate runner service, custom model-provider layer, or custom
  agent tool-execution loop.
- The optional inference path through the [Ollama relay](development.md#ollama-relay)
  forwards the existing Codex provider's Responses traffic to an approved
  local Ollama worker.
- Ask the owner before adding third-party dependencies. Pin Codex CLI and any new
  dependencies to tested versions.

## Layered architecture

```text
HTTP / WebSocket / Git protocol adapters / background tasks
                          |
                    Domain services
                          |
                 Store and client interfaces
                          |
               SQLite / Git / Codex / GitHub / PTY
```

- Entry points validate transport input, call services, and map results and errors.
- Services own authorization, invariants, workflow transitions, and coordination.
- Stores own persistence commands, transactions, serialization, and validation.
- Clients own infrastructure protocols, external-data validation, and translation
  of infrastructure failures into documented caller-facing failures.
- Use classes with constructor-injected interface dependencies. Colocate each
  component's interface with its implementation. Shared module data types belong
  in `types.ts`; shared module errors belong in `errors.ts` when needed.
- Keep framework objects, SQL driver values, and Codex protocol types inside their
  adapters. Public contracts use validated plain values.
- Inject clocks, IDs, timers, configuration, and side effects. No service locators,
  hidden application singletons, or application-module mocks.
- `main.ts` handles process lifecycle. `start.ts` loads configuration, constructs
  dependencies, initializes resources, and registers cleanup.
- Use `@forge/backend-infrastructure` for filesystem, YAML, timer, and logging
  boundaries.

## Persistence and recovery

### Worktree TypeScript intelligence

Forge owns a read-only stdio MCP bridge under `services/forge/src/typescript-lsp`, with separate
MCP, language-client, runtime-resolution and process adapters. `main.ts`/`start.ts`
own construction and lifecycle; filesystem, timers and process boundaries are
injected. No shared language-server state or new persistence/API is introduced.
Each bridge verifies its canonical root against process cwd. Every compiler uses
that cwd and that exact LSP root/workspace folder, even when its installation is
symlinked into a package-manager store. See [tools and lifecycle](agents.md#worktree-typescript-tools),
[workspace release](workspaces.md#language-server-release) and
[verification/packaging](development.md#typescript-mcp-verification).

### Private request telemetry

Forge owns a separate ephemeral-port HTTP listener bound exclusively to
`127.0.0.1`, outside its public API/router. The owned Codex process exports OTLP
JSON logs and traces to this receiver using an ephemeral authentication header;
neither its endpoint nor credential enters browser contracts. Prompt and response
logging is disabled. Startup constructs and closes the listener through the
existing process lifecycle in `start.ts`/`main.ts`.

Injected telemetry/store interfaces keep parsing, correlation and aggregation
separate from startup and billing. SQLite's additive `agent_request_performance`
table persists normalized request samples with idempotent identities;
`agent_performance_fragments` stores only allowlisted correlation identities,
source timestamps and counters needed for reordered/delayed exports. Raw account,
prompt, response and tool content is discarded at ingestion. Samples survive
worktree cleanup and restart; no timer runs across an unavailable interval.
See [agent measurement semantics](agents.md#latest-turn-inference-performance) and
[development verification](development.md#request-telemetry-verification).

### Notification metadata

SQLite's additive `ticket_notifications` table stores only source, condition,
monotonic identity and first-observed UTC timestamp. Content and eligible actions
are derived from current workflow records and managed-agent request snapshots;
conversation history is never copied into this table or loaded for the feed.
Workflow saves and agent request writes synchronize metadata independently of
browser selection, using injected clocks. Unresolved identities preserve their
timestamp across restart. Resolved conditions are removed; a recurrence receives
a new identity. Request handles, plan revisions and execution attempts distinguish
conditions. Startup idempotently bootstraps existing pending conditions at first
observation, without inferring historical dates. The owner-only feed validates
DTOs and excludes archived tickets and abandoned/superseded attempts. See
[Tasks navigation and resolution](tickets.md#pending-notifications) and
[agent lifecycle](agents.md#notification-request-lifecycle).

### Persistent resources

```text
/data/
  forge.sqlite
  repositories/{repositoryId}.git/
  worktrees/{workspaceId}/
  codex/
  github/
  artifacts/{runId}/
```

- Git is authoritative for commits, trees, branches, and tags. Bare repositories
  are stored locally on the mounted volume.
- SQLite also stores named model providers with stable IDs, immutable kinds and
  retirement records. Partial unique indexes enforce active names and one OpenAI
  provider. Versioned migration runs before scheduler recovery; phase-specific
  snapshots keep inference routing private and immutable once each phase starts.
  Reusable named Agents live in SQLite and reference providers. Tickets store independent
  Planner and Implementer IDs in their execution-settings JSON. Phase pins preserve the
  resolved model and thinking level with provider routing before external setup. See [ticket settings](tickets.md#ticket-execution-settings),
  [provider APIs](foundation.md#model-providers), [execution](agents.md#codex-harness-and-lifecycle)
  and [upgrades](development.md#named-provider-upgrades).
- SQLite holds repositories (internally `projects`), board-owned tickets and ordered
  repository associations, plan revisions, PRs, reviews, jobs, execution
  state, Codex identifiers, pipeline runs/jobs/steps, and durable application events.
- Codex owns its conversation history and execution state in its persistent home;
  SQLite stores the identifiers and normalized state needed by Forge. Do not
  invent a second authoritative conversation store.
- Cost records have an indexed ticket ID and unique `(threadId, turnId)` identity;
  repository ID is execution metadata. Immutable dispatch snapshots retain
  provider identity, billing, model token pricing and historical FX context,
  including the AUD rate when the billing currency differs. OpenAI USD costs
  persist with usage. Ollama turns retain an independent OpenAI pricing benchmark
  and stay outside account quota allocations.
  SQLite also owns the four-hour exchange-rate cache, raw quota observations and
  idempotent interval allocations. Inject exchange client/cache interfaces and
  serialize quota collection independently of dashboard reads. See
  [cost attribution](agents.md#quota-cost-attribution),
  [ticket costs](tickets.md#ticket-cost) and [billing](development.md#cost-settings).
- Store larger attachments and execution artifacts outside SQLite.
- Epics have an independent SQLite key sequence (`EPIC-n`); tickets use `TASK-n`
  and an indexed nullable foreign key to an epic. Epic completion is derived from
  non-archived children, never persisted. Epic store/service/router modules live
  under `src/epics`; membership updates use the ticket workflow serialization and
  scope transaction. See [epic contracts](tickets.md#epics-and-grouped-backlog) and
  [development database care](development.md#development-databases).
- Ticket history is append-only SQLite data, initialized additively. Status visits
  and workflow milestones share the transactions that persist their state.
  Existing tickets receive only their known status at recording start; historical
  transitions are not inferred. See [ticket history](tickets.md#ticket-history).
- Use SQLite WAL mode, foreign keys, bounded transactions, and serialized writes
  on a local filesystem. Expose an asynchronous database contract. Evaluate the
  pinned Node release's built-in SQLite support before selecting an adapter.
- Git, SQLite, and GitHub cannot share a transaction. Persist operation intent,
  execute with idempotency or explicit reconciliation, and record completion.
- Recover interrupted repository creation, execution, pushes, and merges at
  startup. Never blindly repeat an agent turn after losing its connection.
- Preserve repositories, credentials, and user data when removing runtime
  resources. Worktrees become disposable only after preserving relevant work.
- Use `recreate` deployments so two Forge instances never operate on the same
  database, worktrees, or Codex home during an update.

## Alternatives, constraints, and delivery order

| Choice                                | Tradeoff                                                                                                     |
| ------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| One application/container             | Simple deployment and ownership; all child processes share resources and a trust boundary.                   |
| Codex app-server                      | Reuses the supported agent harness; requires protocol pinning, event mapping, and lifecycle recovery.        |
| Local Git plus SQLite                 | Meets local ownership requirements; requires reconciliation across Git, database, and remote effects.        |
| Custom TypeScript forge               | Coherent stack and workflow; Git hosting and review correctness remain substantial implementation work.      |
| Forgejo-backed application            | Mature hosting, but adds another application/runtime and split ownership; outside the selected architecture. |
| Lightweight editor such as CodeMirror | Fits basic editing/highlighting; new dependency requires approval.                                           |
| Monaco                                | Richer editor foundation with greater integration weight; not required for initial scope.                    |

Worktrees isolate working files, not processes or shared Git metadata. Do not claim
hostile multi-tenant isolation or that branch protection prevents arbitrary shell
commands from mutating accessible storage. Use Codex's supported workspace sandbox
and approval controls where verified in the pinned runtime; do not automatically
copy `codex-runner`'s full-access defaults. Privileged Docker-in-Docker expands the
trust boundary to the host kernel even though Forge and its agents remain UID/GID 1000. Avoid passwordless sudo and additional privileges. Define
resource/output/time limits for child processes. Local pipelines share CPU,
memory and disk with dependency installation, agent commands and terminals.

Deliver in slices:

1. Local projects, Git repositories, SQLite, account setup, and Codex connection.
2. Manual workspace editor/terminal/diff and PR review workflow.
3. Ticket scheduling, Codex planning, and plan review.
4. Agent implementation, live interaction, approvals, and recovery.
5. Manual local GitHub Actions pipelines through act; merge gating is a later slice.

## Expected source and package structure

Organize backend modules by capability, with service/store/client boundaries within
each module. Do not introduce empty abstractions solely to fill this tree.

```text
forge/
├── forge.sd.yaml                  # Compose Forge and the Ollama relay
├── package.json                   # Workspace commands and shared tools
├── pnpm-workspace.yaml
├── pnpm-lock.yaml
├── tsconfig.json                  # Shared compiler options
├── docs/
├── packages/
│   ├── backend-infrastructure/    # Shared Node.js adapters
│   └── contracts/                 # Browser-safe schemas and DTOs
└── services/
    ├── forge/                     # Backend, integration tests, and Dockerfile
    ├── forge-web/                 # React web GUI, built into the Forge image
    ├── ollama-relay/              # Pairing and inference proxy, with Dockerfile
    └── ollama-client/             # CLI for the machine running Ollama
```

The pnpm workspace includes `services/*` and `packages/*` and uses a single
lockfile. Forge serves the built web GUI. The Ollama relay and client share
pairing transport code through `@forge/backend-infrastructure`. See
[build and deployment commands](development.md#commands).

Colocate unit tests with components. Use injected fakes for service tests, real
local Git/SQLite for adapter integration tests, and controlled protocol peers for
Codex connection/event/recovery tests. Cover account login without live credentials.

Prioritize job claiming and restart recovery, worktree creation, diff semantics,
file-save conflicts, terminal lifecycle, branch protection, approval invalidation,
and exact-tested-commit merging. The central E2E scenario is:

```text
create repository -> board ticket -> select repositories -> ready ticket -> review plan -> agent implementation
-> Forge fast-forward merge -> done
```

See the [ticket workflow](tickets.md#agentic-ticket-board) for the board and
automatic merge queue. The [Git and CI contract](git-and-ci.md) describes the
manual local pipeline workflow.

Local pipelines use a service, SQLite store, Git snapshot client and streaming
act adapter under `services/forge/src/pipelines`. Startup initializes storage, interrupts unfinished
runs and reconciles disposable resources; shutdown stops owned process groups.
Run metadata/jobs/steps live in `pipeline_runs`; disposable source and bounded
diagnostics live under `artifacts/<runId>`. See [the pipeline contract](git-and-ci.md#manual-local-pipelines).

Automated tests must not require live ChatGPT or GitHub credentials. Separately
report manual verification of real login, Codex execution, remote CI, and credential
persistence when those integrations are implemented.
