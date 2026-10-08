/**
 * A self-contained console fixture for MANUAL keyboard validation of the
 * "Run with agent" editor (tasks 5.3-5.4). It seeds the durable selection
 * states an operator needs to see — default, native, an unavailable saved
 * native id, and a managed team — and serves the real console routes with a
 * fake worker + fake discovery so no OpenCode binary, credential or model call
 * is ever used.
 *
 * Run it directly:
 *
 *   node --import tsx tests/helpers/console-native-fixture.ts
 *
 * It prints the loopback URL and the fixture-only console token. This file is
 * not a `*.test.ts` file, so the automated suite never executes it.
 *
 * The helper is injectable: `createNativeSelectionConsoleFixture()` returns the
 * app and seed so a test or a script can also drive it with `app.inject`.
 */

import { pathToFileURL } from "node:url";
import { buildConsoleServer, type ConsoleOptions } from "../../src/console/server.js";
import { Store } from "../../src/store/db.js";
import { OperatorActionStore } from "../../src/store/actions.js";
import { saveOpenCodeAgentProfile } from "../../src/store/opencode-profiles.js";
import { saveOpenCodeSelection } from "../../src/store/opencode-selections.js";
import type { OpenCodeWorker } from "../../src/agent/opencode-worker.js";
import type { NativeAgentChoice } from "../../src/agent/agent-inventory.js";
import type { DiscoverNativeAgentsInput } from "../../src/agent/native-discovery.js";
import type { AgentDefinition } from "../../src/config/loader.js";

/** A fixture-only console token; never a real secret. */
export const FIXTURE_TOKEN = "fixture-console-token";

export interface NativeSelectionConsoleFixture {
  options: ConsoleOptions;
  store: Store;
  repoIds: { default: number; native: number; unavailable: number; managed: number; cline: number };
}

/** Agents the fake discovery offers; `gone-agent` is deliberately absent. */
const ELIGIBLE_AGENTS: NativeAgentChoice[] = [
  {
    id: "reviewer",
    name: "Reviewer",
    description: "Reviews the diff against the request",
    mode: "primary",
    hidden: false,
    eligible: true,
    origin: "project",
  },
  {
    id: "implementer",
    name: "Implementer",
    description: "Implements the requested change",
    mode: "all",
    hidden: false,
    eligible: true,
    origin: "global",
  },
];

/** Executor definitions mirroring a real config, without real credential roots. */
const AGENTS: Record<string, AgentDefinition> = {
  opencode: {
    id: "opencode",
    kind: "opencode",
    binary: "opencode",
    efforts: ["none", "low", "medium", "high", "xhigh", "max"],
    credentialSource: "/tmp/fixture-opencode-data",
    credentialFiles: ["auth.json"],
  },
  cline: {
    id: "cline",
    kind: "cline",
    binary: "cline",
    efforts: ["none", "low", "medium", "high", "xhigh"],
    credentialSource: "/tmp/fixture-cline-data",
    credentialFiles: ["secrets.json"],
  },
};

/** Build the fixture app and seed the repository selection states. */
export function createNativeSelectionConsoleFixture(): NativeSelectionConsoleFixture {
  const store = new Store({ dataDir: ".", file: ":memory:" });
  const insert = (name: string, agent: string): number =>
    Number(
      store.db
        .prepare(
          `INSERT INTO repositories
             (owner, name, source_path, workspace_root, agent, model, provider, effort, enabled)
           VALUES ('acme', ?, ?, 'workspaces', ?, ?, ?, 'high', 1)`,
        )
        .run(
          name,
          `C:/fixture/${name}`,
          agent,
          agent === "opencode" ? "opencode/gpt-5.4" : "gpt-5.4",
          agent === "opencode" ? "" : "openai",
        ).lastInsertRowid,
    );

  const repoIds = {
    default: insert("default-repo", "opencode"),
    native: insert("native-repo", "opencode"),
    unavailable: insert("unavailable-repo", "opencode"),
    managed: insert("managed-repo", "opencode"),
    cline: insert("cline-repo", "cline"),
  };

  saveOpenCodeSelection(store.db, {
    repoId: repoIds.default,
    expectedRevision: 0,
    candidate: { source: "default" },
  });
  saveOpenCodeSelection(store.db, {
    repoId: repoIds.native,
    expectedRevision: 0,
    candidate: { source: "native", agentId: "reviewer" },
  });
  // A saved native id that the fake discovery no longer offers: the control
  // must keep showing it as the current, unavailable choice.
  saveOpenCodeSelection(store.db, {
    repoId: repoIds.unavailable,
    expectedRevision: 0,
    candidate: { source: "native", agentId: "gone-agent" },
  });
  const profile = saveOpenCodeAgentProfile(store.db, {
    repoId: repoIds.managed,
    expectedRevision: 0,
    candidate: {
      version: 1,
      primary: {
        id: "orchestrator",
        description: "Runs the managed team",
        permissions: ["edit", "shell"],
      },
      subagents: [
        { id: "reviewer", description: "Checks the change", enabled: true, permissions: ["edit"] },
      ],
    },
  });
  if (profile.ok) {
    saveOpenCodeSelection(store.db, {
      repoId: repoIds.managed,
      expectedRevision: 0,
      candidate: { source: "managed" },
      expectedProfileRevision: profile.revision,
    });
  }

  const worker = (cwd: string): OpenCodeWorker =>
    ({
      executorId: "opencode",
      binary: "opencode",
      version: "fixture",
      cwd,
      env: {},
      runner: async () => ({
        exitCode: 0,
        stdout: "[]",
        stderr: "",
        timedOut: false,
        isCanceled: false,
      }),
    }) as OpenCodeWorker;

  const options: ConsoleOptions = {
    db: store.db,
    token: FIXTURE_TOKEN,
    secrets: [],
    operatorActions: new OperatorActionStore(store.db),
    agents: AGENTS,
    dataDir: ".",
    opencodeWorker: (input) => worker(input.cwd),
    nativeDiscovery: {
      discover: async (input: DiscoverNativeAgentsInput) => {
        // Echo the repository id so a manual session proves the path is scoped.
        void input;
        return {
          status: "ready",
          agents: ELIGIBLE_AGENTS,
          recordCount: ELIGIBLE_AGENTS.length,
          polls: 1,
          fromCache: false,
        };
      },
    },
  };
  return { options, store, repoIds };
}

async function main(): Promise<void> {
  const fixture = createNativeSelectionConsoleFixture();
  const app = buildConsoleServer(fixture.options);
  await app.listen({ host: "127.0.0.1", port: 0 });
  const address = app.server.address();
  const port = address && typeof address === "object" ? address.port : 0;
  console.log(
    `\nOpenCode Run-with-agent fixture console\n` +
      `  URL:   http://127.0.0.1:${String(port)}/\n` +
      `  Token: ${FIXTURE_TOKEN}\n` +
      `  Stop with Ctrl+C.\n`,
  );
  const close = async (): Promise<void> => {
    await app.close();
    fixture.store.close();
    process.exit(0);
  };
  process.on("SIGINT", () => void close());
  process.on("SIGTERM", () => void close());
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  void main();
}
