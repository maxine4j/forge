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
- SQLite holds repositories (internally `projects`), board-owned tickets and ordered
  repository associations, plan revisions, PRs, reviews, jobs, execution
  state, Codex identifiers, pipeline runs/jobs/steps, and durable application events.
- Codex owns its conversation history and execution state in its persistent home;
  SQLite stores the identifiers and normalized state needed by Forge. Do not
  invent a second authoritative conversation store.
- Store larger attachments and execution artifacts outside SQLite.
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
├── AGENTS.md
├── docs/
├── package.json
├── Dockerfile
├── forge.sd.yaml
├── tsconfig.json
├── tsconfig.build.json
├── packages/
│   ├── backend-infrastructure/   # Backend side effect boundaries
│   ├── contracts/
│   │   ├── package.json
│   │   └── src/                    # Browser-safe schemas and DTOs
│   └── frontend/
│       ├── package.json
│       ├── vite.config.ts
│       └── src/
│           ├── app.tsx
│           ├── main.tsx
│           ├── api/
│           ├── components/
│           └── features/
│               ├── setup/          # ChatGPT and GitHub login
│               ├── projects/
│               ├── board/
│               ├── repository/     # Files, branches, commits
│               ├── workspace/      # Integrated development screen
│               ├── agents/
│               ├── editor/
│               ├── terminal/
│               ├── diff/
│               └── pull-requests/
├── src/
│   ├── main.ts
│   ├── start.ts
│   ├── config/
│   ├── http/                       # Server, errors, assets, health
│   ├── auth/                       # Forge access/session policy
│   ├── projects/
│   ├── repositories/               # Git hosting, browsing, ref policy
│   ├── tickets/                    # Board and transition rules
│   ├── plans/                      # Plan revisions and approval
│   ├── pull-requests/              # Work review, comments, merge
│   ├── workspaces/                 # Worktrees and file access
│   ├── terminal/                   # PTY lifecycle and socket adapter
│   ├── agents/
│   │   ├── agent-router.ts
│   │   ├── agent-service.ts        # Ticket-to-Codex orchestration
│   │   ├── agent-run-store.ts
│   │   └── types.ts
│   ├── codex/
│   │   ├── codex-process.ts
│   │   ├── codex-connection.ts
│   │   ├── codex-client.ts
│   │   ├── codex-login-service.ts
│   │   ├── codex-event-mapper.ts
│   │   └── types.ts
│   ├── github/                     # gh login and pushes
│   ├── pipelines/                  # Manual act execution, snapshots, state and recovery
│   ├── jobs/                       # Scheduling and restart recovery
│   ├── events/                     # Durable events and live delivery
│   ├── database/                   # SQLite and initial schema
│   └── artifacts/
└── tests/
    ├── integration/
    └── e2e/
```

The pnpm workspace includes `packages/*`. Frontend code imports only browser-safe
contracts, never backend implementation modules.

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
act adapter under `src/pipelines`. Startup initializes storage, interrupts unfinished
runs and reconciles disposable resources; shutdown stops owned process groups.
Run metadata/jobs/steps live in `pipeline_runs`; disposable source and bounded
diagnostics live under `artifacts/<runId>`. See [the pipeline contract](git-and-ci.md#manual-local-pipelines).

Automated tests must not require live ChatGPT or GitHub credentials. Separately
report manual verification of real login, Codex execution, remote CI, and credential
persistence when those integrations are implemented.
