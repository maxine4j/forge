# Forge

Forge combines local Git hosting, a ticket board, pull requests, a browser IDE,
and Codex in one web app.

The pnpm workspace contains the Forge backend, web GUI, Ollama relay, and Ollama
client under `services/`, with shared packages under `packages/`.
The root `forge.sd.yaml` composes the deployed services.

For a local preview with sample projects, run:

```sh
nvm use
pnpm install --frozen-lockfile
pnpm dev:mock
```

Open http://127.0.0.1:5174. See [development and deployment](docs/development.md)
for backend setup, validation, and the container image.
