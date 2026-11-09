#!/usr/bin/env bash
# Installs or updates the agent on the VM (user ubuntu, systemd). Run from the repository root after
# `npm ci && npm run build -w shared && npm run build -w agent`:
#   bash deploy/agent/install-linux.sh               # first install: asks for the token (hidden input)
#   bash deploy/agent/install-linux.sh               # update: keeps agent.env
#   bash deploy/agent/install-linux.sh --new-token   # replace the token (hidden input)
# AGENT_TOKEN in the environment is also accepted and always replaces the stored token.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
STATE="$HOME/.agent-hub"
APP="$STATE/app"
ENV_FILE="$STATE/agent.env"
UNIT=/etc/systemd/system/agent-hub-agent.service
NEW_TOKEN=0
[[ "${1:-}" == "--new-token" ]] && NEW_TOKEN=1

[[ -f "$ROOT/agent/dist/agent.mjs" ]] || { echo "error: build the agent first (npm run build -w agent)" >&2; exit 1; }
NODE_BIN="$(command -v node)" || { echo "error: node not found in PATH" >&2; exit 1; }
"$NODE_BIN" -e 'process.exit(+process.versions.node.split(".")[0] >= 22 ? 0 : 1)' || { echo "error: Node.js 22+ required" >&2; exit 1; }

TOKEN="${AGENT_TOKEN:-}"
if [[ -z "$TOKEN" && ( "$NEW_TOKEN" == 1 || ! -f "$ENV_FILE" ) ]]; then
  # Hidden input: the token stays out of the shell history and the process list.
  read -rsp 'Agent token: ' TOKEN
  echo
  [[ -n "$TOKEN" ]] || { echo "error: no token entered" >&2; exit 1; }
fi

mkdir -p "$APP"
chmod 700 "$STATE"
cp "$ROOT"/agent/dist/{agent.mjs,agent.mjs.map,package.json,s4u-check.mjs} "$APP/"
(cd "$APP" && npm install --omit=dev --no-audit --no-fund)

umask 077
if [[ -n "$TOKEN" ]]; then
  # Keep HUB_URL / VAULT_ROOT and any other settings of an existing file; replace only the token.
  tmp="$(mktemp "$STATE/agent.env.XXXXXX")"
  if [[ -f "$ENV_FILE" ]]; then
    grep -v '^AGENT_TOKEN=' "$ENV_FILE" > "$tmp" || true
  else
    printf 'HUB_URL=%s\nVAULT_ROOT=%s\n' "${HUB_URL:?set HUB_URL=wss://<hub>/ws/agent}" "${VAULT_ROOT:-$HOME/vault}" > "$tmp"
  fi
  printf 'AGENT_TOKEN=%s\n' "$TOKEN" >> "$tmp"
  mv "$tmp" "$ENV_FILE"
  unset TOKEN AGENT_TOKEN
fi
chmod 600 "$ENV_FILE"

sed "s#@NODE@#${NODE_BIN}#" "$ROOT/deploy/agent/agent-hub-agent.service" | sudo tee "$UNIT" > /dev/null
sudo chmod 644 "$UNIT"
sudo systemctl daemon-reload
sudo systemctl enable agent-hub-agent.service
sudo systemctl restart agent-hub-agent.service
sleep 3
systemctl --no-pager --lines 15 status agent-hub-agent.service
