# Forge ticket and PR workflow

## Task navigation

Tasks retains `view=backlog`, `ticket=TASK-n` and `epic=EPIC-n` links. Tickets
also accept `tab=details|chat|history|cost`. The opening entry resolves the
remembered/default section in place, without another Back step; subsequent
polling cannot override an explicit section. Back/Forward and reload restore
that section. Modal ownership, parent location and section depth live in typed
router state; form contents remain in memory.

Ticket/epic creation, Board settings, archive and return confirmations use the
same modal history as ticket and epic details. Back from a confirmation dismisses
only that confirmation. X/Cancel skips all sections of the current modal and
returns to its parent. Epic → child ticket, ticket → epic and epic → create
ticket preserve their parent location and reading state. Navigation that would
unmount unsaved edits requires the [application draft guard](foundation.md#navigation).
Successful actions retire their confirmation entry; Forward restores a view
without replaying a mutation. Direct ticket and epic links first establish a
Board/Backlog parent, once; reload preserves this ancestry without adding entries.
See [browser and gesture verification](development.md#android-back-verification).

## Agentic ticket board

Board, backlog, editing, validation, execution settings, recovery, history, Docker
and cost failures use [shared notifications](foundation.md#shared-notifications).
Retry and reconciliation controls remain available after expiry; saved failure
snapshots announce once on display or change. Historical ticket events remain in
History. Native confirmation dialogs host the same notification viewport.

Tasks has nested Board and Backlog tabs. `/tasks` opens Board by default;
`/tasks?view=backlog` selects Backlog. Missing or unknown `view` values select
Board. Both preserve `?ticket=:id` for details, reload and browser history,
including existing archived-ticket links from [Costs](#ticket-cost).
Each view's actions sit beside the tabs and wrap below them when space is limited.

Backlog shows compact Key, Title and Status tables. The right-aligned Filters
dropdown follows creation actions and contains labelled Show done and Show archived
checkboxes. Changes apply immediately and leave the dropdown open. Both default
off. Browser storage key `forge.backlog.filters.v1` retains `{showDone,showArchived}`
across reloads and view switches; missing or invalid preferences default both to
false, and storage failures leave controls usable in memory. With both off,
only non-archived unfinished tickets appear. Show done includes non-archived Done
tickets; Show archived adds every archived ticket, including archived Done tickets,
independently of Show done. Both on shows all tickets. Counts, region labels and
empty states describe visible tickets. Its visible
count and row ordering follow shared one-second polling. Within each section,
non-archived tickets precede archived tickets, then tickets sort by status:
In progress, Ready for development, Backlog, Done. Within a status, activity sorts
by notification (`needsAttention`), running (`agentStatus: "working"`),
queued/pending (`agentStatus: "queued"` or `resetting`), then others.
Notification wins overlapping flags; cleanup pending takes the queued/pending
rank even with a retained running flag. The final tie-breaker is the ascending
numeric ticket key (TASK-2 before TASK-10). Archived tickets use the same status,
activity and key tie-breakers. These tables sort a copy of the shared collection;
Board and scheduling order remain unchanged.
Both views use the same collection, create/details dialogs, status transitions,
archive controls and attention/agent indicators. Filtering and polling preserve
open ticket details, including archived read-only controls. Board always excludes
archived tickets. Sections scroll with sticky
section headings. Ticket titles and fixed 80px status pills stay on one line
with ellipsis truncation at every width; ticket buttons retain full accessible
titles and hover text, and status hover text exposes the full label. Indicators
align to the right edge of the title column before the status pill, stay vertically
centered and do not shrink. Arrow keys, Home and End
select views; ticket-open buttons and dialog tabs support keyboard navigation.
Creation starts in Backlog. Scope and repository selection remain editable only
in Backlog status, regardless of selected view; Ready and In progress retain
their chat workflow. Inline editing, search, table reordering, bulk
actions, sprints, priorities and assignees are deferred.

See [epics and grouped backlog](#epics-and-grouped-backlog) for grouping and
membership. The board has four columns: Backlog, Ready for development, In progress and
Done. The corresponding API statuses are `backlog`, `todo`, `in-progress` and
`done`. The bottom-left corner of each card shows its ticket icon and key,
prefixed by the epic icon and key followed by a slash when the ticket belongs
to an epic. Cards support pointer and touch reordering, edge scrolling and
cancellation. Status transitions use the board's drag controls; ticket details
shows a labelled, read-only Status pill at the top of Details instead of a status menu.
Ready and In progress tickets offer **Return to backlog** beside Archive and Close.
The square circular-arrow action opens a confirmation titled “Return TASK-n to backlog?”.
It explains that execution stops and the execution worktree and unmerged branch
are removed while scope, settings and the latest saved plan are preserved.
Cancel or Escape closes only the confirmation and restores focus to its trigger.
Confirmation uses the move API, prevents duplicate submissions and becomes disabled
if polling removes eligibility. Failures toast and retain modal retry controls; success
keeps details open with cleanup progress. Archive retains its separate confirmation.
Dragging shares eligibility: Ready can move to Backlog, and In progress can move
to Backlog or Ready. These moves abandon execution through the existing move API.
Identity, scope, ordered repositories, epic, settings and the latest saved plan
survive; approval, feedback, candidate, retries and active execution references clear.
Without `beforeId`, moves append to the destination. Existing ordering and destination
validation apply. Done and archived tickets cannot return.

### Abandonment and restart

The workflow serialization boundary rechecks status against scheduler pickup and
merges, then atomically saves the move and abandonment intent. A queued merge is
canceled; a completed merge cannot be undone. Public `resetting` state reports
`resetStage: stopping|cleanup` and an optional recoverable `resetError`. The old
workspace and agent IDs stay in private abandonment metadata until cleanup finishes.
Workspace allocation records its ID in workflow intent before preparation, so setup
failure before agent creation can still be abandoned and cleaned safely.
Cancellation is requested promptly for only these ticket agents. Reconciliation
never replays ambiguous dispatches and retains execution tracking until confirmed
settlement. Returning to Ready or Backlog frees ticket capacity immediately, even
while cancellation is unresolved. The returned ticket cannot restart until its
reset completes. Workflow dispatch, feedback, approval and merge reject pending resets;
late results cannot advance the abandoned execution.

Cancellation and cleanup run outside the global workflow queue. Normal ticks and
startup recovery include resetting Backlog tickets. After agents settle, Forge
closes the terminal and [discards the owned worktree and unmerged branch](workspaces.md#ticket-abandonment-cleanup).
Failures persist for automatic retry; the existing reconcile action explicitly
retries cleanup. Metadata, agent records, historical usage, repositories and
credentials remain. The board exposes `resetting: true`; shared browser transition
eligibility disables restarting, Clear plan and conflicting actions until completion.

After cleanup Backlog is planning/idle; Ready is queued under normal dispatch and
capacity controls. Restarting with a saved plan creates a fresh implementer and
worktree from the selected repository's latest local main, automatically using the
plan without another planning or approval turn. **Clear plan** appears beside a
saved plan only on non-archived Backlog tickets. Owner-only
`POST /api/tickets/:id/clear-plan` returns the updated workflow and idempotently
clears the plan and approval after cleanup, preserving scope and usage. Restarting
after clearing uses the current scope, starting implementation when Skip planning
is enabled and planning otherwise. Abandoned threads and
worktrees are never reused. See [ticket cancellation](agents.md#ticket-cancellation).

Tickets belong to the global board, independently of repositories. SQLite allocates
immutable global increasing keys (`TASK-1`, ...) across restarts and concurrent
creation. New tickets start in Backlog, where the owner can edit a trimmed title
(1–120 characters), plain-text description (0–4000 characters, default empty), and
ordered `repositoryIds`. Duplicate and unknown references are rejected. Backlog
allows no references. The first selection is the execution repository; additional
selections are references only. The repository dropdown keeps selections in the
order they were added. Clear the field and select repositories again to change
their order. References never filter visibility or determine board position.
There can be at most 1000 active tickets across the board.

Moving to Ready requires a ready first repository. Dispatch revalidates readiness
and records `executionRepositoryId` and `workspaceId` in workflow state. Recovery,
planning, implementation, rebasing and merge reuse that recorded context. Forge
creates one worktree only; reference repositories do not create extra worktrees.
There is one persistent order per column, used by creation, moves, transitions,
completion and queued dispatch. A `beforeId` must name an active ticket in the
destination column. Scope edits and workflow transitions are serialized together.

Tickets have no repository-owner column.
`ticket_repositories` stores ordered references with foreign keys and unique
repository/position constraints; the board index is global. See
[development database care](development.md#development-databases).
The owner can archive a ticket from its details panel after confirming. Archived
tickets leave the board and remain in [Costs](agents.md#cost-and-usage).
Forge retains the key, scope, references, status, workflow history and related data. The
ticket and workflow remain readable by ID.
Queued work can be archived before it starts. A running turn, unresolved dispatch
or pending merge must settle before archiving.

| Stage                 | Behavior                                                                                                                                                                                                                                                                                               |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Backlog               | The owner writes the scope.                                                                                                                                                                                                                                                                            |
| Ready for development | The scheduler admits the top ticket when ticket capacity opens. It persists In progress before allocating a new ticket worktree from latest local main. Setup failures retain that status and capacity.                                                                                                |
| In progress           | A fresh Codex planner proposes a plan. The card shows an orange notification dot and Chat renders the Markdown plan and accepts feedback. Approve plan applies to the latest completed revision and queues a fresh implementer in the same worktree. Completed implementation goes to the merge queue. |
| Done                  | Forge moves the ticket here after confirming its commit is in local main.                                                                                                                                                                                                                              |

The scheduler counts persisted, non-archived In progress tickets, independently
of active jobs or agent execution states. Each ticket occupies one slot throughout
planning, awaiting plan approval, implementation, failure recovery and merging.
Idle, failed and uncertain workflows retain their slots across restart. Under
workflow serialization, occupancy is rechecked before each Ready admission in
board order. Subsequent turns, feedback, retries, rebases and merges need no
additional capacity check.

Done, archive and moves back to Ready or Backlog free capacity. These changes,
Ready moves and limit increases wake scheduling. [Standalone chats](agents.md#interactive-agents)
have no board concurrency limit and remain available while ticket dispatch is
paused or stopped. Board and conversation selection have no effect on execution.

**Stop all agents** durably stops ticket dispatch until explicitly resumed and
remains available while dispatch is stopped. `POST /api/board/settings/stop`
returns `settings`, `requested` (interrupt acknowledgments), `recovered`
(executions confirmed stopped or already inactive/missing), and `failed`
(unresolved executions, including acknowledged interrupts still running).
The dialog reports these separately; existing board polling refreshes outcomes.
Repeated Stop attempts reconcile unresolved executions without replaying input or
resetting Codex. Submissions cannot race the stop operation.

[Startup and stop reconciliation](agents.md#interactive-agents) persist settled
execution and invalidate approvals before ending execution tracking. This does
not free the ticket slot; see [execution recovery](agents.md#interactive-agents).
Stopped or missing
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
border, including on hover, and a solid orange dot labelled and titled “Action required”.
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
control is **Max concurrent tickets**, ranges from 1 to 10 and defaults to 3.
The API and SQLite retain the `maxAgents` field and existing numeric settings;
no migration is needed. Lowering it leaves existing tickets running and admits
another Ready ticket only when occupancy falls below the new limit. Pause new
tickets keeps Ready
tickets queued while in-progress tickets continue. The Board toolbar and Board
settings dialog share the pause and resume control state. Stop all agents requests
interruption of active ticket and standalone turns in parallel, reports any
failures, and holds ticket dispatch until explicitly resumed. Completed turns
and queued Git merges can still settle. Standalone chats can be started manually
after the stop request.

The planner receives a short ticket instruction and uses native Codex Plan mode
for every turn. Forge saves completed plan items as numbered revisions. Followup
messages contain the owner's text, plus recommendation guidance when enabled.
The implementer receives the saved plan once, or the current ticket ID, title and
description when Skip planning starts implementation without a plan, with an
instruction to implement and commit on the worktree branch. No plan or approved
revision is fabricated for direct implementation.
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

| Route                                | Contract                                                                                                                              |
| ------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------- |
| `GET/POST /api/tickets`              | Ordered active tickets with attention flags and optional derived `agentStatus` / create scope and ordered repository references.      |
| `GET/PATCH /api/tickets/:id`         | Read by ticket ID / edit scope and references in Backlog.                                                                             |
| `POST /api/tickets/:id/archive`      | Archive an eligible ticket and return it with `archivedAt`. Safe to retry.                                                            |
| `POST /api/tickets/:id/move`         | Reorder, start Backlog, return Ready/In progress to Backlog, or abandon In progress to Ready, with optional beforeId.                 |
| `POST /api/tickets/:id/clear-plan`   | Clear plan and approval on a settled Backlog ticket; returns workflow. Idempotent.                                                    |
| `GET /api/tickets/:id/model-options` | Catalog for the current phase's pinned provider, or the global selection before an agent exists. Independent of repository readiness. |
| `GET /api/tickets/:id/workflow`      | Current plan revision, phase, execution state and Forge conversation/workspace IDs.                                                   |
| `POST /api/tickets/:id/approve`      | Approve the current idle plan with `{revision}`.                                                                                      |
| `POST /api/tickets/:id/messages`     | Queue feedback, or steer implementation/rebase with `{text,expectedTurnId}`.                                                          |
| `POST /api/tickets/:id/merge`        | Queue a legacy review candidate or retry a failed merge.                                                                              |
| `POST /api/tickets/:id/reconcile`    | Reconcile uncertain execution, retry failed setup, or retry pending abandonment cleanup.                                              |
| `GET/PATCH /api/board/settings`      | Read settings or update `maxAgents` and ticket dispatch (`running` or `paused`).                                                      |
| `POST /api/board/settings/stop`      | Stop ticket dispatch and return interruption request and failure counts.                                                              |

Ticket conversations reuse the private agent read, resume, interrupt, reply and
SSE APIs. Idle and failed ticket messages dispatch through the scheduler, and ticket threads stay
out of the standalone Agents list. Mutations require owner access and exact-origin
checks. Transition conflicts return 409. Board and ticket details refresh while
execution continues. The global board opens at `/tasks`; selection uses `/tasks?ticket=:id`. Details,
workflow, model options and cost load by ticket ID even outside active board
membership. Removed repository ticket APIs return not-found. The ticket modal has keyboard-accessible Details, Chat, History and Cost
tabs. Details shows the latest saved Markdown plan below Description, including
after approval. The tabs share a row with the live execution label on the right.
The header epic link shows its icon and key, with the full title in its tooltip
and membership picker. The larger ticket title aligns with the Details tab content.
Agent Settings places the repository picker below the model
controls. While a plan awaits approval, Details offers Approve plan and
Request changes, which opens Chat. Chat opens by default once execution starts.
One scroll container shows the planner conversation and native Markdown plan
revisions chronologically. Approve plan applies to the latest completed plan
only while the workflow is idle;
feedback queues a revision and disables approval until it finishes. The saved
workflow revision remains the approval authority.
Chat places Approve plan beneath the plan, aligned to the right edge of its
message content, for both conversation plans and saved-plan fallback rendering.

Successful approval inserts a persistent **Plan approved · Implementation** divider,
with queued/setup status until the implementer starts. Planner history remains
above it and implementer history appears below it. Codex owns separate threads in
the same worktree; the fresh implementer receives the saved plan. Direct
implementation can start without planner history or a plan approval divider.
Historical requests are inactive. Only the current agent exposes reply and
interruption controls. Completed tickets and preview fixtures are read-only.
During an active turn, the composer button interrupts when the draft is empty or
contains only whitespace. A draft with text shows Send and can steer eligible turns.
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
execution tracking and turn identity. Steering is serialized with ticket completion
and merge transitions. Stale turns, completed tickets and merge-queued submissions
are rejected. Failed or ambiguous steering is never replayed automatically; the
browser retains its draft and refreshes status. Planning messages remain limited
to idle/failed turns. Queued, dispatching and uncertain execution disable sending.
Structured input and permission requests retain their dedicated
reply controls. See the [agent protocol contract](agents.md#interactive-agents).

### Epics and grouped backlog

Owner-authorized `GET /api/tickets` accepts optional `includeArchived=true|false`,
defaulting to false. Malformed or repeated values return the existing 400
invalid-request response. Inclusion preserves the response shape and ordering
by position then ticket number; archived tickets receive no workflow indicator
enrichment. Retained archives may take the collection beyond the 1,000 active-ticket
capacity; the response schema does not cap the combined collection. Tasks polls `tickets?includeArchived=true` for immediate local
filtering without requests on checkbox changes. Epic-detail child lists retain
only non-archived children.

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
including empty and completed epics. Each section has its own table and preserves
the selected Backlog filters and the sorting contract above, including archived children
when enabled. Collapsed sections remain collapsed across filter changes.
Completion counts still use only non-archived children. Headers show the epic icon, key,
title and a compact completion bar with the done and total counts. At widths of
600px and below, a 20px circular ring replaces the bar and visible counts;
empty epics show an empty ring. Each epic exposes one accessible progressbar
with completion values and the full “X / Y done” label at every width. Long
header titles truncate while disclosure and progress remain visible, and header
actions can wrap. Epic-detail child tables share the single-line row layout and
responsive progress. The title opens the epic and the adjacent
chevron collapses or expands its table. Disclosures have `aria-expanded`
and `aria-controls`; collapsed IDs use browser storage key
`forge.epics.collapsed.v1`, tolerating malformed or unavailable storage. One-second
polling and mutations refresh tickets and epic summaries together, preserving
collapse state and unsaved dialog edits. Backlog list errors clear after a
successful poll. Errors remain retryable in open dialogs.

Create epic opens an editable dialog. Existing epics open in a centered dialog
with inline title and description editing and a child work items table with
progress and links to all non-archived children, including Done, using the same
sorting contract as Backlog regardless of its filters. The status
shows Done when complete, In progress when any child is In progress or Done
and work remains, Ready for development when any remaining child is Ready
and work has yet to start, and Backlog otherwise. The URL
`/tasks?view=backlog&epic=EPIC-n` restores it on reload and Back/Forward. Ticket
creation offers an optional Epic selector. In ticket details, the header shows a
linked breadcrumb for an assigned epic. Backlog drafts can add, change or remove
their parent there and save it immediately. Create ticket in an epic header or its details
preselects that epic. Create ticket in No epic starts without an epic selected.
Creation and details use the [shared dropdown interaction contract](foundation.md#shared-selection-dropdowns).
Epic options show the existing decorative epic icon and key/title, and creation's
selected epic retains its icon. No epic is text-only. Missing selected epic data
falls back to its key. Details retains the linked breadcrumb, Add/Change trigger
and Remove epic action; each membership selection saves immediately. Typeahead
matches both keys and titles without adding a visible search field.
See [persistence](architecture.md#persistence-and-recovery)
and [database backup guidance](development.md#development-databases).

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

Tickets use the exported `TicketExecutionSettings` type and
`ticketExecutionSettingsSchema`, extending agent settings with optional boolean
`skipPlanning` and `acceptRecommendations`. Missing flags mean false.
Tickets accept optional `executionSettings: {model?, reasoningEffort?, permissions?, skipPlanning?, acceptRecommendations?}`
on creation and return the saved selection on reads. Owner-authorized
`PATCH /api/tickets/:id/settings` replaces that selection independently of Backlog
scope editing, with exact-origin checks. The title above the ticket tabs saves
independently of other Backlog edits. Click the Backlog description to edit it.
The floating controls save or discard the draft. Escape dismisses the dialog,
subject to [draft protection](foundation.md#navigation).
Repository selection in Agent Settings saves immediately in selection order.
The repository multiselect uses the [shared dropdown surface](foundation.md#shared-selection-dropdowns)
with checkboxes, chips in selection order, Clear repositories, and loading and
retryable error states. Toggling or clearing keeps the popup open; Escape, Tab or
an outside click dismisses it. Keyboard navigation and typeahead match repository
names. Busy controls and disabled fieldsets prevent changes.
Model, thinking and permissions are shared with the chat composer. Changes save immediately and
remain shared across polling, reopening and planner-to-implementer transitions.
Two independent checkboxes beneath the repository picker save immediately:
**Skip planning** starts implementation with a saved plan when available or the
current scope otherwise. **Accept recommendations** instructs every dispatched
ticket turn, including feedback and rebase, to choose the recommended
option, make reasonable assumptions and continue without preference or
clarification questions. Manual plan approval and tool permissions still apply.
Controls are disabled while saving, resetting, Done or archived; failures show the
existing save error. Details and Chat updates preserve all five settings.
Both flags persist in the existing executionSettings JSON column; existing records
need no database migration. Standalone chat settings remain unchanged.

Initial phase selection uses implementation when a saved plan exists or Skip
planning is enabled, and planning otherwise. Selection runs under workflow
serialization on entering Ready, after abandonment and immediately before initial
agent setup. Once a planner or implementer exists, the phase is locked for that
execution. Changing Skip planning then affects the next fresh execution and does
not approve a pending plan or interrupt work.

One selection applies across planning, implementation, feedback and rebase turns.
The workflow snapshots it and builds prompts from the same current ticket under
dispatch coordination. Changes during execution apply on the next turn, except
for the locked initial phase. Only model, reasoning effort and permissions reach
the agent runtime. Unset fields inherit the [Forge defaults](agents.md#interactive-agents)
on the next turn. Each planner and implementer pins the global provider when its
record is created. Clarifications, follow-ups and rebase use their existing
agent's provider. Explicit selections are validated against that provider at
dispatch. If a selection becomes unsupported, use Default for model and thinking
or select an available permission mode, then retry setup. Ticket chats use the shared composer and completion controls with a
compact mobile header, a separately scrolling timeline and viewport-bounded popups.

### Ticket cost

The account-wide [weekly budget capacity methodology](agents.md#weekly-budget-capacity)
uses first-time Done timestamps recorded atomically with workflow updates. Archived
completions count; legacy completion timestamps are left unknown. Capacity appears
in Costs and does not constrain scheduling or add a board indicator.

The [Costs page](agents.md#cost-and-usage) attributes each turn to the
ticket and phase at dispatch, including rebase turns on an implementation thread
and historical review turns. The ticket's Cost tab shows its recorded input,
cached input and output tokens, turn count and three metrics: estimated API cost
in USD, estimated weekly limit spent, and estimated effective USD cost. Planning,
implementation, review and rebase have separate summaries using the same contract
as ticket and board totals. Standalone chats remain outside ticket totals.
Owner-only, project-independent `GET /api/tickets/:id/cost` returns only that
ticket’s summary, phase summaries and tracking start date. Archived tickets, tickets
without repositories, and zero-usage tickets remain queryable. Invalid IDs return
400 and missing tickets return 404.

Costs links to `/tasks?ticket=:ticketId`. The panel loads the
ticket by ID independently of the active board, including archived tickets.
Closing clears the query parameter; reload and Back/Forward restore selection.
Missing tickets show errors. Archived panels retain
Details, Chat, History and Cost, with editing and execution controls read-only.

- **Estimated API cost** prices uncached input, cached input and output using the
  dispatch snapshot's USD model rates. Unknown pricing or usage stays unavailable.
- **Weekly limit spent** attributes account-wide quota increases using API-cost
  increments as weights, including chats. Values retain full precision; display
  uses three significant figures. Bucket identity accompanies the summary.
- **Effective cost** multiplies weekly percentage / 100 by the saved monthly plan
  price converted to USD, divided by 4.33. This is a quota attribution estimate.

Known values sum before formatting; completeness indicators identify partial
amounts. Local equivalents use each turn's historical exchange rate and group
mixed currencies separately, with USD detail. Long-context, service-tier,
cache-write and tool fees remain outside the base API token estimate.

See [quota attribution](agents.md#quota-cost-attribution),
[billing settings and FX caching](development.md#cost-settings), and
[persistence boundaries](architecture.md#persistence-and-recovery).

### Ticket History

The read-only History tab uses the existing labelled panels, arrow/Home/End
navigation and remembered selection, between Chat and Cost. It shows status visits
oldest first as large connected nodes with bold headings. Returning to Backlog or
Ready adds a visit. Smaller indented workflow milestones use nested semantic lists
and muted timestamps. Completed steps stay green with a check, active work is blue
with a spinner, failures are red with a safe reason, actions are orange with a solid
dot and explicit label, queued work uses a muted clock, and cancellation a stopped
indicator. Reduced motion disables rotation; text wraps on narrow screens.

Milestones include planning, created/adjusted plan revisions, awaiting approval,
approval, implementation, implemented candidates, merge queue, rebase, merge,
failure, retry, action requests/resumption, recovery, cancellation and cleanup.
Failures survive retries. Leaving In progress cancels unfinished work. Approval,
feedback and recovery remain in the existing controls; history excludes scope and
settings edits, conversation/tool contents, plan text and private runtime identities.

`ticket_history` stores ordered event IDs, ticket ID, UTC timestamp, status visit,
milestone, outcome, optional revision and normalized reason. Creation and actual
status changes append events in the ticket transaction; reorder alone does not.
Workflow persistence appends milestones in the state transaction. Ticket
admission opens the In progress visit before workspace or agent setup; dispatch
and runtime observations then record activity in that visit without copying it
from Ready. Setup failure belongs to the admitted visit. Serialized state
comparisons and durable per-thread/turn observations suppress repeated polling and
recovery observations, while preserving repeated waits and distinct retries.
An injected persistence boundary records normalized agent activity during agent
synchronization, independently of browser selection. Original workspace visits and
execution identities associate cleanup/results with their attempt; abandoned or
superseded turns cannot advance the current timeline. See
[agent lifecycle](agents.md#ticket-history-recording) and
[persistence](architecture.md#persistence-and-recovery).

Storage initializes additively. Existing tickets, including archived tickets, get
one idempotent snapshot of their known current status at initialization time.
“History recorded from…” identifies this boundary; no earlier transition or date
is invented. History remains after plans clear, abandonment, worktree removal,
archive and application restart.

Owner-authorized `GET /api/tickets/:id/history?after=<eventId>` returns
`{recordedFrom,bootstrapped,events,nextCursor?}` using shared Zod contracts from
`@forge/contracts/tickets`. Events are ascending by ID, with at most 100 per page;
`nextCursor` identifies the last returned event when another page exists. Omitted
`after` starts at zero; invalid cursors return 400, missing tickets 404. Archived
tickets remain readable. Private attempt identities and runtime data are excluded.
The tab loads on selection, refreshes once per second without overlapping requests,
retains loaded pages and reading position, and offers Load more, loading, empty
and retryable error states.
