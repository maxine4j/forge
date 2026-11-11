# Git hosting and remote CI

- Support project/repository creation and import; authenticated HTTPS clone,
  fetch, and push; file browsing with syntax highlighting; commit and branch
  views; diffs; PR comments, approvals, check status, and merging.
- Use system Git and its HTTP backend rather than implementing the Git protocol.
- Protect `main` across agent operations and external pushes; explicit owner
  commits through the repository editor are permitted under the [repository editor contract](workspaces.md#slice-2-integrated-manual-workspace-and-pr-review).
  Receive-side enforcement is required for hosted Git pushes.
- The [ticket merge queue](tickets.md#agentic-ticket-board) automatically attempts a
  fast-forward update with expected-main compare-and-swap after implementation.
  If main has diverged, the implementer rebases and Forge retries. Future remote-CI
  candidate workflows below require a separate explicit contract change.
- Forge is authoritative for Git and PRs. GitHub is the CI execution mirror;
  initially do not create a second set of GitHub PRs or synchronize their reviews.
- Push an immutable candidate commit to a dedicated GitHub branch with a configured
  push-triggered Actions workflow. Track repository, workflow, candidate SHA, and
  attempt; a successful push alone does not establish that CI ran or passed.
- Poll the Actions API to recover status; signed webhooks may accelerate updates
  when an authenticated, reachable webhook endpoint is configured.
- Show CI status and remote log links in Forge's PR view. Run intensive CI builds
  on GitHub-hosted infrastructure, not on the homelab.
- Construct the final squash candidate against current `main` before CI. Advance
  `main` to that exact tested commit only if the expected base and approvals remain
  valid. If the base changes, rebuild and retest. Reconcile remote mirror updates
  separately from the local authoritative merge.

Use the local `~/repo/forgejo` source as a behavioural reference, especially Git
hosting, bounded diff responses, expected-head validation, and merge concurrency.
Forge remains a TypeScript implementation, not a Forgejo deployment or fork.

## Sync Forge main with GitHub

The owner can sync a ready Forge project imported from
`https://github.com/maxine4j/forge` through its [Code page](workspaces.md#slice-2-integrated-manual-workspace-and-pr-review).
The saved import source identifies the repository. GitHub HTTPS requests use
the GitHub CLI credential helper and the persistent account configured in Forge.

Owner-only `GET /api/projects/:id/repository/github-sync` reports `ready`
with ahead and behind counts, `unavailable` if the comparison failed, or
`unconfigured` for other projects. Git reads GitHub's current `main` and
fetches missing objects without updating branch refs. Counts compare the two
commit graphs. `POST` to the same route requires the configured browser origin
and an empty body or object, then compares fresh refs and returns `{head}` on
success. One sync can run at a time.

Sync fast-forwards local `main` or creates a clean two-parent merge in the
bare repository, then pushes if GitHub needs commits. Forge updates local
`main` with an expected-head check and GitHub with a normal push. Conflicts and
unrelated histories leave both branch refs untouched. If a push fails after
the local update, Forge reports the partial result and retains the local head.
A retry compares the current refs again. Restart never replays a push.

The API reports fixed errors for conflicts, concurrent changes or sync
(409), unavailable refs or comparison (503), a failed push (502), and
unconfigured projects (404). Push failure has a distinct error code when
local `main` was updated.
