# Forge workspaces and PR review

## Navigation history

Global destinations, repository sections, editor file tabs, commit details and
history use React Router URLs. Selecting the displayed section or file does not
add a duplicate history step. Back/Forward retraces deliberate selections.
Mobile **Back to chats** returns to its known list ancestor, skipping intervening
chat selections; direct chat links fall back to the list route with replacement.
Chat drafts remain retained while browsing. Editor drafts still require commit
or discard before leaving their retained repository; the shared
[application guard](foundation.md#navigation) preserves this restriction.
Task modal ancestry follows the [task navigation contract](tickets.md#task-navigation).

## Slice 2 terminal contract

The supported terminal runtime is the Node 24 Linux container. Native
macOS/Windows terminal requests return `terminal-unavailable`; health, accounts,
and workspace APIs remain available. `node-pty` 1.1.0 and `ws` 8.22.1 are pinned;
native build prerequisites live in image build stages and the integration
runner. Native-module loading is deferred until terminal creation.

Browser contracts are exported from `@forge/contracts/terminal`.
Owner services verify workspace ownership and readiness before starting
`/bin/bash --noprofile --norc -i`
at its verified path. Shell environment contains only PATH, workspace HOME,
LANG, TERM, `HISTFILE=/dev/null`, and `ENV=/dev/null`; ambient credentials and shell
startup configuration are excluded. The shell shares the application's mounted
storage and UID. Workspace API branch protection is not hostile shell containment;
arbitrary shell commands can change shared files and Git metadata. No pause or
foreground-job suspension guarantee is offered.

| Route                                  | Contract                                                                                                                   |
| -------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| `POST /api/workspaces/:id/terminal`    | Create `{cols,rows}`; returns session, HTTP 201. Browser calls automatically when needed; never implicit on socket attach. |
| `GET /api/workspaces/:id/terminal`     | Latest retained `{session?}`; absence is `{}`.                                                                             |
| `GET /api/terminals/:id`               | Inspect one session.                                                                                                       |
| `DELETE /api/terminals/:id`            | Close live shell, await cleanup, retain metadata/files.                                                                    |
| `WS /api/terminals/:id/socket?after=N` | Attach an existing session; exact configured HTTPS Origin and owner required before upgrade.                               |

Sessions expose UUIDs, workspace ID, dimensions, timestamps, normalized
`starting/running/exited/closed/lost` status, and optional exit code; never paths,
PIDs, raw diagnostics or environment. SQLite intent precedes spawn. Startup marks
interrupted active records `lost`. Disconnect only detaches the browser. Opening
the Terminals tab automatically inspects the latest session, attaches a live
session, or creates one when absent or ended/lost. While mounted, the browser
automatically replaces ended/lost shells and reconnects disconnected sockets.

On touch devices, focusing the terminal and reducing the keyboard-closed viewport
height by at least 120 CSS pixels and 20% opens a single horizontally scrollable
keyboard row: **^R · ^C · Esc · Tab · Ctrl · ← · ↑ · ↓ · →**. Targets are at least
44px. The row follows the visible viewport bottom (including offsets), reserves
space for the terminal cursor, and refits xterm. Detection supports both visual
and layout viewport shrinkage, falls back to window dimensions, ignores pinch
zoom, and reacquires its closed baseline after orientation changes. Floating
keyboards are outside this contract.

Toolbar gestures retain terminal focus. Ctrl is a one-shot modifier: a single
ASCII letter becomes its control character, case-insensitively; other input,
including pasted/composed multi-character text, passes intact and clears Ctrl.
Tapping Ctrl again cancels it. Dedicated keys clear Ctrl and send their stated
bytes through xterm's public `input()` API and the existing `onData` stream path.
Arrows follow xterm's current normal CSI or application-cursor SS3 mode. Buttons
are disabled while disconnected and input is never queued for reconnection.
Keyboard dismissal, focus leaving the terminal/toolbar, an inactive terminal tab
or navigation away hides the row and clears Ctrl without detaching retained shells.
Additional shortcuts (^D, ^Z, ^L, ^A/^E, ^W/^U/^K) remain available through Ctrl;
their interpretation depends on the shell or terminal application. See
[device verification](development.md#terminal-keyboard-device-verification).

WebSockets accept JSON `{type:"input",data}` or `{type:"resize",cols,rows}`.
Server frames are `{type:"output",sequence,data}`, `{type:"gap",through}`, and
`{type:"status",session}`. Sequence starts at 1 per session; reconnect supplies
the last rendered sequence as `after` (default 0, nonnegative safe integer).
Replay precedes status and subsequent live output. A gap means bytes through
that cursor are unavailable; reconnect to a retained ended/lost session sends a
gap at the supplied cursor then status. Clients must show the interruption and
must not infer a new shell from an empty replay. Transcripts are bounded transient
memory, never authoritative durable history. Terminal bytes are never logged.

Bounds: one live shell per workspace, eight live shells overall, 1000 retained
session records, four browser attachments per live shell, 32 sockets overall,
16 pending upgrades (five-second deadline), four queued frames per socket, and
64 service operations. Dimensions are 2–500 columns and 1–200 rows. Client wire
frames and input chunks are at most 16 KiB; accepted input is at most 1 MiB per
session. Replay holds at most 256 KiB/1024 frames; output chunks split at Unicode
code points. A slow socket is disconnected above 256 KiB queued output. A shell
closes after eight hours or 16 MiB output. Socket ping/pong detects abandoned
connections. Limits fail explicitly with fixed terminal error codes; automatic
browser retries respect the same limits.

Shutdown terminates sockets and owned PTY sessions before SQLite closure. Linux
`/proc` inventory uses the canonical filesystem boundary, captures session leader
start time and device, and selects groups by that SID, including ordinary jobs
whose controlling terminal clears on leader exit. It rejects a reused leader.
Terminal creation waits up to one second for the child to establish its session
and controlling terminal, and fails with `terminal-unavailable` if setup fails.
Inventory is capped at 4096 `/proc` entries and one second per cancellable scan.
Cleanup sends TERM, waits at most a
second, then KILL and awaits PTY exit with a one-second bound. Natural leader exit
also cleans remaining session groups. Tini reaps orphans. Processes deliberately
escaping their session (for example `setsid`) are outside this application cleanup
boundary. This is not a sandbox; containers retain the existing resource limits.

Run host unit tests/checks normally. On macOS the real Linux PTY integration cases
are explicitly skipped; `pnpm test:containers integration` runs them in the
supported Linux runner (whose Python/make/C++ tools build node-pty). Also run
`pnpm image` and `pnpm test:image` to verify nonroot glibc packaging.
The [node-pty build requirements](https://github.com/microsoft/node-pty#dependencies)
and [ws upgrade authentication](https://github.com/websockets/ws#client-authentication)
define the external adapter setup. No live credentials are needed for these tests.

## Slice 2 manual workspace foundation

Manual workspaces are project resources without tickets in milestone 2. Ticket
linkage and agent pause/edit/resume enter with the later ticket/agent slices;
this slice does not dispatch turns, schedule jobs, host Git HTTPS, run remote CI,
or merge `main`.

`@forge/contracts` exports workspace schemas from `workspace.ts`.
Workspace values contain ID, project ID, name, deterministic
`forge/workspace/{workspaceId}` branch, creation timestamp, creation `baseSha`,
status (`creating/ready/failed/archived`), and current `head` when ready. They never
contain filesystem paths. Creation starts from local `main`; an entirely empty
repository gets one empty Forge initialization commit on `main`. A nonempty
repository without `main` requires operator repair and fails closed. No API switches
checkout branches. The owner-only repository editor described below may commit
directly to any existing branch, including `main`, without changing checkout files.

Workspace routes, all subject to the foundation owner/origin policy:

| Route                                          | Contract                                                                       |
| ---------------------------------------------- | ------------------------------------------------------------------------------ |
| `GET/POST /api/projects/:projectId/workspaces` | List/create; creation accepts `{name}`.                                        |
| `GET/PATCH/DELETE /api/workspaces/:id`         | Inspect/rename/archive; PATCH accepts `{name}`.                                |
| `POST /api/workspaces/:id/retry`               | Explicitly retry failed creation; archived workspaces remain archived.         |
| `GET /api/workspaces/:id/tree?path=`           | One directory level, up to 1000 entries, explicit truncation.                  |
| `GET /api/workspaces/:id/file?path=...`        | UTF-8 text, SHA-256 content version.                                           |
| `POST/PUT /api/workspaces/:id/file`            | Exclusive create `{path,content}` / save `{path,content,version}`.             |
| `GET /api/workspaces/:id/diff`                 | Separate branch, staged, unstaged, untracked sections.                         |
| `POST /api/workspaces/:id/stage` or `/unstage` | `{paths}`: 1–100 explicit files; directories/globs are not staged recursively. |
| `POST /api/workspaces/:id/commit`              | `{message,expectedHead}`; atomic expected-head branch update.                  |

SQLite intent precedes worktree creation. Exclusive claims and immutable base
markers live beside worktrees, outside editable/visible source. Git worktrees are
locked against pruning; recovery verifies claims, repository ownership, linked
worktree metadata and branch identity before use. Interrupted creation may
complete; failed state needs explicit retry. Recovery never resets branches,
overwrites files, adopts unrelated paths, or deletes partial work. Manual
archives retain SQLite metadata, worktree, branch and files. File/Git operations
reject archived workspaces. [Done ticket cleanup](tickets.md#agentic-ticket-board) removes
the clean worktree and exact merged local branch, then archives its metadata.
The initial limit is 1000 retained workspaces across projects.

Files are limited to 256 KiB of valid UTF-8 without NUL. Absolute paths, traversal,
backslashes, control characters, symlinks, Git metadata and `.forge-*` components
are rejected. Existing parent directories are required when creating a file.
File mutation JSON bodies allow 2 MiB for JSON escaping; other bodies retain the
16 KiB limit. Version mismatches fail with `file-conflict`; simultaneous Forge
saves using one version have one winner. API operations share a serialized
application queue. Atomic replacement preserves executable permissions. These
checks detect observed external edits; arbitrary local shells share storage and
cannot provide cross-process atomic editor saves or hostile process isolation.

Branch diffs compare `merge-base(main, workspace)..workspace`, independently of
the recorded immutable creation base. Each of the four sections contains at most
100 paths, 1000 patch lines and 256 KiB patch bytes, with explicit `truncated`
metadata. Binary/non-UTF8 content has path metadata without text patches. Git
commands retain their 120-second/1 MiB process bounds; a diff command exceeding
its output bound yields explicit truncation. Restricted metadata is omitted from
diff previews and cannot be committed through Forge. Diff results are observations
of shared mutable Git/files, not transactional snapshots against terminal commands.

Safe errors are `invalid-request`, `workspace-not-found`, `workspace-unavailable`,
`workspace-conflict`, `file-not-found`, `file-conflict`, and `file-unsupported`.
HTTP maps them to 400/404/503/409/415 respectively, without diagnostic strings.
Services recheck owner authorization for all operations. Internal
`IWorkspaceService.resolve(actor,id)` returns the verified path for future terminal
integration; entry points must never serialize it. Future PR services can inspect
workspace identity/head through the same service interface. Startup initializes
the workspace store and completes recovery before listening.

## Ticket abandonment cleanup

The dedicated injected abandonment cleanup interface is separate from merged
worktree cleanup. After [ticket agents settle](agents.md#ticket-cancellation), it
closes the workspace terminal, removes the owned checkout including dirty and
untracked files, and deletes the unmerged branch. It retains claim/path, repository,
branch and linked-worktree ownership checks and rejects branches checked out
elsewhere. Branch deletion uses its expected tip. Missing runtime resources succeed
on retry, including a crash between checkout removal and branch deletion.
Workspace metadata becomes archived; repositories, agent records, usage and
credentials remain. The [ticket workflow](tickets.md#abandonment-and-restart)
persists failures and retries at startup, on scheduler ticks and through reconciliation.
Merged cleanup still requires a clean checkout and a candidate reachable from main.

## Slice 2 integrated manual workspace and PR review

Forge uses a dark GitHub-style layout throughout. Global navigation is Tasks
(`/tasks`), Repos (`/repos`), [Costs](agents.md#cost-and-usage) (`/costs`), and Config
(`/config`). ChatGPT/GitHub account login and settings live on Config. Visiting
Tasks, Costs or Config keeps the repository workbench mounted, including editor
and chat drafts, reading position and terminal connections. Navigation that would
discard uncommitted code is guarded.

Repos opens directly to the repository list. Create repo opens the
[creation and import dialog](foundation.md). Ready repository cards link to
`/repos/:repositoryId/code`. Repository sections are Code, Agents, Pipelines and
Terminals. The global header's home link opens Tasks, and `/` replaces its
history entry with `/tasks`. The [global ticket board](tickets.md#agentic-ticket-board)
is independent of the
repository workbench. Code is the default repository section; Agents provides
[interactive chats](agents.md#interactive-agents), and Pipelines provides
[local workflows](git-and-ci.md#manual-local-pipelines).
Tab navigation stays usable on narrow screens without widening the page.
Repository tabs share the Tasks tab styling and pair each label with an icon.
All repository tabs share the Agents spacing below the global header:
16px on desktop and 8px at widths up to 700px, with matching tab padding and
spacing below the tab bar.
Agents and Tasks fill the remaining visible viewport on laptop, slab-phone and
square folding-phone layouts without vertical page scrolling. Opening a virtual
keyboard shrinks the entire layout, including secondary chat columns. Only the
chat thread list and conversation log scroll vertically in Agents; requests are
part of the conversation log and the composer remains visible. Task columns
scroll vertically independently with their headings fixed at the top; the board
scrolls horizontally to reach other statuses.
Ticket creation dialogs fit the visible viewport and scroll internally while the
virtual keyboard is open. Ticket details open in a right sidebar on laptop and
square folding-phone screens, and occupy the full viewport below 601px. Title and
description are separate from the conversation. Details and Chat views retain
independent content, the chat composer stays visible, and only the conversation
log scrolls within the chat view. Planning history remains readable after starting
the fresh implementation conversation.

React Router uses the browser History API for `/repos/:repositoryId/code`,
`/agents`, `/pipelines` and `/terminals` under the same repository prefix.
An individual chat uses `/repos/:repositoryId/agents/:threadId`.
Task selection uses `/tasks?ticket=:id`. Removed `/projects` browser routes and
repository Tasks/Cost sections show not-found without redirects. Code selection
uses URL query parameters: `branch` is the exact Git branch name, `path` is the
directory, `file` is the repository-relative active file, and `view=history` opens
branch commit history. Query values are URL encoded, including slashes in branch
names. `/` replaces its history entry with `/tasks`. Unknown routes and
unavailable projects/branches show explicit states rather than a different view.
Project cards and section tabs expose real links, supporting new tabs and copied
URLs. Direct links, reloads and browser Back/Forward restore the URL's view;
Android Back uses the same browser history. Navigation never replays messages or
approvals. Opening Agents may resume the selected chat to load history; opening
Terminals uses the documented automatic terminal inspection/create flow. Reload
reattaches its retained live shell without creating a duplicate.

Clicking Code opens the directory listing for the last selected branch and
directory. The Code tab does this even when already selected. Returning to Agents
restores its last chat URL, which also determines the [mobile Agents screen](agents.md#interactive-agents):
at widths up to 700 CSS pixels, `/agents` shows the chat list and
`/agents/:threadId` shows the conversation with **Back to chats**. Direct links,
reloads and browser Back/Forward honor that screen. Returning from Code restores
the last Agents screen, including the list. Wider screens show both panes and
select the first chat from the base URL. Resizing an open chat preserves it;
widening the list selects the first chat. Visited conversations remain mounted
and running through list and section navigation, retaining drafts and reading
position. Only the visible pane participates in keyboard navigation.
URL navigation within a repository and to Tasks, Config or Costs retains local editor/chat drafts and
visited terminals. Project exit, including browser history and global navigation,
blocks while code drafts remain uncommitted; commit or discard them first.
Reload/unload retains the native unsaved-code warning. Draft contents are not
stored in URLs or persisted across reloads. Ticket forms remain native modal
`<dialog>` overlays with Escape dismissal and no history entries; Popover API is
not used for modal forms.

Workspaces are internal execution resources, not a user-facing concept. Do not
show workspace creation, selection, archival, names or raw
execution identifiers. The terminal adapters use the internal
workspace APIs: reuse the project's retained non-archived checkout (prefer the
internally named Project files checkout), or prepare one automatically when none
exists, only after opening Terminals. A failed checkout requires explicit
Retry opening files. Preparation
never starts an agent or shell. Preserve existing files and metadata.

Code contains a GitHub-style bordered directory listing followed by a safe README
preview. Directory listings and the editor's file tree show every returned entry
without Show all/Show fewer controls; the 1,000-entry server bound remains explicit. Folder and common file
types have themed icons. Opening a file replaces the overview with the editor;
Back to files preserves drafts. The left directory tree appears alongside code on
tablet and laptop widths (above 600 CSS pixels), and is hidden on slab phones.

The branch dropdown lists all local branches and defaults to `main`, or the first
branch when `main` is absent. Every branch supports owner editing. There is no
Working changes option. Listings read committed files and show each entry's latest
commit subject and date. Browsing and committing never switch or reset a checkout.
For any ready repository with an upstream remote, **Sync** appears
on every branch before counts load, identifies the resolved target branch when
available, and shows each nonzero count for commits
ahead (↑) or behind (↓) to the left of the button label. Code checks the counts when
opened, every 30 seconds while visible, and after committing or syncing.
While the user-triggered sync request is pending, the disabled button shows a
decorative spinner beside **Syncing…** and exposes `aria-busy`. Success or failure
removes the spinner and restores **Sync**. Background drift checks do not show
this loading state, and the spinner respects reduced-motion preferences.
An eligible empty repository shows a disabled **Sync** button until the upstream
default branch exists locally.
Commit or discard editor drafts before syncing; drafts on any branch disable the
action with branch-neutral guidance. Code refreshes the affected branch's content
after success, including when browsing another branch, and refreshes counts after
an attempt. Sync results and repository operation errors use the application-wide
[shared notification queue](foundation.md#shared-notifications), with three seconds
per visible toast, repeat counts and click, tap or keyboard dismissal. Existing
sync and commit success notifications use this same queue. File, diff, clipboard,
terminal and commit failures retain their retry controls and local drafts after expiry.
See [upstream sync](git-and-ci.md#sync-with-upstream) for failure outcomes and
[imports](foundation.md#repositories-and-imports) for upstream configuration/recovery.
Directory tables, including the root, use Name, Last commit message and Last commit
date headers. Nested directories start with a `..` folder entry for navigating up.
Breadcrumbs start with the repository's project name followed by directory segments.
File tabs appear above and encapsulate the active
file heading, Back to files, history action and editor. Tabs have a distinct active
surface and accent border, rather than standalone button styling.
The history icon sits to the right of **Last commit date** in the directory and
history views. It opens the selected branch's commits, thirty at a time.
Pagination rejects a changed branch head rather than mixing histories.

Repository read APIs are under `/api/projects/:id/repository`: `branches`,
`tree?branch=&path=`, `file?branch=&path=`, and `history?branch=&offset=`. They
validate owner/project readiness, exact branch names and safe paths. Git reads
resolve the branch to a commit before reading content. They use bounded system
Git commands, at most 1,000 branches/entries, at most eight concurrent per-entry
log reads, and the existing 256 KiB text-file bound. Symlinks, submodules, binary
content and restricted metadata cannot be opened as code. Errors reuse the safe
workspace/file error contract. Repository HTML is displayed as text, never executed.

History subjects and short SHAs link to `/repos/:id/code?branch=…&view=commit&sha=…`,
retaining `path` and `file` for return navigation. Commit pages preserve mounted
editor drafts. `diff=unified|split` (default unified) and
`ignoreWhitespace=true|false` (default false) retain rendering preferences in the
URL. The filterable changed-file tree groups files into collapsible folders and
shows GitHub status icons and colored pills. The tree is sticky on desktop and
can be collapsed on mobile, where patches scroll horizontally. File panels
collapse independently.

Owner-authorized `GET /api/projects/:id/repository/commits/:sha` returns validated
commit metadata, parents, comparison base, original changed-file membership and
statistics. Only full commit SHAs are accepted. Branch is navigation context.
Ordinary and merge commits compare to their first parent; roots compare to the
empty tree. Empty commits explicitly report no changed files.
`GET /api/projects/:id/repository/commits/:sha/diff?path=…&ignoreWhitespace=true|false`
returns one file's structured hunks with old/new line numbers, status, modes,
binary/submodule and truncation indicators. Whitespace filtering affects patches
and displayed panel statistics, preserving the original file list and labeled
commit totals. Repository content is rendered as text, including newline markers.

Commit reads use the injected bounded Git transport, NUL-delimited metadata,
rename detection limited to 1,000 candidates, and disabled external diff/textconv.
File listing is capped at 1,000 entries; each displayed patch at 1,000 lines and
256 KiB. The existing 1 MiB command output bound remains. Incomplete listings,
statistics and patches are explicitly labeled; a command exceeding its bound
provides an incomplete placeholder. Binary/non-UTF-8 and submodule changes have
text placeholders. Patches load near the viewport with at most four in-flight
requests, ignoring stale results after SHA or whitespace navigation. Workspace
and PR diff contracts are unchanged.

Code omits Changes and Pull requests; those interfaces are deferred. Terminals
contains a single automatically managed terminal and output, without create,
refresh, reconnect or close buttons. Remove infrastructure notes, raw revision
summaries and session IDs from the primary UI; retain actionable errors,
terminal connection/loss states and local drafts after commit failures.
Git HTTPS hosting and merging remain unavailable.

The Code editor reads committed branch content. New-file creation in the browser
is deferred; the Code UI only opens existing files. Edits remain in
browser memory, scoped by branch and path, until Commit submits all changed drafts
for that branch in one request. Switching branches, files, project sections or
Config retains drafts. Project exit and page unload guard uncommitted drafts.
There is no Save file or server-version comparison action. Commit failures retain
drafts and the commit message. Discard all drafts explicitly clears that branch's
drafts and reloads its current head; copy needed edits before discarding. Typing
during a pending commit remains dirty after the submitted snapshot succeeds.

`POST /api/projects/:id/repository/commit` accepts
`{branch, expectedHead, message, files: [{path, content}]}` and returns `{head}`.
It rechecks owner authorization, matching origin, project readiness and exact
branch existence. It allows the owner to edit any existing branch, including
`main`; agent/workspace and future merge operations retain their separate guards.
Inputs allow 1–100 unique text paths, 256 KiB per file, 1 MiB combined UTF-8
content and a nonempty message of at most 4,096 characters. JSON is bounded to
7 MiB for escaping overhead. Unsafe paths, symlinks, submodules, conflicting
file/directory paths and empty changes fail before updating refs. Git object/tree
construction preserves untouched entries and executable modes. One atomic
expected-head ref update publishes the complete commit, with no checkout or index
writes. A moved branch returns 409 `workspace-conflict`; no automatic rebasing or
retry occurs. Empty repositories show an explicit no-branches state.

The separate terminal uses xterm.js 6 and its fit addon. API responses are
validated against browser-safe contracts. External shell edits remain subject to
the [workspace version-check boundary](#slice-2-manual-workspace-foundation).
The workspace and PR adapters share `GitDiffClient` for tracked patches.

Opening the Terminals tab automatically creates or attaches its single workspace
shell. Disconnects retry with bounded backoff (500 ms to eight seconds), first
inspecting status so a failed creation response or another browser cannot cause
duplicate live shells. A live shell is reattached; exited, closed or lost shells
are replaced automatically with a brief recovery notice. Replay gaps remain
visible for the same session. Leaving the project cancels retries and detaches
the socket while the shell remains running; switching project tabs retains it.
Reconnect drains xterm's public write queue
before choosing the rendered cursor, and new sessions reset the display only
after old writes drain. Input chunks include JSON escaping in the 16 KiB wire
bound. Fit observes container resize and sends bounded PTY dimensions.

PR summaries contain metadata only; patches/discussion are fetched on explicit
detail/diff reads. The browser loads a committed diff before enabling revision
mutations. Detail and diff revisions must match; mismatch/failure clears the
actionable diff. Create explicitly previews the current refs; review/comment,
metadata and status mutations send the refs of the displayed diff. Backend
`revision-conflict` requires an explicit refresh, so a stale displayed patch
cannot be approved using independently refreshed refs. Approvals become stale
if either main or workspace HEAD changes. Archived/failed/missing source
workspaces retain metadata/discussion while approval is unavailable.

Browser-safe PR contracts are exported from
`@forge/contracts/pull-requests`. All routes retain owner/origin checks:

| Route                                                    | Contract                                                                       |
| -------------------------------------------------------- | ------------------------------------------------------------------------------ |
| `GET/POST /api/projects/:projectId/pull-requests`        | Summary list / create `{workspaceId,title,body,expectedHead,expectedBase}`.    |
| `GET /api/workspaces/:workspaceId/pull-request-revision` | `{revision,hasChanges}`; `baseSha` is current main, with separate `mergeBase`. |
| `GET/PATCH /api/pull-requests/:id`                       | Detail / expected refs plus optional title/body or `status: open/closed`.      |
| `GET /api/pull-requests/:id/diff`                        | Explicit committed patch, comparison label and revision.                       |
| `POST /api/pull-requests/:id/comments`                   | Expected refs and body.                                                        |
| `POST /api/pull-requests/:id/reviews`                    | Expected refs, body and `approve/request-changes`.                             |

There is no merge endpoint. Review requests and discussion persist in SQLite;
startup initializes their store and registers the production router. Tests cover
real Git revision races, persistence and unavailable sources, controlled browser
editor/terminal/branch-commit flows, mobile width and screenshots. A separate production
bundle fixture uses the actual `HttpApplication` CSP and `StaticAssets`, without
Vite's development runtime, to check terminal style compatibility. This check must
pass before the integrated UI is considered production ready; do not weaken CSP
or patch third-party DOM internals to bypass a failure.

Run the checks listed [in Forge development](development.md#run-package-and-verify-slice-1), plus
`pnpm test:containers integration` for the supported Linux PTY runtime. The image
smoke verifies production workspace/PR routing and native terminal packaging.
Browser artifacts remain under `artifacts/forge*`.
The browser suite starts its own Vite server on loopback port 5176 in `test`
mode with a separate dependency cache, so it does not reuse or invalidate the
owner's mock preview on port 5174.

Production CSP explicitly permits generated style elements through
`style-src-elem 'self' 'unsafe-inline'`, approved after the production xterm probe
demonstrated eight blocked style elements under the original policy. All script
and other restrictions remain. The integrated production browser case checks
the actual built application/editor/terminal on desktop and mobile, no unexpected
policy violations, real syntax colors/output, and an intentional inline script
that remains blocked. It uses controlled API/WebSocket data; native PTY/PR runtime
behavior is verified separately in Linux integration and the real image smoke.

## Pipelines

The project Pipelines tab runs committed workflows from disposable clones, separate
from editor and ticket worktrees. Branch/pipeline/event dropdowns and a Run button
sit above recent run history. Selected runs show immutable commits and ordered
steps grouped by matrix job, with text states. Active runs poll every two seconds;
leaving the tab stops polling. No workflow editor, log viewer, graph or artifact
browser is included. See [the manual pipeline contract](git-and-ci.md#manual-local-pipelines)
and [verification](development.md#local-pipeline-verification).

## Integrated agent workspace

One screen must combine:

- Agent conversation, streamed activity, approvals, sending messages, and
  interruption controls.
- Branch changes against `main`, a changed-file list, and inline diffs. Use the
  merge base of `main` and the branch for the branch's introduced changes; label
  the comparison clearly. Show staged, unstaged, and untracked workspace changes
  separately so edits are visible before commit.
- A file tree, editor tabs, file opening/saving, and basic syntax highlighting.
- A PTY-backed interactive terminal rooted in the ticket worktree, with resize and
  reconnect support. Browser disconnection must not silently start a second shell;
  distinguish reconnecting to a live terminal from a shell lost on process restart.
- PR discussion, CI results, approval/request-changes controls, and merging.

Generate diffs from Git with explicit file/line/output bounds and binary handling.
Prevent silent editor/agent overwrites with file-version checks and an explicit
pause/edit/resume workflow. Do not promise full language-server, debugger,
extension-marketplace, or collaborative-editing support for the initial version.
