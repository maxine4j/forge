# Forge agent instructions

## Project

Forge combines local Git hosting, a ticket board, pull requests, a browser IDE, and Codex in one web app.

The documents below define Forge requirements. Update the relevant document when changing a contract and cross-link related topics.

## Working rules

- Use `apply_patch` for edits. Run `nvm use` from the repository root before Node.js commands.
- Use the pinned Node.js 24, pnpm, TypeScript, Vitest, Playwright, and Oxc toolchain. Ask the owner before adding third-party dependencies.
- Keep backend side effects behind injected interfaces. Use the workspace infrastructure package for filesystem operations, YAML, timers, and logging.
- Keep credentials out of API responses and preserve persistent data and credentials during resource removal.
- Follow the [development checks](docs/development.md#development-checks). Keep process and startup wiring in `main.ts` and `start.ts`, and keep business logic in separately tested modules.

## Read for the task

Read [architecture](docs/architecture.md) before changing service boundaries, persistence, or package layout. Read only the additional documents needed for the task.

| Task                                                                            | Required reference                              |
| ------------------------------------------------------------------------------- | ----------------------------------------------- |
| Owner access, account setup, projects, configuration, HTTP and static assets    | [Application foundation](docs/foundation.md)    |
| Codex app-server, execution lifecycle, standalone chats, approvals and recovery | [Codex and interactive agents](docs/agents.md)  |
| Worktrees, file editing, terminals, diffs and manual PR review                  | [Workspaces and PR review](docs/workspaces.md)  |
| Ticket board, scheduling, planning, implementation and ticket merges            | [Ticket workflow](docs/tickets.md)              |
| Git hosting, branch protection, GitHub Actions and CI-gated merges              | [Git hosting and remote CI](docs/git-and-ci.md) |
| Local development, verification, image packaging and deployment                 | [Forge development](docs/development.md)        |
