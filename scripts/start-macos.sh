#!/usr/bin/env bash
# Launch from any directory with a supported Node and macOS Keychain secrets.
set -euo pipefail

if [[ "$(uname -s)" != Darwin ]]; then
  echo "This launcher requires macOS; use npm start on other platforms." >&2
  exit 1
fi

cd "$(dirname "${BASH_SOURCE[0]}")/.."

supported_node() {
  "$1" -e 'process.exit(Number(process.versions.node.split(".")[0]) >= 22 ? 0 : 1)' 2>/dev/null
}

if ! supported_node "$(command -v node || true)"; then
  for candidate in "$HOME/.local/bin/node" /opt/homebrew/opt/node@24/bin/node /opt/homebrew/opt/node@22/bin/node /opt/homebrew/bin/node /usr/local/bin/node; do
    if [[ -x "$candidate" ]] && supported_node "$candidate"; then
      export PATH="$(dirname "$candidate"):$PATH"
      break
    fi
  done
fi
if ! supported_node "$(command -v node || true)"; then
  echo "Gremlyn requires Node.js 22 or newer. Install/select it, then rerun this launcher." >&2
  exit 1
fi

config="${GREMLYN_CONFIG:-gremlyn.macos.yaml}"
if [[ ! -f "$config" ]]; then
  echo "Missing config: $config. See docs/macos.md to create a Mac configuration." >&2
  exit 1
fi

# Native dependencies must match the Node selected above, not a previous nvm runtime.
node --input-type=module <<'JS'
import Database from "better-sqlite3";
try {
  new Database(":memory:").close();
} catch {
  console.error(`SQLite could not load under Node ${process.version} (${process.execPath}). Reinstall dependencies with npm ci using this Node version.`);
  process.exit(1);
}
JS

if [[ -z "${GREMLYN_GITHUB_TOKEN:-}" ]]; then
  GREMLYN_GITHUB_TOKEN="$(/usr/bin/security find-generic-password -a gremlyn -s gremlyn.github.token -w)"
  export GREMLYN_GITHUB_TOKEN
fi
if [[ -z "${GREMLYN_CONSOLE_TOKEN:-}" ]]; then
  GREMLYN_CONSOLE_TOKEN="$(/usr/bin/security find-generic-password -a gremlyn -s gremlyn.console.token -w)"
  export GREMLYN_CONSOLE_TOKEN
fi

if [[ "${1:-}" == --check ]]; then
  node --import tsx --input-type=module - "$config" <<'JS'
import { loadConfig } from "./src/config/loader.ts";
import { verifyCredentialSource } from "./src/agent/credentials.ts";
import { EXECUTOR_FACTORIES } from "./src/agent/registry.ts";
import { buildAgentEnvironment } from "./src/agent/environment.ts";
const config = loadConfig(process.argv[2]);
for (const agent of Object.values(config.agents)) {
  verifyCredentialSource(agent.id, agent.credentialSource, agent.credentialFiles, agent.kind);
  const factory = EXECUTOR_FACTORIES[agent.kind];
  if (!factory) throw new Error(`No executor registered for ${agent.kind}`);
  await factory(agent.binary).checkVersion(buildAgentEnvironment());
}
console.log(`Node ${process.version}; configured credential stores and CLI versions passed.`);
JS
  exec npm run verify:config -- --config "$config"
fi

exec npm start -- "$config" "$@"
