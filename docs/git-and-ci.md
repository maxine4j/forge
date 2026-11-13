# Git hosting and local pipelines

- Support project/repository creation and import; authenticated HTTPS clone,
  fetch, and push; file browsing with syntax highlighting; commit and branch
  views; diffs; PR comments, approvals, check status, and merging.
- Use system Git and its HTTP backend rather than implementing the Git protocol.
- Protect `main` across agent operations and external pushes; explicit owner
  commits through the repository editor are permitted under the [repository editor contract](workspaces.md#slice-2-integrated-manual-workspace-and-pr-review).
  Receive-side enforcement is required for hosted Git pushes.
- The [ticket merge queue](tickets.md#agentic-ticket-board) automatically attempts a
  fast-forward update with expected-main compare-and-swap after implementation.
  If main has diverged, the implementer rebases and Forge retries. Manual pipelines
  do not change this behavior or gate merges.
- Forge is authoritative for Git and PRs. Local GitHub Actions execution through
  bundled act is the CI direction; a GitHub execution mirror is not required.

Use the local `~/repo/forgejo` source as a behavioural reference, especially Git
hosting, bounded diff responses, expected-head validation, and merge concurrency.
Forge remains a TypeScript implementation, not a Forgejo deployment or fork.

## Manual local pipelines

The Pipelines tab discovers `.github/workflows/*.yml` and `*.yaml` on the selected
local branch (default `main`), displaying names with filenames. Events come from
`on`; default selection is `workflow_dispatch`, then `push`, then the first event.
Dispatch inputs use defaults; required inputs without defaults prevent dispatch.
Payloads contain the ref, immutable commit and synthetic `forge/<project UUID>`
repository identity. Events requiring more context may fail. Custom payloads,
secrets, automatic triggers, merge gating, logs and artifact browsing are out of scope.

One pipeline runs globally; overlaps return 409. Submission resolves and
revalidates branch/workflow/event before launch. The deadline is 60 minutes.
Checksum-verified act v0.2.97 uses only the internal daemon at
`unix:///run/forge/docker.sock`, mounted at `/var/run/docker.sock` inside runners.
No host socket or ambient Docker context is used. Ubuntu 20.04/22.04/24.04 labels
map explicitly to digest-pinned catthehacker images; `ubuntu-latest` maps to 24.04.
Unsupported labels, dynamic runner expressions, reusable workflow jobs and dynamic
matrices are rejected. Static matrices support include/exclude and at most 256 jobs.
Act images approximate GitHub runners; they do not reproduce every hosted capability.

Act starts from a private invocation/home/config/cache directory, with an
allowlisted environment and no ambient `.actrc`, `.env`, `.secrets`, `.vars`,
`.input`, Docker credentials, Forge GitHub or Codex account. Verbose environment
logging is disabled. Workflow host bind mounts and container options are restricted.
Private actions and GitHub services requiring credentials may fail.

Each run gets a disposable local clone of its commit under
`<dataDirectory>/artifacts/<runId>/source`, independent of editor/ticket worktrees.
Execution YAML comes from that commit with only its display name changed to
`forge-<runId>` to attribute act resources after crashes. This also changes
`github.workflow`. Local checkout optimization remains enabled; `actions/checkout`
uses the snapshot unless the workflow explicitly requests another repository/ref.
Act bind-mounts only the disposable source clone so workflows without a checkout
step also see the selected commit. Workflow changes to this clone are disposable.

SQLite persists run metadata, ordered job/step states, timestamps, matrix identity
and failure summaries. Step IDs/phases distinguish duplicate names and action
pre/post execution. Continued failures retain failed outcomes even if act succeeds.
Act's exit result determines overall success; missing status records never imply
success. Parsing follows the pinned release's structured logger/step/job fields.
Records over 64 KiB are discarded; diagnostics retain at most 10 MiB per run while
subsequent status events continue to be consumed.

Timeout/shutdown stops owned process groups and cleans attributed containers,
networks, volumes and disposable source. Restart interrupts unfinished runs and
reconciles cleanup without replay. Failed cleanup is retried at startup. Shared
image caches and act's shared tool cache may remain. Repository and account data
are preserved. Board Docker cleanup may terminate a pipeline and act's failure
settles that run. See [storage](architecture.md#persistence-and-recovery),
[verification](development.md#local-pipeline-verification) and
[workspace UI](workspaces.md#pipelines).

Owner-authorized browser-safe contracts live in `@forge/contracts/pipelines`:

| Route                                          | Behavior                                                                     |
| ---------------------------------------------- | ---------------------------------------------------------------------------- |
| `GET /api/projects/:id/pipelines?branch=main`  | Commit, workflow files/names/events and validation messages                  |
| `POST /api/projects/:id/pipeline-runs`         | `{branch, workflowPath, event}`; 202 persisted run; matching origin required |
| `GET /api/projects/:id/pipeline-runs?offset=0` | 20 recent runs and `hasMore`, offset pagination                              |
| `GET /api/projects/:id/pipeline-runs/:runId`   | Project-scoped metadata and job/step states                                  |

Invalid/stale selections return 400, overlaps 409, missing runs 404 and unavailable
Docker 503. The UI polls selected active runs every two seconds, stopping on
terminal state/navigation. Text labels accompany colors; empty/invalid workflows,
unavailable Docker and execution failures have visible messages.

## Sync with upstream

The owner can sync any ready repository with a Git remote named `upstream`
through its [Code page](workspaces.md#slice-2-integrated-manual-workspace-and-pr-review).
The [project API](foundation.md#repositories-and-imports) exposes eligibility
from actual remote presence so Code can show the action before checking drift.
The configured upstream URL must satisfy the same credential-free HTTPS,
port 443 and configured host restrictions as imports. GitHub HTTPS requests use
`gh auth git-credential`, scoped to `github.com`, and the persistent account in
`<dataDirectory>/github` via `GH_CONFIG_DIR`. Remote comparison, fetch, and push
all use this authenticated transport, which excludes ambient GitHub tokens.
Credentials remain in the helper rather than being copied into arguments,
remote URLs, or application storage. [GitHub login](foundation.md#account-login-and-application-access)
requests the additional `workflow` scope for workflow-file pushes.

Owner-only `GET /api/projects/:id/repository/upstream-sync` reports `ready`
with `branch`, ahead and behind counts, `unavailable` if the comparison failed, or
`unconfigured` when upstream is absent. Git discovers upstream's live symbolic
`HEAD` with `ls-remote --symref`, validates its branch and
fetches missing objects without updating branch refs. Counts compare the two
commit graphs for the same-named local branch. Missing/invalid symbolic HEAD,
missing remote or local branches, and unreadable remotes are unavailable; no
branch is guessed or created. `POST` to the same route requires the configured
browser origin and an empty body or object, then compares fresh refs and returns
`{head, branch}` on success. One sync can run at a time globally.

Each operation captures the URL, branch and observed heads, using that target
consistently even if configuration changes during the operation. Sync fast-forwards
the local branch or creates a clean two-parent merge in the bare repository,
then pushes if upstream needs commits. Forge updates the local branch with an
expected-head check and upstream with a normal push, never a force push. Forge's
own symbolic HEAD remains unchanged. Conflicts and
unrelated histories leave both branch refs untouched. If a push fails after
the local update, Forge reports the partial result and retains the local head.
A retry compares the current refs again. Restart never replays a push.

The API reports fixed errors for conflicts, concurrent changes or sync
(409), unavailable refs or comparison (503), a failed push (502), and
unconfigured projects (404). Push failure has a distinct error code when
the local branch was updated. Error codes use the `upstream-sync-` prefix:
`unconfigured`, `unavailable`, `busy`, `conflict`, `changed`, `push-failed`, and
`push-failed-local-updated`. There is no GitHub-specific sync API.
