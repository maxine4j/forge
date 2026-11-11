# Forge ticket and PR workflow

## Agentic ticket board

The board has exactly six columns: Backlog, To do, In progress, In review,
Merging and Done. API status values are `backlog`, `todo`, `in-progress`,
`in-review`, `merging` and `done`. Do not retain separate planning or plan-review
columns. Cards retain pointer/touch dragging, insertion ordering, edge scrolling
and cancellation; a native status menu provides the same owner transitions.

Tickets belong to ready projects. SQLite allocates immutable global increasing
keys (`FORGE-1`, ...) across restarts and concurrent creation. Creation accepts a
trimmed title (1–120 characters) and plain-text description (0–4000 characters,
default empty), always starting in Backlog. Scope edits are permitted in Backlog;
subsequent changes are discussed in the agent conversation. Each project retains
at most 1000 tickets.

| Stage       | Behavior                                                                                                                                                                                                 |
| ----------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Backlog     | The owner writes ticket title and description.                                                                                                                                                           |
| To do       | Queues planning. Allocate the ticket branch/worktree from latest local main when planning starts. Retain its planning conversation and persist versioned full plans. Owner replies queue plan revisions. |
| In progress | Moving from To do approves the completed current plan revision. Queue implementation in a fresh Codex conversation using the same worktree, approved plan and dev-local-derived TDD skill.               |
| In review   | Successful implementation moves here automatically. Owner chat replies queue review followups on the implementation conversation. Diff display and CI integration are deferred.                          |
| Merging     | Owner movement from idle In review authorizes a fast-forward-only update of main. If divergent, queue the implementation agent to rebase, resolve conflicts and validate before another merge attempt.   |
| Done        | Only the scheduler moves here after the branch is merged into local main.                                                                                                                                |

All execution shares the global three-agent limit, including standalone Agents
chats. Idle conversations consume no slot; opening or switching chats does not
start a turn. Planning, implementation, review replies and conflict resolution
are durable jobs independent of browser selection. User approvals/input retain
the active slot. Pending jobs wait for capacity. Standalone message submissions
at capacity return `agent-capacity` and retain the draft.

Planning instructions derive from dev-local: inspect requirements and repository,
produce an implementation plan and estimated file tree, identify validation and
risks, discuss revisions, and perform no edits. Implementation instructions carry
the approved plan and strict observed Red → Green → Refactor, repository checks,
review of task-owned changes and a local commit. Agents must not push, update
main, create additional worktrees or spawn subagents. Merge repair instructions
request rebase and conflict resolution with validation. Codex remains the
conversation authority; SQLite stores plan artifacts and workflow metadata, not a
second chat log. Planning and implementation histories remain separate.

Transport completion alone is not phase success. Each dispatch carries a persisted
run number. The final assistant item must end with `FORGE_RESULT` and a JSON
artifact tied to that run: `kind: plan` with the complete bounded plan, or
`kind: complete` with the full commit SHA and passing validation evidence. Questions,
blockers, missing/truncated artifacts and stale run numbers require attention.
Validation evidence is the agent's report; Forge independently verifies a clean
worktree on the owned branch at the reported commit, outside an unfinished rebase.
The validated SHA is persisted before merging. Owner merge authorization applies
to that candidate; a changed branch conflicts. Git verifies the branch and updates
main in one ref transaction. Recovery recognizes an already merged candidate,
including after subsequent main advances, without repeating an agent turn.
An owned worktree remains available for agent conflict repair while Git's rebase
metadata identifies that same branch. Unrelated detached HEADs remain invalid;
completion and merging still require a finished rebase and attached branch.

Workflow intent and board moves are persisted atomically in SQLite. Dispatch
intent precedes Codex calls. After a restart, reconcile known conversations before
new dispatch; never blindly replay an ambiguous turn. Surface failed/uncertain
work separately from board status. Uncertain execution requires reconciliation;
failed execution accepts explicit owner followup. Automatic rebase attempts are
bounded to three and then require attention. Preserve all worktrees and history.
Reserve persisted active executions before accepting HTTP messages; reconcile
Codex in the background so runtime outages cannot block health/UI startup.
Resume existing conversations before dispatch, including queued followups after
restart; loading a conversation never replays input. Internal scheduler prompts
allow 64000 characters through the private transport; ordinary messages retain
the 8000-character service and API limit.
Completed and idle conversations consume no slot after restart or connection loss.
Scheduler reads paginate active jobs across projects in board position order.
Board refreshes and writes share one serialized reader. Ticket message and input drafts
survive closing/reopening and switching conversations within the board; they are
browser memory only. Planning history and Done conversations have read-only
execution controls. Preview workflow reads use fixtures; mutations remain disabled.

Browser contracts are exported from `@forge/contracts/tickets`:

| Route                                       | Contract                                                                                                          |
| ------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| `GET/POST /api/projects/:projectId/tickets` | Ordered list / create title and description.                                                                      |
| `GET/PATCH /api/tickets/:id`                | Read / edit scope in Backlog.                                                                                     |
| `POST /api/tickets/:id/move`                | Guarded owner transition with optional beforeId.                                                                  |
| `GET /api/tickets/:id/workflow`             | Plan revision, phase, execution state and Forge conversation/workspace IDs. No raw Codex IDs or filesystem paths. |
| `POST /api/tickets/:id/messages`            | Queue planning/review feedback as bounded text.                                                                   |
| `POST /api/tickets/:id/reconcile`           | Reconcile uncertain execution without replaying messages.                                                         |

Ticket conversations reuse the private agent read/resume/interrupt/reply/SSE APIs.
Their message dispatch is scheduler-only; direct standalone sends cannot bypass
ticket guards. Ticket threads are not duplicated in the standalone Agents list.
Exact-origin and owner checks apply to every API operation. Existing fixed ticket
errors remain; transition conflicts return 409. The board and ticket view refresh
while execution continues. Preview fixtures remain read-only.

### Ticket cost

The [Cost tab](agents.md#cost-and-usage) attributes each turn to the ticket and
phase at dispatch, including review and rebase turns on an implementation thread.
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
