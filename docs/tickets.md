# Forge ticket and PR workflow

## Agentic ticket board

The board has four columns: Backlog, Ready for development, In progress and
Done. The corresponding API statuses are `backlog`, `todo`, `in-progress` and
`done`. Cards support pointer and touch reordering, edge scrolling and
cancellation. Moving from Backlog to Ready for development is available by
dragging or through the ticket's status menu.

Tickets belong to ready projects. SQLite allocates immutable global increasing
keys (`FORGE-1`, ...) across restarts and concurrent creation. New tickets start in
Backlog. The owner can edit a trimmed title (1–120 characters) and plain-text
description (0–4000 characters, default empty) while in Backlog. Each project
can have at most 1000 active tickets.

The owner can archive a ticket from its details panel after confirming. Archived
tickets leave the board and remain in [project Cost](agents.md#cost-and-usage).
Forge retains the key, scope, status, workflow history and related data. The
ticket and workflow remain readable by ID.
Queued work can be archived before it starts. A running turn, unresolved dispatch
or pending merge must settle before archiving.

| Stage                 | Behavior                                                                                                                                                                                                                                                                                       |
| --------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Backlog               | The owner writes the scope.                                                                                                                                                                                                                                                                    |
| Ready for development | The scheduler claims the top ticket when an agent slot opens. It reserves the slot before allocating a new ticket worktree from latest local main.                                                                                                                                             |
| In progress           | A fresh Codex planner proposes a plan. The card shows an attention badge and Chat renders the Markdown plan and accepts feedback. Approve plan applies to the latest completed revision and queues a fresh implementer in the same worktree. Completed implementation goes to the merge queue. |
| Done                  | Forge moves the ticket here after confirming its commit is in local main.                                                                                                                                                                                                                      |

The scheduler wakes when tickets enter Ready or Done, when an agent slot is
released, and when settings open new capacity. All execution shares a pool with
[standalone chats](agents.md).
Idle chats use no slot. A running agent waiting for structured input or permission
keeps its slot. Standalone message submissions at capacity retain their drafts.
Board and conversation selection have no effect on execution.

Board settings apply across projects and persist in SQLite. The concurrency
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
readable through Codex. At upgrade, existing In review and Merging tickets move to
In progress. Legacy In review tickets need an explicit Queue merge action and
already authorized merges resume.

Browser contracts are exported from `@forge/contracts/tickets`:

| Route                                       | Contract                                                                            |
| ------------------------------------------- | ----------------------------------------------------------------------------------- |
| `GET/POST /api/projects/:projectId/tickets` | Ordered active tickets with attention flags / create title and description.         |
| `GET/PATCH /api/tickets/:id`                | Read / edit scope in Backlog.                                                       |
| `POST /api/tickets/:id/archive`             | Archive an eligible ticket and return it with `archivedAt`. Safe to retry.          |
| `POST /api/tickets/:id/move`                | Reorder or move Backlog to Ready with optional beforeId.                            |
| `GET /api/tickets/:id/workflow`             | Current plan revision, phase, execution state and Forge conversation/workspace IDs. |
| `POST /api/tickets/:id/approve`             | Approve the current idle plan with `{revision}`.                                    |
| `POST /api/tickets/:id/messages`            | Queue feedback, or steer implementation/rebase with `{text,expectedTurnId}`.        |
| `POST /api/tickets/:id/merge`               | Queue a legacy review candidate or retry a failed merge.                            |
| `POST /api/tickets/:id/reconcile`           | Reconcile uncertain execution or retry a failed setup.                              |
| `GET/PATCH /api/board/settings`             | Read settings or update `maxAgents` and ticket dispatch (`running` or `paused`).    |
| `POST /api/board/settings/stop`             | Stop ticket dispatch and return interruption request and failure counts.            |

Ticket conversations reuse the private agent read, resume, interrupt, reply and
SSE APIs. Idle and failed ticket messages dispatch through the scheduler, and ticket threads stay
out of the standalone Agents list. Mutations require owner access and exact-origin
checks. Transition conflicts return 409. Board and ticket details refresh while
execution continues. The ticket modal has keyboard-accessible Details, Chat and Cost
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
The timeline preserves the reading position and follows new activity when already
near the bottom. One composer uses a ticket-level draft key, retaining unsent
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

### Ticket cost

The [project Cost tab](agents.md#cost-and-usage) attributes each turn to the
ticket and phase at dispatch, including rebase turns on an implementation thread
and historical review turns. The ticket's Cost tab shows its recorded input,
cached input and output tokens, turn count and two AUD estimates using the same
data as the project dashboard.

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
