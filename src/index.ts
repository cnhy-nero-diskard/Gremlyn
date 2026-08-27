import { pathToFileURL } from "node:url";
import { ClineExecutor } from "./agent/cline.js";
import { buildAgentEnvironment } from "./agent/environment.js";
import { buildConsoleServer, consoleListenOptions } from "./console/server.js";
import { loadConfig } from "./config/loader.js";
import { OctokitGitHubClient } from "./github/octokit.js";
import { createDefaultCommandRegistry } from "./ingest/commands.js";
import { PollingEventSource } from "./ingest/polling.js";
import { Logger } from "./log/logger.js";
import { DataDirectoryLock } from "./orchestrator/instance-lock.js";
import { ResolutionOrchestrator } from "./orchestrator/resolution.js";
import { OperatorActionStore } from "./store/actions.js";
import { Store } from "./store/db.js";
import { JobStore } from "./store/jobs.js";
import type { AgentExecutor } from "./types.js";
import { syncRepositories } from "./runtime/repositories.js";
import { resetWorkspace } from "./workspace/reset.js";

const EXPECTED_CLINE_VERSION = "3.0.60";

export async function main(argv: readonly string[] = process.argv.slice(2)): Promise<void> {
  const configPath = argv[0] ?? process.env.GREMLYN_CONFIG ?? "gremlyn.yaml";
  const config = loadConfig(configPath);
  const lock = DataDirectoryLock.acquire(config.dataDir);
  const store = new Store({ dataDir: config.dataDir });
  new JobStore(store.db).interruptIncompleteJobs();
  const logger = new Logger({
    level: config.logLevel,
    secrets: [config.githubToken, config.consoleToken],
    db: store.db,
  });
  const github = new OctokitGitHubClient(config.githubToken);
  const authenticatedLogin = await github.getAuthenticatedLogin();
  if (authenticatedLogin.toLowerCase() !== config.orchestratorLogin.toLowerCase()) {
    throw new Error(
      `GitHub token authenticates as ${authenticatedLogin}, expected ${config.orchestratorLogin}`,
    );
  }

  const executors = new Map<string, AgentExecutor>();
  for (const definition of Object.values(config.agents)) {
    if (definition.id !== "cline") {
      throw new Error(`no production executor is registered for agent ${definition.id}`);
    }
    const executor = new ClineExecutor(definition.binary);
    await executor.checkVersion(EXPECTED_CLINE_VERSION, buildAgentEnvironment());
    executors.set(definition.id, executor);
  }

  const repositories = syncRepositories(store.db, config.repositories);
  const registry = createDefaultCommandRegistry();
  const orchestrator = new ResolutionOrchestrator({
    db: store.db,
    dataDir: config.dataDir,
    allowedAuthors: config.allowedAuthors,
    orchestratorLogin: config.orchestratorLogin,
    timeoutSec: config.agentTimeoutSec,
    retries: config.agentRetries,
    github,
    registry,
    executors,
    logger,
    secrets: [config.githubToken, config.consoleToken],
    concurrency: config.concurrency,
    commitAuthor: config.commitAuthor,
  });
  for (const repository of repositories) orchestrator.registerRepository(repository);
  const eventSource = new PollingEventSource(github, store.db);
  const operatorActions = new OperatorActionStore(store.db);
  const consoleServer = buildConsoleServer({
    db: store.db,
    token: config.consoleToken,
    secrets: [config.githubToken, config.consoleToken],
    operatorActions,
    actions: {
      retry: (jobId) => orchestrator.retry(jobId),
      cancel: (jobId) => orchestrator.cancel(jobId),
      resetWorkspace: async (repoId, prNumber) => {
        const repository = repositories.find((entry) => entry.id === repoId);
        if (!repository) throw new Error(`repository ${repoId} not found`);
        const pr = await github.getPullRequest(repository.owner, repository.name, prNumber);
        await resetWorkspace({
          sourcePath: repository.sourcePath,
          workspaceRoot: repository.workspaceRoot,
          prNumber,
          headBranch: pr.headBranch,
          headSha: pr.headSha,
          actions: { record: () => 0 },
        });
      },
    },
  });

  let stopping = false;
  let polling = false;
  const poll = async (): Promise<void> => {
    if (stopping || polling) return;
    polling = true;
    try {
      for (const repository of repositories.filter((entry) => {
        const row = store.db
          .prepare("SELECT enabled FROM repositories WHERE id = ?")
          .get(entry.id) as { enabled: number } | undefined;
        return row?.enabled === 1;
      })) {
        const events = await eventSource.poll({
          id: repository.id,
          owner: repository.owner,
          repo: repository.name,
        });
        await Promise.all(events.map((event) => orchestrator.handleEvent(repository, event)));
      }
    } catch (error) {
      logger.error("poll failed", {
        error: error instanceof Error ? error.message : String(error),
      });
    } finally {
      polling = false;
    }
  };

  await consoleServer.listen(
    consoleListenOptions({ host: config.consoleHost, port: config.consolePort }),
  );
  logger.info("orchestrator started", {
    host: config.consoleHost,
    port: config.consolePort,
    repositories: repositories.length,
  });
  await poll();
  const timer = setInterval(() => void poll(), config.pollIntervalSec * 1_000);

  const stop = async (): Promise<void> => {
    if (stopping) return;
    stopping = true;
    clearInterval(timer);
    await consoleServer.close();
    store.close();
    lock.release();
  };
  process.once("SIGINT", () => void stop());
  process.once("SIGTERM", () => void stop());
}

const entry = process.argv[1];
if (entry && import.meta.url === pathToFileURL(entry).href) {
  main().catch((error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
