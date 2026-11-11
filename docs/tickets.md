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
retains at most 1000 tickets.

| Stage                 | Behavior                                                                                                                                                                                                                                                                                                |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Backlog               | The owner writes the scope.                                                                                                                                                                                                                                                                             |
| Ready for development | The scheduler claims the top ticket when an agent slot opens. It reserves the slot before allocating a new ticket worktree from latest local main.                                                                                                                                                      |
| In progress           | A fresh Codex planner proposes a plan. The card shows an attention badge and details render the Markdown plan. Request changes opens the planner chat. Approve applies to the displayed revision and queues a fresh implementer in the same worktree. Completed implementation goes to the merge queue. |
| Done                  | Forge moves the ticket here after confirming its commit is in local main.                                                                                                                                                                                                                               |

The scheduler wakes when tickets enter Ready or Done and when an agent slot is
released. All execution shares the three-agent pool with [standalone chats](agents.md).
Idle chats use no slot. A running agent waiting for structured input or permission
keeps its slot. Standalone message submissions at capacity retain their drafts.
Board and conversation selection have no effect on execution.

The planner receives a short ticket instruction and uses native Codex Plan mode
for every turn. Forge saves completed plan items as numbered revisions. Followup
messages contain the owner's text alone. The implementer receives the approved
plan once, with an instruction to implement and commit on the worktree branch.
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
verified candidate. Worktrees and chats remain available. At upgrade, existing
In review and Merging tickets move to In progress. Legacy In review tickets need
an explicit Queue merge action and already authorized merges resume.

Browser contracts are exported from `@forge/contracts/tickets`:

| Route                                       | Contract                                                                            |
| ------------------------------------------- | ----------------------------------------------------------------------------------- |
| `GET/POST /api/projects/:projectId/tickets` | Ordered list with attention flags / create title and description.                   |
| `GET/PATCH /api/tickets/:id`                | Read / edit scope in Backlog.                                                       |
| `POST /api/tickets/:id/move`                | Reorder or move Backlog to Ready with optional beforeId.                            |
| `GET /api/tickets/:id/workflow`             | Current plan revision, phase, execution state and Forge conversation/workspace IDs. |
| `POST /api/tickets/:id/approve`             | Approve the current idle plan with `{revision}`.                                    |
| `POST /api/tickets/:id/messages`            | Queue bounded feedback for the current phase.                                       |
| `POST /api/tickets/:id/merge`               | Queue a legacy review candidate or retry a failed merge.                            |
| `POST /api/tickets/:id/reconcile`           | Reconcile uncertain execution or retry a failed setup.                              |

Ticket conversations reuse the private agent read, resume, interrupt, reply and
SSE APIs. Ticket messages dispatch through the scheduler, and ticket threads stay
out of the standalone Agents list. Mutations require owner access and exact-origin
checks. Transition conflicts return 409. Board and ticket details refresh while
execution continues. Drafts persist in browser memory within the board. Planning
history after approval and Done chats are read-only. Preview fixtures are read-only.

### Ticket cost

The [Cost tab](agents.md#cost-and-usage) attributes each turn to the ticket and
phase at dispatch, including rebase turns on an implementation thread and historical review turns.
Each ticket shows recorded token volume and two AUD estimates.

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
