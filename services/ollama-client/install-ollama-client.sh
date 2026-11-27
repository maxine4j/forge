#!/usr/bin/env bash
set -eu

install_worker() {
    bundle=forge-ollama-client.cjs
    launcher=run-ollama-client.sh
    base_url=https://raw.githubusercontent.com/maxine4j/forge/main/services/ollama-client

    temp_dir=$(mktemp -d ./.forge-ollama-client.XXXXXX)
    trap 'rm -rf -- "$temp_dir"' EXIT

    curl -fsSL "$base_url/dist/$bundle" -o "$temp_dir/$bundle"
    mv -f -- "$temp_dir/$bundle" "./$bundle"

    if [[ ! -e "$launcher" && ! -L "$launcher" ]]; then
        cat > "$temp_dir/$launcher" <<'LAUNCHER'
#!/usr/bin/env bash
set -eu

export OLLAMA_RELAY_TOKEN="${OLLAMA_RELAY_TOKEN:-}"
relay_url="${FORGE_RELAY_URL:-}"
worker_id="${FORGE_WORKER_ID:-worker-a}"
context_window="${FORGE_CONTEXT_WINDOW:-164000}"

: "${OLLAMA_RELAY_TOKEN:?Set the Forge relay pairing token in this script}"
: "${relay_url:?Set the Forge relay HTTPS origin in this script}"

script_dir=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
exec node "$script_dir/forge-ollama-client.cjs" \
    --worker-id "$worker_id" \
    --relay-base-url "$relay_url" \
    --context-window "$context_window"
LAUNCHER
        chmod 700 "$temp_dir/$launcher"
        mv -- "$temp_dir/$launcher" "./$launcher"
    fi

    printf 'Edit %s to set the relay token, URL, worker ID, and context window. Then run ./%s.\n' "$launcher" "$launcher"
}

install_worker
