import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { removeAttemptDataDir, verifyCredentialSource } from "./agent/credentials.js";
import { buildAgentEnvironment } from "./agent/environment.js";
import { EXECUTOR_FACTORIES } from "./agent/registry.js";
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
import { REASONING_EFFORTS, type AgentExecutor, type ReasoningEffort } from "./types.js";
import { syncRepositories } from "./runtime/repositories.js";
import { resetWorkspace } from "./workspace/reset.js";

export async function main(argv: readonly string[] = process.argv.slice(2)): Promise<void> {
  const configPath = argv[0] ?? process.env.GREMLYN_CONFIG ?? "gremlyn.yaml";
  const config = loadConfig(configPath);
  const lock = DataDirectoryLock.acquire(config.dataDir);
  const store = new Store({ dataDir: config.dataDir });
  const interrupted = new JobStore(store.db).interruptIncompleteJobs();
  cleanupStaleAttemptDirs(config.dataDir, store.db, interrupted);
  for (const definition of Object.values(config.agents)) {
    verifyCredentialSource(definition.id, definition.credentialSource, definition.credentialFiles);
  }
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
    const factory = EXECUTOR_FACTORIES[definition.kind];
    if (!factory) {
      throw new Error(
        `no production executor is registered for agent "${definition.id}" (kind "${definition.kind}")`,
      );
    }
    const executor = factory(definition.binary);
    await executor.checkVersion(buildAgentEnvironment());
    executors.set(definition.id, executor);
  }

  const repositories = syncRepositories(store.db, config.repositories, config.agentTimeoutSec);
  const registry = createDefaultCommandRegistry();
  const credentialSources = new Map(
    Object.values(config.agents).map((def) => [def.id, def.credentialSource]),
  );
  const credentialFiles = new Map(
    Object.values(config.agents).map((def) => [def.id, def.credentialFiles]),
  );
  const orchestrator = new ResolutionOrchestrator({
    db: store.db,
    dataDir: config.dataDir,
    allowedAuthors: config.allowedAuthors,
    orchestratorLogin: config.orchestratorLogin,
    retries: config.agentRetries,
    github,
    registry,
    executors,
    credentialSources,
    credentialFiles,
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
    dataDir: config.dataDir,
    pollIntervalSec: config.pollIntervalSec,
    concurrency: config.concurrency,
    effortOptions: config.agents.cline?.efforts ?? REASONING_EFFORTS,
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
      repositorySettingsChanged: (repoId) => {
        const index = repositories.findIndex((entry) => entry.id === repoId);
        if (index < 0) return;
        const existing = repositories[index];
        if (!existing) return;
        const row = store.db
          .prepare("SELECT model, provider, effort, timeout_seconds FROM repositories WHERE id = ?")
          .get(repoId) as
          | {
              model: string;
              provider: string;
              effort: string;
              timeout_seconds: number | null;
            }
          | undefined;
        if (!row) return;
        const updated = {
          ...existing,
          model: row.model,
          provider: row.provider,
          effort: row.effort as ReasoningEffort,
          ...(row.timeout_seconds === null ? {} : { timeoutSec: row.timeout_seconds }),
        };
        repositories[index] = updated;
        orchestrator.registerRepository(updated);
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

export function cleanupStaleAttemptDirs(
  dataDir: string,
  db: import("better-sqlite3").Database,
  interruptedJobIds?: number[],
): void {
  const attemptsRoot = join(dataDir, "attempts");
  if (!existsSync(attemptsRoot)) return;
  let entries: string[] = [];
  try {
    entries = readdirSync(attemptsRoot);
  } catch {
    return;
  }
  for (const entry of entries) {
    const attemptId = Number(entry);
    if (!Number.isInteger(attemptId) || attemptId < 1) continue;
    const dir = join(attemptsRoot, entry);
    // If this attempt belongs to an interrupted job, remove it.
    // Otherwise keep it: a running attempt must not be disturbed.
    try {
      const attempt = db
        .prepare("SELECT job_id, outcome FROM attempts WHERE id = ?")
        .get(attemptId) as { job_id: number; outcome: string | null } | undefined;
      if (!attempt) {
        // Orphan directory left by a killed process with no DB record (or old run).
        removeAttemptDataDir(dir);
        continue;
      }
      const job = db.prepare("SELECT status FROM jobs WHERE id = ?").get(attempt.job_id) as
        { status: string } | undefined;
      if (job?.status === "interrupted" || attempt.outcome === "interrupted") {
        removeAttemptDataDir(dir);
        continue;
      }
      // Also handle explicit interruptedJobIds list from startup sweep
      if (interruptedJobIds?.includes(attempt.job_id)) {
        removeAttemptDataDir(dir);
      }
    } catch {
      // On any DB error, do not delete to avoid disturbing running attempts.
    }
  }
}

const entry = process.argv[1];
if (entry && import.meta.url === pathToFileURL(entry).href) {
  main().catch((error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
