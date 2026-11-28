# Codex and interactive agents

Ticket planning keeps the assigned Planner thread and its pinned settings across
feedback and recovery. Accepted native plans are validated and stored alongside
their parsed structure; invalid output leaves the previous revision intact for
corrective feedback. Approval sends the complete rebuilt plan in one Implementer
turn. See [structured Planner revisions](tickets.md#structured-planner-revisions).

## Worktree TypeScript tools

Planning and implementation threads receive the reserved
`forge_typescript` MCP server on start, resume and recovery. Its absolute Node
launcher and compiled bridge receive an explicit canonical worktree argument and
MCP cwd. Dotted per-server configuration preserves other MCP entries and provider
settings. Tool failures are bounded activity errors; agents can continue with
their existing tools. MCP activity includes server/tool names and completion state.

The six read-only tools are `diagnostics`, `hover`, `definition`, `references`,
`document_symbols` and `workspace_symbols`. Every call takes `path`, a
worktree-relative TS/TSX/JS/JSX file; for workspace symbols it identifies package
context. Position tools require `line` and `character`, both zero-based, with
character measured in UTF-16 code units. Workspace symbols accept `query`.
Traversal and source symlinks outside the canonical checkout are rejected.

Resolution walks the queried file's package hierarchy only as far as the checkout
root, allowing package-manager dependency-store symlinks. Each distinct compiler
installation/version has its own serialized server. TypeScript 7 runs its local
`tsc --lsp --stdio`; versions 4–6 use the pinned language-server adapter with that
installation's exact `tsserver.js`. Missing, unsupported or broken installations
report the package and expected installation; Forge never downloads or substitutes
a compiler. Install repository dependencies through the normal project workflow.

Results identify `compilerVersion`, package context, bounded `result` and explicit
`truncated`. Successful empty results remain distinct from `unavailable`,
`unsupported`, `timeout`, `invalid_input` and `changed` errors. Location paths are
relative to the checkout; dependency locations outside it are explicitly external.
Responses limit arrays to 100 entries, strings to 8,000 characters, total strings
to 48,000 characters, and recursive processing to 2,000 nodes. Source files are
limited to 1 MiB. Diagnostics check only the requested file.

The bridge reads disk before each query and sends versioned document updates.
Filesystem changes invalidate cached state and forward watched-file notifications;
subsequent queries recreate affected servers, including configuration/import changes.
Diagnostic checks use a fresh server to prevent legacy unversioned pushes from
being mistaken for current diagnostics. The legacy adapter also awaits fixed
read-only syntax, semantic and suggestion diagnostic requests, so an early empty
push cannot be mistaken for a completed clean check. Changes during a query return
`changed`
for explicit retry. Initialization and protocol queries have 30-second deadlines;
servers start lazily and stop after 60 seconds idle. Workspace edits requested by
the server are rejected; rename, code actions and command execution are not tools.
EOF/shutdown closes children within Codex's owned process group. No agent turn is
replayed after failure. See [architecture](architecture.md#worktree-typescript-intelligence),
[worktree release](workspaces.md#language-server-release) and
[runtime verification](development.md#typescript-mcp-verification).

## Latest-turn inference performance

`AgentView.performance` is an optional validated latest-turn snapshot shared by
ticket planning and implementation, including Ollama. It carries
`turnId`, `outputTokens`, `requestCount`, `requestDurationMs`, optional
`firstTokenLatencyMs` and `generationDurationMs`, and `state` (`complete`, `partial`
or `unavailable`). Rates are derived from these totals independently of
[cost and usage tracking](#cost-and-usage).

The private Codex OTLP JSON adapter correlates transport spans through
`stream_request` and the sampling-attempt parent with `codex.sampling` thread and
turn identities. Successful `codex.sse_event` completion records supply source
timestamps, output counts and runtime first-token timing on HTTP and WebSockets.
First-token latency adds request setup to Codex's post-setup first-token timing.
Effective rate divides output tokens by summed request-start-to-completion time;
generation speed divides output tokens by summed post-first-token response time.
Reasoning and tool-call output are included in reported output tokens; reasoning
is never added again. Input and cached-input tokens are discarded.

These are client-observed model-request measurements including transport latency.
Tools, approvals, clarification, scheduling and plan review add no time. WebSocket
warmups, catalog traffic and unrelated/automatic-review threads are excluded.
Failed transport attempts do not duplicate successful responses. Missing tokens or
timing produce partial/unavailable results, with no wall-clock fallback. A new
turn starts at Measuring; source-only measurements never bridge a disconnect or
restart. Existing measured responses remain visible during tool and review waits.

Normalized samples have idempotent `(thread, turn, sampling attempt)` identities in
SQLite. Additive normalized correlation fragments allow delayed logs, duplicate
and reordered batches, and recovery without raw telemetry retention. Only required
IDs, timestamps and counters pass the parser; prompt, response, tool and account
content is discarded. Agent responses and existing change events expose totals;
saved samples can be read without resolving a deleted worktree. Older unmeasured
turns have no estimates. See [the private boundary](architecture.md#private-request-telemetry),
[chat presentation](tickets.md#chat-inference-speed) and
[protocol checks](development.md#request-telemetry-verification).

## Notification request lifecycle

Archiving a notification only hides its current occurrence; it does not answer or
resolve the request. See [pending notifications](tickets.md#pending-notifications).

Managed-agent request snapshots feed [Tasks Notifications](tickets.md#pending-notifications)
without loading conversation history or selecting a chat. Agent store insert/update
paths synchronize request-handle identities and injected-clock observation times
as callbacks persist current requests. Answers, approvals, external resolution and
abandonment remove metadata when the request leaves the authoritative snapshot.
Startup clears runtime approval handles before bootstrapping current conditions;
stale handles cannot be replayed. Shared request forms retain choices, free text
and masked secrets in browser memory, including failed replies. Plan review uses
saved workflow revisions, and feedback rejects a changed or approved revision.
Opening Chat or Notifications does not acknowledge or dismiss any request.
See [notification persistence](architecture.md#notification-metadata).

## Ticket history recording

The agent service injects a persistence interface at its normalized synchronization
boundary to record waiting, resume, failure and interruption for managed tickets.
Recording runs from runtime notifications and recovery without an open dialog;
Codex adapters retain protocol translation only. Durable turn identities suppress
duplicate snapshots and reject abandoned or superseded executions. Only normalized
labels and safe reasons enter the [ticket History timeline](tickets.md#ticket-history),
which is distinct from Codex's authoritative conversation history. See
[SQLite persistence](architecture.md#persistence-and-recovery).

## Ticket cancellation

Ticket-only [execution settings](tickets.md#ticket-execution-settings) can skip
planning or request recommended choices without clarification questions.
Direct implementation receives current ticket scope when there is no saved plan.
Recommendation guidance applies to every ticket turn while preserving manual
plan approval and tool permission mode. These flags stay in ticket orchestration.

[Returning a ticket](tickets.md#abandonment-and-restart) records durable abandonment
before requesting ticket-scoped cancellation through the injected agent interface.
Only the recorded managed planner and implementer are interrupted; unrelated
tickets keep running. Agents retain a private abandonment
flag rejecting further dispatch, steering and approval replies. Reconciliation
uses the same termination evidence as Stop all agents, without replaying ambiguous
turns. Interrupt acknowledgment alone does not settle execution or allow worktree
removal. Confirmed settlement permits [owned workspace cleanup](workspaces.md#ticket-abandonment-cleanup).
Agent records, conversations and historical cost attribution survive abandonment.

## Codex harness and lifecycle

A phase pins the provider's optional [automatic compaction threshold](foundation.md#model-providers). Forge supplies it as `model_auto_compact_token_limit` on thread start and resume, including reconciliation, except for managed Implementer threads, which use Codex's default throughout their lifetime. Historical pins remain intact. Codex owns automatic compaction and may clamp configured values to the model window. Ticket Chat uses the smaller of the pinned threshold and Codex's reported model window as its context gauge limit, or the reported window when no threshold is pinned. It also displays the configured threshold separately. Managed Implementer handoffs use the pin while Codex manages automatic compaction; the 75% default applies to Forge handoff steering. See [implementation checkpointing and recovery](tickets.md#implementation-context-handover).

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
  the same ticket worktree, carrying the saved plan or current ticket scope for
  direct implementation. Keep [ticket orchestration](tickets.md#agentic-ticket-board) outside the
  Codex execution adapter.
- Persist important normalized activity and approval state for browser reconnects.
  Reconcile actual Codex state after app-server or application restart before
  dispatching more work. Surface interrupted execution and recovery failures explicitly.
- An unbounded execution tracker records active and uncertain executions across
  projects and ticket phases for global stop and recovery.
  Completed, failed and interrupted turns end execution tracking. Thread creation
  reserves no slot. Serialize mutations within each thread and retain submission
  guards against racing global stop. The [ticket board capacity](tickets.md#agentic-ticket-board)
  limits persisted In progress tickets independently of execution tracking;
  awaiting approval and failed workflows still count. **Stop all agents** interrupts
  tracked ticket executions.
- Shut down child processes cleanly and reap descendants. Keep the web UI and
  process health available when Codex is unavailable or unauthenticated.

References: [official app-server documentation](https://learn.chatgpt.com/docs/app-server)
and the local `~/repo/codex-runner` source. Its short-lived setup/proxy connection is
a reference, not the required transport lifecycle for Forge's continuous agent UI.

### Interactive agents

Assistant messages render as Markdown with HTML and images disabled. Completed,
untruncated final-answer messages containing a single JSON object display an
expandable tree with a copy control preserving the original JSON payload. Legacy
messages without phase metadata remain Markdown. This display marker is separate
from managed completion-report capture; transcript text is unchanged.

Request, history recovery, composer discovery and failed-turn explanations use
[shared notifications](foundation.md#shared-notifications). Saved failures announce
on display or change, while historical conversation/tool output stays in chat.
Retry controls and composer drafts survive notification expiry. Visible repository
and ticket composers anchor notifications on slab phones, including their controls.

Composers share the Codex theme and `$` skill / `@` file completion, including
[ticket chats](tickets.md#agentic-ticket-board). Completion choices scroll within
the space above the composer and support keyboard and touch selection. File and
skill discovery uses the active agent's verified worktree; internal skill paths
never enter browser responses. Explicit skills are resolved again at submission
and sent as structured inputs, including ticket steering.

[Named Agents](tickets.md#named-agents) select OpenAI models and supported thinking
levels using the pinned runtime’s catalog, or an Ollama tag with no thinking level.
Ticket phases resolve and pin routing before external setup. Worktree skills come
from app-server.

The Agents tab and backend reuse the one private, pinned Codex `0.171.0` stdio
process and existing persistent ChatGPT login.
`AgentService` owns thread/workspace coordination, authorization and per-thread
serialization; `CodexAgentClient` owns execution and maps validated harness events
to browser-safe values. Future ticket workflows can reuse that execution adapter
without depending on HTTP, browser connections or chat-specific state.

Ticket phases use their verified ticket worktree. Codex thread creation is deferred
until dispatch. Repository chat routes have been removed. Existing conversation
records and credential homes remain on disk.
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

Startup seeds every persisted tracked execution before accepting submissions.
Background reconciliation resumes thread metadata without loading conversation
items: history pagination failures cannot prevent execution recovery. Confirmed active
turns remain tracked and are not interrupted at startup. Confirmed idle threads
and authoritative missing rollouts settle as interrupted/recoverable; records,
branches and worktrees remain. In Codex 0.164.0, only the structured
`-32600` response `no rollout found for thread id <id>` from resume establishes
absence. `thread not loaded`, authentication failures, timeouts and other RPC
errors remain unresolved and tracked.

An uncertain creation without an ID is settled only after initialization confirms
a fresh runtime, or cleanup of the process that received creation. A failed
creation against the current process remains tracked. Recovery never retries
thread creation, turns or approvals and never resets the shared runtime.
Settlement invalidates approval handles and persists status before ending
execution tracking. Stale notifications cannot reactivate a settled execution.
**Stop all agents** uses the same serialized reconciliation, interrupts current
active turn IDs, and checks execution again. An interrupt acknowledgment alone
does not settle execution. Unresolved executions remain visible and can be retried
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

Forge uses [named model providers](foundation.md#model-providers) and
[reusable Agents](tickets.md#named-agents) with the existing Codex harness. Before
the first setup of each ticket phase, Forge pins its assigned Agent’s model and
thinking level with the provider identity and routing. Planning and plan feedback
reuse the Planner pin. Implementation, implementation feedback, and rebase reuse
the Implementer pin. The One shot workflow starts implementation directly. Existing pins
survive Agent or provider edits, retirement, setup retries and recovery. Public
summaries expose provider identity and keep inference endpoints private.
Legacy agent records without a provider still mean OpenAI; upgrade never rewrites
their inference snapshots or replays dispatched turns. See
[ticket selection and reset](tickets.md#ticket-execution-settings) and
[migration](development.md#named-provider-upgrades).

The shared app-server keeps OpenAI account access while Ollama threads use a
thread-scoped Responses provider without OpenAI credentials. Ollama permission
restrictions remain in force. Ollama turns record usage for [API-equivalent and
weekly allowance estimates](#cost-and-usage). OpenAI quota sampling and attribution
remain scoped to OpenAI. Provider errors follow existing recovery paths. Named providers
share the ticket board’s existing scheduler and execution tracker.
Forge can reach local workers through the [Ollama relay](development.md#ollama-relay).
Each worker pairs over TLS and has a private provider URL ending in
`/{workerId}/openai/v1`. The relay forwards Ollama's stateless Responses and
SSE stream. Provider health checks the worker's `/models` endpoint.

Ollama accepts **Ask** and **Full access**. Codex 0.164.0 requests a separate
`codex-auto-review` model for **Approve for me**, outside Forge's single-model
Ollama configuration. Forge rejects that selection until the owner chooses
another permission mode. The configured model and server must support streamed
stateless Responses with function calls and multiple developer messages. Verify
the chosen deployment and model with chat, tool execution, restart, and ticket
planning and implementation. On Ollama 0.40.16, `qwen3.8:27b` handled chat and
tool calls. The `qwen3.8-27b-turbo:q4_k_s` template rejected Codex's developer
messages with HTTP 500 and “System message must be at the beginning.” When
changing an Agent’s tag in Tasks, it takes effect when a phase next pins that Agent.

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

| Route                               | Contract                                                                                                                                                                                                   |
| ----------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET /api/agents/:id`               | `{thread,items,requests,truncated}`; no Codex thread IDs or internal workspace paths in metadata.                                                                                                          |
| `GET /api/agents/:id/options`       | Runtime models `{id,name,isDefault}` and enabled worktree skills `{name,description}`; no internal skill paths.                                                                                            |
| `GET /api/agents/:id/files?query=…` | At most 100 relative file paths from the chat's verified worktree. Empty query lists root files through the workspace tree API; nonempty query uses runtime fuzzy search. Query bounded to 500 characters. |
| `POST /api/agents/:id/resume`       | History loading and reconciliation; never sends input.                                                                                                                                                     |
| `POST /api/agents/:id/interrupt`    | Requests interruption of the known active turn.                                                                                                                                                            |
| `POST /api/agents/:id/replies`      | `{requestId,decision: "accept"/"decline"}` or `{requestId,answers:{questionId:text}}`.                                                                                                                     |
| `GET /api/agents/:id/events`        | Authorized SSE invalidations (`data: changed`); read the current view after each notification/reconnect.                                                                                                   |

Every operation rechecks owner access; HTTP mutations retain exact-origin checks.
Errors are `invalid-request` (400), `agent-not-found` (404), `agent-conflict` (409),
`agent-unavailable` (503), plus existing access/project/workspace failures. A
failed turn may expose a normalized `turnFailure` in the agent view for the chat
notice. Raw Codex diagnostics stay in operator logs. Conversation/tool text is owner-visible
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
turn timeout. Standalone chats run independently of ticket provider capacity. Failed
submissions preserve browser drafts for retry. SSE sends 15-second heartbeats,
disconnects slow consumers and closes on application shutdown. Reconnection reads
a current snapshot rather than replaying mutations.

Tests use injected service fakes, real Git/SQLite, controlled stdio peers and a
temporary credential-free pinned Codex process. The real probe verifies start,
interruption and history reload, not successful authenticated inference. Resuming
preserves newer live activity observed during the history read; unloaded or
system-error runtime states remain uncertain. Externally resolved server requests
invalidate both the transport reply and browser callback.

Ticket recovery uses the persisted phase routing and reservation through
interruption, ambiguous outcomes and explicit retries. Model fallback happens
before a phase is reserved. An Ollama outage discovered during inference follows
the pinned phase's recovery path. Startup restores existing occupancy before the
scheduler runs, and cancellation holds capacity until execution settles.
See [reservation behavior](tickets.md#agentic-ticket-board) and
[startup migration](development.md#named-provider-upgrades).

Opening ticket Chat automatically loads the current thread and reconciles
recoverable execution state. Running or waiting chats retain their live activity,
and untouched empty chats need no resume. Sidebar chats hide the internal
`uncertain` status and recover only when selected. The conversation shows a
history loading indicator and blocks sending until recovery completes. Recovery failures show a retry action;
polling does not repeatedly retry failed recovery. Drafts survive recovery.
Truncation is visible. SSE reconnects and periodic polling read current snapshots
through a serialized, coalesced reader; selected chats recover newly uncertain
state without replaying messages or approvals. No Markdown or tool HTML is
executed from conversation text.

### Following chat activity

Ticket Chat timelines initially open at the bottom and follow
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
browser memory. Ticket tabs retain the paused reading position. A new current
thread opens at its latest activity. The **Load more** button at the top of ticket
chat prepends one earlier thread per click, newest first. Prepending preserves the
visible reading position in a scrollable transcript. Loaded transcripts are cached
in browser memory and only the current thread polls and subscribes to live updates.

The conversation follows the Codex desktop layout: right-aligned user bubbles,
unboxed agent text and consecutive tool calls in one initially collapsed group.
Each tool expands to its output and displays its actual runtime status when
available. Running tool summaries use a sweeping text highlight, disabled with
reduced-motion preferences. Tool titles/statuses remain structured through output
deltas and history reloads. No project/workspace/worktree picker is exposed.
History, connection and workflow notices appear as centered status pills over the
transcript. Inference speed floats along the bottom edge. The ticket header uses
board activity icons for running and queued execution, with an error icon for failures.

The rounded composer grows from one to seven visible lines, then scrolls.
When the selected thread's worktree has changes, a pill above the composer shows
the file count and line totals from the [workspace summary](workspaces.md#integrated-agent-workspace).
Hover or activate the pill to see changed paths, with scrolling after five rows.
Enter sends; Cmd+Enter and Ctrl+Enter insert
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
its completed plan items. Ticket Chat uses the phase pin and ticket-wide permissions.

Native Codex plan items carry `kind: "plan"` in the browser contract and render
as Markdown assistant messages outside tool groups, identically for deltas and
restored history. Completed revisions stay visible. The [ticket Chat timeline](tickets.md#agentic-ticket-board)
combines planner and implementer history visually without duplicating Codex's
authoritative conversation storage. Approval uses the workflow's saved revision.

Managed ticket implementation and rebase turns support owner steering. Forge
verifies workspace ownership, serializes per-thread operations, and submits
`turn/steer` with `{threadId,expectedTurnId,input:[{type:"text",text,text_elements:[]}]}`.
The text item contains exactly the trimmed owner message. Skill references
continue to produce structured inputs. Keep cached assignments, plan text,
transcripts, report boilerplate and owner-guidance wrappers out of steering.
The response is `{turnId}` and must match the expected active turn. These shapes
were verified with `codex app-server generate-ts` from Codex `0.164.0`
against the [official steering documentation](https://learn.chatgpt.com/docs/app-server#steer-an-active-turn).
Steering starts no turn and adds no execution. Runtime completion remains
authoritative even if it precedes the steering response. Stale or inactive turns
are rejected; transport failures never trigger replay. Ticket workflow
serialization also prevents steering after completion/merge queuing. Waiting
structured requests use existing replies; planner feedback requires an idle or
failed workflow.

A follow-up on a settled implementation or rebase thread starts a turn on the
same thread with only the trimmed owner text, including after scheduler restart.
The assignment and earlier summaries remain in the conversation. If the turn
settles without a valid report, Forge can request the [completion report](#managed-implementer-completion-reports)
in a separate turn. See [fresh-thread recovery](tickets.md#implementation-context-handover).

Controlled Chromium tests cover independent threads, activity, interruptions,
reopening, failed sends/replies, approval/input, reconnects, automatic recovery and
mobile layout. Screenshots live under `artifacts/forge-browser/`. Authenticated
live ChatGPT inference remains a separate manual check.

### Cost and usage

The global Costs page at `/costs` reads `GET /api/costs` through the owner-only
API. Both cost endpoints accept `?range=-7d` and default to that range when
omitted. Use a positive whole number with `d` or `hr`; duplicate and malformed
values return 400. Days are rolling 24-hour periods. The page offers `-28d`,
`-7d`, `-1d`, `-12hr`, `-1hr`, and custom input in the top-right selector.
The selection is preserved in the URL and carried into the ticket Cost tab.
Usage and estimated API costs include whole turns by timestamp of turn start.
The stacked token chart groups those same turns into UTC days, or UTC hours for hour ranges
of at most 24 hours. The page also shows a ticket phase breakdown and
[per-ticket estimates](tickets.md#ticket-cost)
for every board ticket, including archived tickets, tickets with no repository
references and tickets without usage in the selected range. Ticket rows open
details on Costs and show no single-repository label. Ticket usage is aggregated
by ticket ID, independently of a turn's execution repository. See
[board ownership and execution context](tickets.md#agentic-ticket-board).
The OpenAI and Ollama cards compare token counts and AUD estimates for the selected
range, including historical repository chat usage. OpenAI shows the live weekly allowance remaining.
Ollama shows the OpenAI API equivalent and estimated weekly allowance saved. The
provider table groups named providers by type and shows API estimates to the cent
and each provider's share of recorded input plus output tokens to one decimal place.
`GET /api/costs` returns `providerTotals` by type and `providers` with those metrics
per named provider. Retired providers appear only when they have usage in range.
Legacy records without an ID count toward the sole known OpenAI provider, or appear
as OpenAI history when attribution is ambiguous. See [model providers](foundation.md#model-providers).

The Ollama equivalent prices uncached input, cached input and output using the
Ollama provider’s optional comparison model and the AUD exchange rate saved at dispatch.
The estimate is partial or unavailable when usage, benchmark pricing or FX is
missing. Ollama turns before tracking began have no backfill. Usage charts and
ticket token counts include both provider types. The [ticket cost estimates](tickets.md#ticket-cost)
use OpenAI turns for monetary and quota metrics.
The page retains manual refresh, retry, and five-minute refresh. Legacy project
Cost URLs and API routes are unknown routes with no redirects.
Cached input is included in input totals, and reasoning is included in output.

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
same notification. The gauge requires a sample, caps its ring at 100%, and shows actual usage in its tooltip, even above 100%. Context can shrink after compaction. Completed ticket chats
load stored history without resuming Codex in a removed worktree.

Account-wide quota windows come from `account/rateLimits/read` when available.
The current OpenAI section shows the live percent remaining for the sole weekly
window or the `codex` bucket when multiple weekly windows exist. If neither can
be read, the live figure is unavailable. The account details show reported
window length, percent used and reset time. A quota timeout leaves the shared
execution connection open.

#### Quota cost attribution

Weekly windows are identified by `minutes === 10080`: use the sole weekly bucket,
or the stable `codex` bucket when multiple exist. Missing or ambiguous selection
makes attribution unavailable. Consecutive observations in the same bucket and
reset cycle allocate the nonnegative increase in proportion to each turn's saved
API-cost increment, including historical repository chat usage in the denominator. SQLite saves
samples and interval allocations atomically and idempotently; repeated notifications,
restarts and dashboard reads cannot add duplicate turns or allocations.

Missing pricing, absent activity, counter decreases, reset boundaries, unavailable
selection and gaps over fifteen minutes leave observed consumption unallocated.
Per-bucket observed consumption equals ticket allocations plus chat allocations
plus unallocated consumption. Unobserved consumption is unknown. Raw observations
remain available independently of the dashboard and attribution selection.
The dashboard counts intervals whose ending observation falls after the range
start and at or before the response timestamp. Ticket and chat estimates include
the allocations from those intervals for turns that started in the range.
Effective USD cost is `percentage / 100 × monthlyPlanLocal / usdToLocal / 4.33`,
using each turn's saved values. Both quota attribution and effective cost are
estimates: account-wide counters include external activity and delayed updates.
See [billing and exchange rates](development.md#cost-settings) and
[ticket summaries](tickets.md#ticket-cost).

Ollama weekly allowance saved multiplies benchmark API-equivalent USD by observed
weekly percentage points per USD. Forge divides the sum of OpenAI allocation
percentages by the sum of those allocations' API-cost increments for one weekly
bucket in the selected range. Without a single bucket and positive observed
consumption, the estimate is unavailable for priced usage. Missing AUD FX affects
the AUD estimate independently. Savings can exceed 100% across multiple weeks.

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

Each bucket uses observations across all projects within the selected range. Valid
intervals are consecutive samples in the same reset cycle, at most fifteen minutes
apart, with no counter decrease. Consumption sums positive percentage-point changes;
the denominator counts first-time Done transitions in those intervals, including
archived tickets. Historical completion times remain unknown. At least 24 observed
hours, three completions and positive consumption are required. Capacity is
`floor(remaining percentage / (consumption / completions))`: 40% remaining with
5 percentage points per ticket gives approximately eight additional tickets.
Fresh exhausted allowance shows zero; samples older than fifteen minutes or past
reset suppress estimates. The response includes sample size and observed period.

The response includes the resolved `weeklyBudget.window` bounds. The responsive burndown
uses those bounds, shows all recorded cycles and gaps over fifteen minutes, and marks
each recorded cycle's start at 100%. Each cycle has a clipped dashed linear reference
from its weekly start to its reset. A range beginning mid-cycle starts with its first
recorded observation. A labelled selector defaults to the lowest remaining bucket.
Both time charts use Recharts and expose values on hover and keyboard focus.
This is budget capacity, not a guarantee of completing work in the remaining time:
other account activity and changing ticket complexity affect it.
It imposes no spending cap or scheduler enforcement.

## Managed implementer completion reports

Managed Implementer work, including rebase and owner-guided turns, requires a single JSON completion report. Ordinary assignments and report-only requests advertise complete, incomplete and handoff. Forge requires an explicit complete verdict for the full assignment before advancing a subtask or queuing a merge. A valid incomplete report can trigger up to three automatic work follow-ups over the lifetime of the same chat, including reports from ordinary clarifications; after that, owner guidance is required. Emergency steering requests an immediate complete or handoff report, and emergency handling does not trigger incomplete continuations. An emergency handoff starts a successor on the same worktree even when investigation or uncommitted work remains. Forge validates the last nonblank line of a managed completion reply as a fallback when the full reply fails validation. Forge can request one report-only clarification when headroom permits. See [ticket completion and handover](tickets.md#implementer-completion-and-handover) and [implementation context handover](tickets.md#implementation-context-handover).

# Agent usage overview

The Agents overview joins provider usage from the existing Costs API for the last seven days. Cached input tokens are included in input tokens; incomplete token records are flagged. See [provider overview](foundation.md#provider-overview) and [ticket scheduler metrics](tickets.md#agent-scheduler-metrics).
