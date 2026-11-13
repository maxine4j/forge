# Codex and interactive agents

## Codex harness and lifecycle

Use Codex CLI's app-server as the built-in harness. Forge orchestrates tickets and
reviews; Codex owns model interaction, tools, agent execution, and conversations.

- Manage one long-lived `codex app-server` child process over stdio JSON-RPC.
- Initialize the protocol connection, then use supported thread, turn,
  notification, interruption, and approval operations. Validate the pinned CLI's
  protocol before implementing integrations; do not invent fields or guarantees.
- Keep app-server private to the backend. Browser clients call Forge APIs rather
  than receiving unrestricted Codex protocol access.
- Map executions to worktrees, branches, Codex thread IDs, active turn IDs, and
  execution status. Ticket planning agents retain their conversation through
  clarification and plan feedback; implementation starts a fresh conversation in
  the same ticket worktree, carrying only the approved plan and execution skill. Keep [ticket orchestration](tickets.md#agentic-ticket-board) outside the
  Codex execution adapter.
- Persist important normalized activity and approval state for browser reconnects.
  Reconcile actual Codex state after app-server or application restart before
  dispatching more work. Surface interrupted execution and recovery failures explicitly.
- A shared execution pool defaults to three active agents across projects,
  standalone chats and all ticket phases, including review followups and rebases.
  The [ticket board settings](tickets.md#agentic-ticket-board) set the shared limit
  and can interrupt active turns across projects.
  Running, waiting and uncertain executions retain slots. Completed, failed and
  interrupted turns release slots. Serialize mutations within each thread.
- Shut down child processes cleanly and reap descendants. Keep the web UI and
  process health available when Codex is unavailable or unauthenticated.

References: [official app-server documentation](https://learn.chatgpt.com/docs/app-server)
and the local `~/repo/codex-runner` source. Its short-lived setup/proxy connection is
a reference, not the required transport lifecycle for Forge's continuous agent UI.

### Interactive agents

Composers share the Codex theme and `$` skill / `@` file completion, including
[ticket chats](tickets.md#agentic-ticket-board). Completion choices scroll within
the space above the composer and support keyboard and touch selection. File and
skill discovery uses the active agent's verified worktree; internal skill paths
never enter browser responses. Explicit skills are resolved again at submission
and sent as structured inputs, including ticket steering.

OpenAI model options come from the installed runtime's catalog, including supported
thinking levels and its default effort. Messages accept optional `reasoningEffort`,
a nonempty catalog value. When a field is unset, each new turn inherits the
[Forge Config](foundation.md#forge-settings) model and thinking defaults. An unavailable
configured model falls back to Codex's default. Configured thinking applies to any
selected model that supports it and falls back to Codex's thinking default otherwise.
Switching models clears an incompatible explicit effort. Standalone selections
persist in existing SQLite thread JSON records. Unsupported explicit
model/effort combinations return `unsupported-settings` (400) and preserve drafts.
`GET /api/projects/:projectId/model-options` reads the catalog without allocating a
thread or worktree. Each endpoint rechecks owner access.

Ollama exposes the saved model tag as its only model, with no selectable thinking
levels. Worktree skills still come from app-server.

The Agents tab and backend reuse the one private, pinned Codex `0.164.0` stdio
process and existing persistent ChatGPT login.
`AgentService` owns thread/workspace coordination, authorization and per-thread
serialization; `CodexAgentClient` owns execution and maps validated harness events
to browser-safe values. Future ticket workflows can reuse that execution adapter
without depending on HTTP, browser connections or chat-specific state.

Creating a chat allocates a dedicated managed branch/worktree from local `main`.
It never uses the project repository or an unrelated manual workspace as its
execution directory. Codex thread creation is deferred until the first message:
the pinned runtime does not persist empty threads. Verify workspace ownership
before starting, resuming or sending a turn, and before answering approvals.
Canonicalize runtime paths before checking Codex's resumed working directory.
All working files, branches and thread records are retained.

SQLite stores thread identity/title, project/workspace links, Codex thread/turn
IDs, execution status and pending normalized requests. Codex's persistent home
owns conversation history; Forge's bounded in-memory activity view is a cache.
Persist intent before thread/turn dispatch. On restart, existing execution becomes
`uncertain` and pending request handles are invalidated. Never replay a turn or
approval automatically. Opening a chat automatically resumes it to reload Codex
history and reconcile state without submitting a message. An ambiguous thread creation with no known Codex ID
cannot be retried; create a new chat, retaining the old worktree. Untouched empty
chats remain usable across restarts.

Startup seeds every persisted execution reservation before accepting submissions.
Background reconciliation resumes thread metadata without loading conversation
items: history pagination failures cannot prevent slot recovery. Confirmed active
turns keep their slots and are not interrupted at startup. Confirmed idle threads
and authoritative missing rollouts settle as interrupted/recoverable; records,
branches and worktrees remain. In pinned Codex 0.164.0, only the structured
`-32600` response `no rollout found for thread id <id>` from resume establishes
absence. `thread not loaded`, authentication failures, timeouts and other RPC
errors remain unresolved, retaining capacity.

An uncertain creation without an ID is settled only after initialization confirms
a fresh runtime, or cleanup of the process that received creation. A failed
creation against the current process remains reserved. Recovery never retries
thread creation, turns or approvals and never resets the shared runtime.
Settlement invalidates approval handles and persists status before releasing
capacity. Stale notifications cannot reactivate a settled reservation.
**Stop all agents** uses the same serialized reconciliation, interrupts current
active turn IDs, and checks execution again. An interrupt acknowledgment alone
does not free capacity. Unresolved executions remain visible and can be retried
through [board settings](tickets.md#agentic-ticket-board).

Threads use `danger-full-access` and disabled Codex subagent spawning. Start and
resume use `on-request` approvals; each submitted turn applies its chat's selected
model and permission mode. `Ask` uses `on-request` with the `user` reviewer,
`Approve for me` uses `on-request` with Codex's `auto_review` reviewer, and
`Full access` uses `never` with the `user` reviewer. Automatic review is a runtime
risk assessment, not Forge automatically accepting approval callbacks. Chat
settings persist with thread metadata and apply to subsequent turns; changes in
the composer take effect on its next submitted message. The
Forge container is a trusted-owner execution boundary; Codex does not create nested
Bubblewrap namespaces. Forge and agents run as UID/GID 1000, while the
[Docker supervisor and daemon](development.md#docker-workloads) run as root in a
privileged container. This expands the trust boundary to the host kernel.
Commands have the container's filesystem and network access, including shared project data and
credential homes. Worktrees do not isolate agents from each other or Forge.
This slice supports one-time command/file approval or denial and replies to
structured user-input questions. Approval replies grant no additional session-wide
permissions, and the backend does not expose unrestricted RPC. Other server requests
are explicitly rejected. Approval callbacks belong to a particular live connection,
thread and turn; disconnects invalidate them. Worktrees remain a trusted-owner
boundary, not process isolation or protection from deliberately modifying shared
Git metadata.

Forge snapshots the [configured provider](foundation.md#forge-settings) when it
creates each agent record, including chats whose Codex threads start on first
message. Existing records without a provider use OpenAI. Ollama records retain
their endpoint and model through follow-ups, process restarts and reconciliation.
The shared app-server keeps OpenAI account access while Ollama threads use a
thread-scoped Responses provider without OpenAI credentials. Ollama turns do not
sample or contribute to OpenAI costs and quotas. Provider errors follow existing
execution and recovery paths without provider fallback.

Ollama accepts **Ask** and **Full access**. Codex 0.164.0 requests a separate
`codex-auto-review` model for **Approve for me**, outside Forge's single-model
Ollama configuration. Forge rejects that selection until the owner chooses
another permission mode. The configured model and server must support streamed
stateless Responses with function calls. Verify the chosen deployment and model
with chat, tool execution, restart, and ticket planning and implementation.

Codex's curated process environment explicitly supplies
`DOCKER_HOST=unix:///run/forge/docker.sock`, as do workspace terminals. CLI,
Compose and SDK workloads use the internal daemon; no host Docker socket or TCP
listener is supplied. Docker state and caches are disposable. [Board Docker
cleanup](tickets.md#docker-containers) leaves agent executions, chats and dispatch
settings unchanged. A stopped daemon does not stop Forge or its agents.

Future attribution should use Docker labels for project, ticket, workspace,
thread and execution IDs, injected by an execution-scoped endpoint or wrapper
covering CLI, Compose and SDK clients. The shared Codex app-server makes
process-wide variables unsuitable for per-agent attribution; instruction-only
labels would be best-effort. This release adds no attribution database, ownership
inference, automatic ticket cleanup, or attribution UI.

Browser-safe schemas are exported from `@forge/contracts/agents`:

| Route                                      | Contract                                                                                                                                                                                                   |
| ------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET/POST /api/projects/:projectId/agents` | List summaries / create `{title}`; returns 201 and a view.                                                                                                                                                 |
| `GET /api/agents/:id`                      | `{thread,items,requests,truncated}`; no Codex thread IDs or internal workspace paths in metadata.                                                                                                          |
| `POST /api/agents/:id/messages`            | `{text,model?,permissions?}`; starts one turn and returns its current view. Permission values are `ask`, `approve-for-me`, `full-access`.                                                                  |
| `GET /api/agents/:id/options`              | Runtime models `{id,name,isDefault}` and enabled worktree skills `{name,description}`; no internal skill paths.                                                                                            |
| `GET /api/agents/:id/files?query=…`        | At most 100 relative file paths from the chat's verified worktree. Empty query lists root files through the workspace tree API; nonempty query uses runtime fuzzy search. Query bounded to 500 characters. |
| `POST /api/agents/:id/resume`              | History loading and reconciliation; never sends input.                                                                                                                                                     |
| `POST /api/agents/:id/interrupt`           | Requests interruption of the known active turn.                                                                                                                                                            |
| `POST /api/agents/:id/replies`             | `{requestId,decision: "accept"/"decline"}` or `{requestId,answers:{questionId:text}}`.                                                                                                                     |
| `GET /api/agents/:id/events`               | Authorized SSE invalidations (`data: changed`); read the current view after each notification/reconnect.                                                                                                   |

Every operation rechecks owner access; HTTP mutations retain exact-origin checks.
Errors are `invalid-request` (400), `agent-not-found` (404), `agent-conflict` (409),
`agent-unavailable` (503), plus existing access/project/workspace failures. Raw
Codex diagnostics stay in operator logs. Conversation/tool text is owner-visible
content, not a credential-redaction guarantee.

Messages are limited to 8000 characters. Views retain at most 500 items, 32000
characters per item and 240000 text characters in total; clipping sets `truncated`.
Resume loads metadata for the latest 20 turns, then reads items newest first through
the pinned item pagination API in pages of 20. Stop at the browser snapshot budget
or 25 item pages, preserving the latest result and marking omitted history explicitly.
Full turn output must not be bundled into history metadata responses.
Pending structured requests are bounded per thread. RPC deadlines remain 15 seconds
and frames are bounded to 16 MiB, including large individual tool results and
completion notifications; there is no automatic
turn timeout. The shared execution limit also applies to these chats;
capacity failures preserve browser drafts for retry. SSE sends 15-second heartbeats,
disconnects slow consumers and closes on application shutdown. Reconnection reads
a current snapshot rather than replaying mutations.

Tests use injected service fakes, real Git/SQLite, controlled stdio peers and a
temporary credential-free pinned Codex process. The real probe verifies start,
interruption and history reload, not successful authenticated inference. Resuming
preserves newer live activity observed during the history read; unloaded or
system-error runtime states remain uncertain. Externally resolved server requests
invalidate both the transport reply and browser callback.

The Agents sidebar has a single-row Create chat button without a title input;
new chats receive a default numbered name. The tab has no additional Agents
heading, and the selected conversation does not repeat its title. Thread names
remain in the thread list; execution status and interruption remain available.
The responsive Agents tab lists and creates project chats, shows conversation and
tool activity, and supports send, interrupt, one-time approval/denial and structured
clarification replies. Open chats retain their message and answer drafts across
thread and project-section selection. Failed writes preserve drafts. Drafts are
browser memory only. Tasks, Costs and Config visits retain them with the open
repository workbench; changing repositories or reloading the page discards them.
Execution continues independently of the selected chat or browser connection.
At widths up to 700 CSS pixels, the base Agents URL shows only the full-height
chat list; a chat URL shows only its conversation. Creating a chat opens it after
success; failures leave the list and error visible. **Back to chats** navigates
explicitly to the base URL, including during loading and for unavailable chats.
It shares the status/action row without repeating the title. Wider screens show
the sidebar and conversation together and select the first listed chat when
entering without a chat URL. Resizing keeps an open chat selected; widening from
the list restores first-chat selection. Visited conversations stay mounted while
hidden, preserving drafts, clarification answers, activity and reading position;
returning to the list never interrupts execution. Hidden panes cannot receive
keyboard focus. Opening a conversation focuses its container without opening the
software keyboard; returning focuses its chat button, or Create chat if unavailable.
The list and history scroll independently within the visible viewport, including
when the software keyboard reduces it. See the [navigation contract](workspaces.md#slice-2-integrated-manual-workspace-and-pr-review).
Opening a chat
automatically loads persisted history and reconciles recoverable execution state;
running/waiting chats retain their live activity and untouched empty chats need no
resume. Sidebar chats hide the internal `uncertain` status and recover only when
selected. The conversation shows history loading instead of uncertainty and
blocks sending until recovery completes. Recovery failures show a retry action;
polling does not repeatedly retry failed recovery. Drafts survive recovery.
Truncation is visible. SSE reconnects and periodic polling read current snapshots
through a serialized, coalesced reader; selected chats recover newly uncertain
state without replaying messages or approvals. No Markdown or tool HTML is
executed from conversation text.

### Following chat activity

Standalone chats and ticket Chat timelines initially open at the bottom and follow
new messages, streaming output and content or viewport resizing. Scrolling more
than 80 pixels from the bottom pauses following and preserves the reading position.
A circular down-arrow control floats above the bottom of the history viewport,
outside its scrolling content and above the composer. New messages or changes to
message text, including owner messages, make it pulse until the reader clicks
“Scroll to latest” or manually returns within 80 pixels of the bottom. Either
action clears unseen activity and resumes following. The control supports keyboard
activation and visible focus; reduced-motion preferences use a static highlight.
Initial history loading, identical polling snapshots, status changes and local
tool expansion do not mark activity unseen. State belongs to each conversation in
browser memory. Ticket tabs and planner-to-implementer transitions retain the
timeline's paused reading position.

The conversation follows the Codex desktop layout: right-aligned user bubbles,
unboxed agent text and consecutive tool calls in one initially collapsed group.
Each tool expands to its output and displays its actual runtime status when
available. Running tool summaries use a sweeping text highlight, disabled with
reduced-motion preferences. Tool titles/statuses remain structured through output
deltas and history reloads. No project/workspace/worktree picker is exposed.

The rounded composer includes a runtime model selector, permission selector and
small blue upward-arrow send button. Enter sends; Cmd+Enter and Ctrl+Enter insert
a newline at the caret (Shift+Enter also retains normal textarea behavior). IME
composition must not submit. `$` opens enabled skills, `@` opens worktree files;
filter from the caret, navigate with arrows, insert with Tab or a pointer, and
dismiss with Escape. Completion preserves text after the caret. Explicit `$skill`
names in submitted text resolve through the verified worktree's enabled runtime
catalog and are sent as structured skill inputs. File completion inserts a
relative path into the message. Model/skill discovery failures expose a retry;
file-search failures retain the draft and allow another query. Ticket workflow
conversations share message layout and keyboard behavior. The
[ticket scheduler](tickets.md#agentic-ticket-board) selects native Codex Plan mode
on planner turns through the pinned app-server collaboration mode and persists
its completed plan items. Managed chats use the runtime's thread model and omit
the standalone model and permission selectors.

Native Codex plan items carry `kind: "plan"` in the browser contract and render
as Markdown assistant messages outside tool groups, identically for deltas and
restored history. Completed revisions stay visible. The [ticket Chat timeline](tickets.md#agentic-ticket-board)
combines planner and implementer history visually without duplicating Codex's
authoritative conversation storage. Approval uses the workflow's saved revision.

Managed ticket implementation and rebase turns support owner steering. Forge
verifies workspace ownership, serializes per-thread operations, and submits
`turn/steer` with `{threadId,expectedTurnId,input:[{type:"text",text,text_elements:[]}]}`.
The response is `{turnId}` and must match the expected active turn. These shapes
were verified with `codex app-server generate-ts` from pinned Codex `0.164.0`
against the [official steering documentation](https://learn.chatgpt.com/docs/app-server#steer-an-active-turn).
Steering starts no turn and claims no additional slot. Runtime completion remains
authoritative even if it precedes the steering response. Stale or inactive turns
are rejected; transport failures never trigger replay. Ticket workflow
serialization also prevents steering after completion/merge queuing. Waiting
structured requests use existing replies; planner feedback requires an idle or
failed workflow. Standalone chat messages retain their existing turn-start behavior.

Controlled Chromium tests cover independent threads, activity, interruptions,
reopening, failed sends/replies, approval/input, reconnects, automatic recovery and
mobile layout. Screenshots live under `artifacts/forge-browser/`. Authenticated
live ChatGPT inference remains a separate manual check.

### Cost and usage

The global Costs page at `/costs` reads `GET /api/costs` through the owner-only
API. It shows cumulative recorded usage, 7- and 30-day UTC charts by turn start
date, a breakdown by phase, and [per-ticket estimates](tickets.md#ticket-cost)
for every board ticket, including archived tickets, tickets with no repository
references and tickets without usage. Ticket rows link directly to
`/tasks?ticket=:id` and show no single-repository label. Ticket usage is aggregated
by ticket ID, independently of a turn's execution repository. See
[board ownership and execution context](tickets.md#agentic-ticket-board). Summary cards sum known ticket API USD costs, attributed weekly percentage and
effective USD costs before formatting, with per-metric incomplete-turn counts.
Account totals and standalone chats are separately identifiable. Historical local
currency equivalents convert each record using its dispatch snapshot before
summing, grouping currencies separately. Weekly percentages use three significant
figures only in presentation; incompatible bucket identities are never added.
The page retains manual refresh, retry, and five-minute refresh. Legacy project
Cost URLs and API routes are unknown routes with no redirects.
Standalone chats contribute to global usage in their own category. Cached
input is included in input totals, and reasoning is included in output.

Forge records `thread/tokenUsage/updated` counters and reported turn duration in
SQLite. Usage updates replace the previous snapshot for the same turn, with the
first update establishing the baseline from the runtime's last and total counts.
An indexed ticket ID supports direct queries without repository joins. Dispatch
saves local currency, monthly plan price, FX publication date and fetch time, and
USD model rates. Later settings or pricing changes never reprice saved turns.
API cost prices uncached input, cached input and output separately in USD.
The page shows the date tracking began. Older turns lack reliable per-turn token
and phase data for backfill. Disconnects can leave partial usage and missing
duration. The endpoint returns normalized counts without conversation content,
Codex identifiers, or account credentials.

Ticket Chat uses the latest context sample and model context window from the
same notification. Context can shrink after compaction. Completed ticket chats
load stored history without resuming Codex in a removed worktree.

Account-wide quota windows come from `account/rateLimits/read` when available.
Forge shows the reported window length, percent used, and reset time. The request
is read-only. A quota timeout leaves the shared execution connection open.

#### Quota cost attribution

Weekly windows are identified by `minutes === 10080`: use the sole weekly bucket,
or the stable `codex` bucket when multiple exist. Missing or ambiguous selection
makes attribution unavailable. Consecutive observations in the same bucket and
reset cycle allocate the nonnegative increase in proportion to each turn's saved
API-cost increment, including standalone chats in the denominator. SQLite saves
samples and interval allocations atomically and idempotently; repeated notifications,
restarts and dashboard reads cannot add duplicate turns or allocations.

Missing pricing, absent activity, counter decreases, reset boundaries, unavailable
selection and gaps over fifteen minutes leave observed consumption unallocated.
Per-bucket observed consumption equals ticket allocations plus chat allocations
plus unallocated consumption. Unobserved consumption is unknown. Raw observations
remain available independently of the dashboard and attribution selection.
Effective USD cost is `percentage / 100 × monthlyPlanLocal / usdToLocal / 4.33`,
using each turn's saved values. Both quota attribution and effective cost are
estimates: account-wide counters include external activity and delayed updates.
See [billing and exchange rates](development.md#cost-settings) and
[ticket summaries](tickets.md#ticket-cost).

#### Weekly budget capacity

The owner-only Costs response additionally returns `weeklyBudget`: account-wide
weekly bucket series, a default bucket ID, remaining percentage, reset and last
observation timestamps, freshness, and an additional-ticket estimate or an
unavailable reason (`learning`, `stale`, `reset-passed`).
Bucket identities are stored separately from display names. SQLite retains samples
across restarts; the collector coalesces and serializes requests at startup, turn
dispatch, completion and every five minutes without
requiring an open dashboard. Missing quota data leaves token and cost views usable.
The open dashboard also refreshes every five minutes and supports manual Refresh.

Each bucket uses the trailing 28 days of observations across all projects. Valid
intervals are consecutive samples in the same reset cycle, at most fifteen minutes
apart, with no counter decrease. Consumption sums positive percentage-point changes;
the denominator counts first-time Done transitions in those intervals, including
archived tickets. Historical completion times remain unknown. At least 24 observed
hours, three completions and positive consumption are required. Capacity is
`floor(remaining percentage / (consumption / completions))`: 40% remaining with
5 percentage points per ticket gives approximately eight additional tickets.
Fresh exhausted allowance shows zero; samples older than fifteen minutes or past
reset suppress estimates. The response includes sample size and observed period.

The responsive SVG shows recorded current-cycle history, gaps over fifteen minutes,
and a dashed linear reference from 100% at window start to 0% at reset. It never
invents a starting observation. Older reset cycles remain separate in expandable
timestamp/value data. A labelled selector defaults to the lowest remaining bucket.
This is budget capacity, not a guarantee of completing work in the remaining time:
standalone chats, other account activity and changing ticket complexity affect it.
It imposes no spending cap or scheduler enforcement.
