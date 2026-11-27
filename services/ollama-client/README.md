# Forge Ollama client

On macOS, have Node.js 24 and `ollama` on your `PATH`. Pull a local Ollama model, then quit the Ollama app or stop its server so the worker can start its own server on port 11434. Get the HTTPS relay URL and pairing token from your [Forge relay deployment](../../docs/development.md#ollama-relay).

From the directory where you want the client and launcher, run:

```bash
curl -fsSL https://raw.githubusercontent.com/maxine4j/forge/main/services/ollama-client/install-ollama-client.sh | bash
```

Edit `run-ollama-client.sh` to set `OLLAMA_RELAY_TOKEN`, the relay URL, a unique worker ID, and the context window in tokens. Keep the launcher private once it contains your token. Then run:

```bash
./run-ollama-client.sh
```

Run the install command again to refresh the bundle from `main` and keep your launcher settings. The download needs no GitHub token and uses no npm configuration.

## Rebuild the bundle

From the repository root, run:

```bash
nvm use
pnpm --filter @forge/backend-infrastructure build
pnpm --filter @maxine4j/forge-ollama-client bundle
```

Commit the regenerated `dist/forge-ollama-client.cjs` with changes that affect the worker bundle.
