# Forge ticket and PR workflow

## Agentic ticket board

Tasks has nested Board and Backlog tabs. `/tasks` opens Board by default;
`/tasks?view=backlog` selects Backlog. Missing or unknown `view` values select
Board. Both preserve `?ticket=:id` for details, reload and browser history,
including existing archived-ticket links from [Costs](#ticket-cost).

Backlog is a compact Key, Title and Status table of non-archived tickets in
Backlog, Ready for development and In progress; Done is excluded. Its visible
count follows shared one-second polling; rows retain API order within epic sections.
Both views use the same collection, create/details dialogs, status transitions,
archive controls and attention/agent indicators. Polling removes completed or
archived rows without closing an open ticket. The table scrolls with a sticky
header and horizontal overflow on narrow screens. Arrow keys, Home and End
select views; ticket-open buttons and dialog tabs support keyboard navigation.
Creation starts in Backlog. Scope and repository selection remain editable only
in Backlog status, regardless of selected view; Ready and In progress retain
their chat workflow. Inline editing, search, sorting, table reordering, bulk
actions, sprints, priorities and assignees are deferred.

See [epics and grouped backlog](#epics-and-grouped-backlog) for grouping and
membership. The board has four columns: Backlog, Ready for development, In progress and
Done. The corresponding API statuses are `backlog`, `todo`, `in-progress` and
`done`. Cards support pointer and touch reordering, edge scrolling and
cancellation. Moving from Backlog to Ready for development is available by
dragging or through the ticket's status menu.

Tickets belong to the global board, independently of repositories. SQLite allocates
immutable global increasing keys (`TASK-1`, ...) across restarts and concurrent
creation. New tickets start in Backlog, where the owner can edit a trimmed title
(1–120 characters), plain-text description (0–4000 characters, default empty), and
ordered `repositoryIds`. Duplicate and unknown references are rejected. Backlog
allows no references. The first selection is the execution repository; additional
selections are references only. The GUI supports adding, removing and reordering
selections. References never filter visibility or determine board position.
There can be at most 1000 active tickets across the board.

Moving to Ready requires a ready first repository. Dispatch revalidates readiness
and records `executionRepositoryId` and `workspaceId` in workflow state. Recovery,
planning, implementation, rebasing and merge reuse that recorded context. Forge
creates one worktree only; reference repositories do not create extra worktrees.
There is one persistent order per column, used by creation, moves, transitions,
completion and queued dispatch. A `beforeId` must name an active ticket in the
destination column. Scope edits and workflow transitions are serialized together.

This is a fresh database contract: tickets have no repository-owner column.
`ticket_repositories` stores ordered references with foreign keys and unique
repository/position constraints; the board index is global. No migration,
conversion or fallback to repository-scoped tickets is supplied. See
[development database recreation](development.md#development-databases).
The owner can archive a ticket from its details panel after confirming. Archived
tickets leave the board and remain in [Costs](agents.md#cost-and-usage).
Forge retains the key, scope, references, status, workflow history and related data. The
ticket and workflow remain readable by ID.
Queued work can be archived before it starts. A running turn, unresolved dispatch
or pending merge must settle before archiving.

| Stage                 | Behavior                                                                                                                                                                                                                                                                                                  |
| --------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Backlog               | The owner writes the scope.                                                                                                                                                                                                                                                                               |
| Ready for development | The scheduler claims the top ticket when an agent slot opens. It reserves the slot before allocating a new ticket worktree from latest local main.                                                                                                                                                        |
| In progress           | A fresh Codex planner proposes a plan. The orange card shows a red notification dot and Chat renders the Markdown plan and accepts feedback. Approve plan applies to the latest completed revision and queues a fresh implementer in the same worktree. Completed implementation goes to the merge queue. |
| Done                  | Forge moves the ticket here after confirming its commit is in local main.                                                                                                                                                                                                                                 |

The scheduler wakes when tickets enter Ready or Done, when an agent slot is
released, and when settings open new capacity. All execution shares a pool with
[standalone chats](agents.md).
Idle chats use no slot. A running agent waiting for structured input or permission
keeps its slot. Standalone message submissions at capacity retain their drafts.
Board and conversation selection have no effect on execution.

**Stop all agents** durably stops ticket dispatch until explicitly resumed and
remains available while dispatch is stopped. `POST /api/board/settings/stop`
returns `settings`, `requested` (interrupt acknowledgments), `recovered`
(executions confirmed stopped or already inactive/missing), and `failed`
(unresolved executions, including acknowledged interrupts still running).
The dialog reports these separately; existing board polling refreshes outcomes.
Repeated Stop attempts reconcile unresolved slots without replaying input or
resetting Codex. Submissions cannot race the stop operation.

[Startup and stop reconciliation](agents.md#interactive-agents) persist settled
execution and invalidate approvals before releasing slots. Stopped or missing
ticket executions become failed/recoverable even without a saved turn ID.
Plans, conversation history, branches and worktrees are retained. Interrupted
work is never automatically replayed or merged; unavailable runtimes retain
uncertain reservations and expose recovery failure for retry.

The ticket-list response derives optional `agentStatus: "queued" | "working"`
without storing it. Ready tickets without a workflow and workflows in `queued`
show a clock, including while dispatch is paused or capacity is exhausted.
Active workspace/thread setup and `dispatching` or `running` workflows show a spinner. A current
planner or implementer in `waiting` for input or permission requires attention.
Completed plans ready for review, failures, uncertain execution and unreadable
agent state also require attention. These cards have an orange background and
border, including on hover, and a solid red dot labelled and titled “Action required”.
Attention takes precedence over the queued clock and working spinner: only one
indicator appears. Idle and merge-queued workflows without attention have no
status icon; Backlog and Done never show one. Git merge activity is excluded.
Notifications remain until the underlying condition resolves; opening or closing
a ticket does not dismiss them. Approving a plan clears its review notification
once implementation is queued. Resolved cards return to normal styling and show
the current queued/working indicator, or none when idle.
The board refreshes these fields with its existing one-second ticket polling.
The noninteractive 16px indicators sit 12px from the bottom and right of the
ticket-open button. The attention dot is 8px, centered in that same slot. Status
icons have labels and tooltips “Agent queued” and “Agent working”. The working icon
remains static when reduced motion is requested.

Board settings apply across the global board and persist in SQLite. The concurrency
limit ranges from 1 to 10 and defaults to 3. Lowering it lets active turns
finish and holds new turns until a slot opens. Pause new tickets keeps Ready
tickets queued while in-progress tickets continue. Stop all agents requests
interruption of active ticket and standalone turns in parallel, reports any
failures, and holds ticket dispatch until explicitly resumed. Completed turns
and queued Git merges can still settle. Standalone chats can be started manually
after the stop request.

The planner receives a short ticket instruction and uses native Codex Plan mode
for every turn. Forge saves completed plan items as numbered revisions. Followup
messages contain the owner's text alone. The implementer receives the approved
plan once, with an instruction to implement and commit on the worktree branch.
The owner can add separate planning and implementation instructions in
[Config](foundation.md#forge-settings). Forge includes them in the respective
initial prompts when starting a ticket-agent conversation.
Planner and implementer histories are separate and Codex owns both. Forge records
turn identity and accepts a plan only from the current planning turn.

Forge checks the completed implementation turn and verifies the worktree is clean,
attached to the owned branch and has a new commit. It persists the candidate
before attempting the [fast-forward-only merge](git-and-ci.md). Git verifies the
candidate branch and the expected main SHA in a ref transaction. If main has
diverged, Forge asks the implementer to rebase onto local main and retries with
the verified rebased commit. Up to three automatic rebase turns are allowed.
Forge recognizes candidates already reachable from main when resuming a merge.

Board moves and workflow changes are transactional. Dispatch intent is durable and
ambiguous turns are reconciled against Codex history without replaying input.
Setup failures can be retried explicitly. Failed agent turns accept owner feedback
when the conversation is idle. Failed Git merges can be retried against the same
verified candidate. After recording Done, Forge removes the clean
[ticket worktree and its merged local branch](workspaces.md#slice-2-manual-workspace-foundation).
Done tickets with a recorded candidate are eligible for cleanup on startup,
including archived tickets. Cleanup preserves uncommitted changes and branches
whose tip changed, and pending cleanup is retried on startup. Chat history remains
readable through Codex.

Browser contracts are exported from `@forge/contracts/tickets`:

| Route                                | Contract                                                                                                                         |
| ------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------- |
| `GET/POST /api/tickets`              | Ordered active tickets with attention flags and optional derived `agentStatus` / create scope and ordered repository references. |
| `GET/PATCH /api/tickets/:id`         | Read by ticket ID / edit scope and references in Backlog.                                                                        |
| `POST /api/tickets/:id/archive`      | Archive an eligible ticket and return it with `archivedAt`. Safe to retry.                                                       |
| `POST /api/tickets/:id/move`         | Reorder or move Backlog to Ready with optional beforeId.                                                                         |
| `GET /api/tickets/:id/model-options` | Shared model catalog, independent of repository readiness and references.                                                        |
| `GET /api/tickets/:id/workflow`      | Current plan revision, phase, execution state and Forge conversation/workspace IDs.                                              |
| `POST /api/tickets/:id/approve`      | Approve the current idle plan with `{revision}`.                                                                                 |
| `POST /api/tickets/:id/messages`     | Queue feedback, or steer implementation/rebase with `{text,expectedTurnId}`.                                                     |
| `POST /api/tickets/:id/merge`        | Queue a legacy review candidate or retry a failed merge.                                                                         |
| `POST /api/tickets/:id/reconcile`    | Reconcile uncertain execution or retry a failed setup.                                                                           |
| `GET/PATCH /api/board/settings`      | Read settings or update `maxAgents` and ticket dispatch (`running` or `paused`).                                                 |
| `POST /api/board/settings/stop`      | Stop ticket dispatch and return interruption request and failure counts.                                                         |

Ticket conversations reuse the private agent read, resume, interrupt, reply and
SSE APIs. Idle and failed ticket messages dispatch through the scheduler, and ticket threads stay
out of the standalone Agents list. Mutations require owner access and exact-origin
checks. Transition conflicts return 409. Board and ticket details refresh while
execution continues. The global board opens at `/tasks`; selection uses `/tasks?ticket=:id`. Details,
workflow, model options and cost load by ticket ID even outside active board
membership. Removed repository ticket APIs return not-found. The ticket modal has keyboard-accessible Details, Chat and Cost
tabs. Chat opens by default once planning starts. One scroll container shows the
planner conversation and native Markdown plan revisions chronologically. Approve
plan attaches to the latest completed plan only while the workflow is idle;
feedback queues a revision and disables approval until it finishes. The saved
workflow revision remains the approval authority.

Successful approval inserts a persistent **Plan approved · Implementation** divider,
with queued/setup status until the implementer starts. Planner history remains
above it and implementer history appears below it. Codex owns separate threads in
the same worktree; the fresh implementer receives only the approved plan.
Historical requests are inactive. Only the current agent exposes reply and
interruption controls. Completed tickets and preview fixtures are read-only.
The Chat composer shows a context ring for the current conversation when Codex
reports a sample, with the latest used token count, percentage and model context
limit. The last reported sample is retained across restarts.
The timeline preserves the reading position across tabs and execution phases and
uses the shared [chat following control](agents.md#following-chat-activity) to
follow new activity or indicate unseen messages while paused.
One composer uses a ticket-level draft key, retaining unsent
text across approval and modal reopening within the board's browser memory.

Messages during running implementation and rebase turns steer the known active
turn immediately through `turn/steer` with `expectedTurnId`; they retain the same
execution slot and turn identity. Steering is serialized with ticket completion
and merge transitions. Stale turns, completed tickets and merge-queued submissions
are rejected. Failed or ambiguous steering is never replayed automatically; the
browser retains its draft and refreshes status. Planning messages remain limited
to idle/failed turns. Queued, dispatching and uncertain execution disable sending
with status text. Structured input and permission requests retain their dedicated
reply controls. See the [agent protocol contract](agents.md#interactive-agents).

### Epics and grouped backlog

Epics have independent increasing `EPIC-n` keys, a trimmed 1–120 character title,
a plain-text description up to 4000 characters (default empty) and creation time.
They remain editable after completion. They never enter Kanban or scheduling.
No deletion, archiving, nesting or custom epic ordering is supported.

Owner-only `GET/POST /api/epics` list or create epics; `GET/PATCH /api/epics/:id`
read or edit an epic. Mutations require the configured origin. Create and edit
accept `{title, description?}`. Lists return `counts` by ticket status, `total`,
`done` and derived `complete`; detail responses add non-archived `children` in
ticket order, including Done children. Empty epics are incomplete; an epic is
complete only when all its non-archived children are Done. Archived children
never contribute. Adding or moving an unfinished draft can change completion.

Ticket create/edit accepts optional nullable `epicId`. Omission during editing
preserves membership, `null` removes it, and an existing epic ID assigns or moves
it. Unknown IDs are rejected. Only non-archived Backlog tickets can change scope
or membership. Both persist atomically inside the workflow serialization boundary
shared with Ready transitions. Membership never changes ticket positions.

Backlog shows No epic first, then every epic in increasing numeric order,
including empty and completed epics. Each section preserves the unfinished-ticket
filter and ticket order. Headers show key, title, unfinished count and Done/total,
with separate disclosure and details buttons. Disclosures have `aria-expanded`
and `aria-controls`; collapsed IDs use browser storage key
`forge.epics.collapsed.v1`, tolerating malformed or unavailable storage. One-second
polling and mutations refresh tickets and epic summaries together, preserving
collapse state and unsaved dialog edits. Errors remain retryable in open dialogs.

Create epic opens an editable dialog with progress and child links. The URL
`/tasks?view=backlog&epic=EPIC-n` restores it on reload and Back/Forward. Ticket
creation and draft editing offer an optional Epic selector with No epic; later
statuses show membership read-only. Create ticket in an epic header or its details
preselects that epic. See [persistence](architecture.md#persistence-and-recovery)
and the required [database backup and recreation](development.md#development-databases).

### Docker containers

The global Board settings dialog has a separate Docker containers section for
every running container in Forge's internal daemon, including unattributed
workloads. It shows name, short ID, image, state, ports, CPU, memory usage/limit,
network and block I/O, and process count. While open and visible, it polls five
seconds after each completed request without overlapping polls; manual refresh
is also available. Closing cancels requests and polling. Unavailable Docker,
missing/stale statistics and no running containers are distinct states.

Owner-only routes (mutations also require the configured origin):

| Route                                           | Contract                                                                                  |
| ----------------------------------------------- | ----------------------------------------------------------------------------------------- |
| `GET /api/board/docker`                         | Availability, running summaries, latest statistics and latest cleanup operation.          |
| `POST /api/board/docker/containers/:id/cleanup` | Full 64-character Docker ID; returns operation with ID immediately (202).                 |
| `POST /api/board/docker/cleanup`                | Kill all and clean Docker; returns operation immediately (202).                           |
| `GET /api/board/docker/operations/:id`          | Progress, completion/partial failures, retained shared resources and remaining resources. |

Only one cleanup runs at a time; overlapping requests return `docker-busy` (409).
Operations run independently of browser connections. The latest 100 operations
and up to 100 target snapshots for retry are held in memory; application restart
forgets them and rereads the daemon. Inspection output, environment variables,
credentials and bind paths are never returned. Errors name failed steps without
returning raw CLI output. Statistics may be stale; the last successful sample
time is displayed. Docker failures do not disable the existing Board controls.

Individual cleanup snapshots the container's image, Docker volumes and custom
networks before force-removing it (including anonymous volumes). It removes
named volumes, custom networks and all image tags only when remaining containers,
including stopped containers, do not reference them. Shared resources are
reported and retained; Docker also refuses in-use volume/network/image removal.
Already-removed resources succeed. Failed steps remain explicit and can be
retried; snapshots allow retries after the container has gone within this
application lifetime. Bind-mounted source directories and Forge data are never
deleted. Sibling resources and unattributable caches require global cleanup.

Kill all force-removes running and stopped containers, then runs
[`docker system prune -a --volumes --force`](https://docs.docker.com/reference/cli/docker/system/prune/)
and [`docker volume prune -a --force`](https://docs.docker.com/reference/cli/docker/volume/prune/).
This includes unused images, custom networks, build cache and named volumes.
It remains available with no running containers. The daemon stays running for
subsequent workloads. Cleanup rechecks and reports remaining containers, images,
volumes, networks and build cache. Agents can create workloads concurrently, so
completion does not promise an empty daemon. Docker workload data is disposable.
Both cleanup modes leave agents, standalone chats and dispatch settings unchanged;
Stop all agents remains a separate control.

See [deployment and storage](development.md#docker-workloads), the
[trust boundary](architecture.md) and [deferred execution attribution](agents.md).
This release adds no labels, ownership inference, attribution UI or automatic
ticket cleanup.

### Ticket execution settings

Tickets accept optional `executionSettings: {model?, reasoningEffort?, permissions?}`
on creation and return the saved selection on reads. Owner-authorized
`PATCH /api/tickets/:id/settings` replaces that selection independently of Backlog
scope editing, with exact-origin checks. Settings are editable in Details before
moving to Ready and in the shared chat composer. Changes save immediately and
remain shared across polling, reopening and planner-to-implementer transitions.
Done and archived tickets retain their settings but cannot change them.

One selection applies across planning, implementation, feedback and rebase turns.
The workflow snapshots it under dispatch coordination; changes during execution
show “Applies to next turn” and cannot change active-turn steering or bypass stale
turn checks. Unset fields inherit the [Forge defaults](agents.md#interactive-agents)
on the next turn. Explicit selections are validated against the runtime catalog.
If a queued turn's explicit selection becomes unsupported, update its settings
and retry setup. Ticket chats use the shared composer and completion controls with a
compact mobile header, a separately scrolling timeline and viewport-bounded popups.

### Ticket cost

The account-wide [weekly budget capacity methodology](agents.md#weekly-budget-capacity)
uses first-time Done timestamps recorded atomically with workflow updates. Archived
completions count; legacy completion timestamps are left unknown. Capacity appears
in Costs and does not constrain scheduling or add a board indicator.

The [Costs page](agents.md#cost-and-usage) attributes each turn to the
ticket and phase at dispatch, including rebase turns on an implementation thread
and historical review turns. The ticket's Cost tab shows its recorded input,
cached input and output tokens, turn count and two AUD estimates using the same
data as the global dashboard. Owner-only `GET /api/tickets/:id/cost` returns only
that ticket’s usage, estimates, pricing metadata and tracking start date.

Costs links to `/tasks?ticket=:ticketId`. The panel loads the
ticket by ID independently of the active board, including archived tickets.
Closing clears the query parameter; reload and Back/Forward restore selection.
Missing tickets show errors. Archived panels retain
Details, Chat history and Cost, with editing and execution controls read-only.

- **Subscription allocation** prorates the monthly plan amount at dispatch over
  elapsed Codex turn time, splitting turns at UTC calendar month boundaries.
  Queue time and gaps between turns are excluded. Concurrent turns are priced
  independently. The allocation estimates a portion of the fixed subscription fee.
- **API equivalent** applies the published standard text rates for uncached input,
  cached input, and output to each known model and converts USD to AUD. It uses a
  dated exchange-rate snapshot. Long-context, service-tier, cache-write and tool
  fees are outside this base token estimate. Turns with missing duration, token
  counts or model pricing are flagged in the table.

See [cost settings](development.md#cost-settings) for the monthly amount and FX defaults.
