import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { buildAgentEnvironment } from "./agent/environment.js";
import {
  persistRotatedCredentials,
  removeAttemptDataDir,
  verifyCredentialSource,
} from "./agent/credentials.js";
import { EXECUTOR_FACTORIES, EXECUTOR_EXPECTED_VERSIONS } from "./agent/registry.js";
import { buildConsoleServer, consoleListenOptions } from "./console/server.js";
import { loadConfig } from "./config/loader.js";
import { OctokitGitHubClient } from "./github/octokit.js";
import { createDefaultCommandRegistry } from "./ingest/commands.js";
import { PollingEventSource } from "./ingest/polling.js";
import { Logger } from "./log/logger.js";
import { DataDirectoryLock } from "./orchestrator/instance-lock.js";
import {
  attemptDataDirFor,
  isManagedAttemptDataDir,
  recoverStaleManagedAttempts,
  shouldDeferAttemptToRecovery,
} from "./orchestrator/attempt-recovery.js";
import { ResolutionOrchestrator } from "./orchestrator/resolution.js";
import { OperatorActionStore } from "./store/actions.js";
import { Store } from "./store/db.js";
import { JobStore } from "./store/jobs.js";
import { type AgentExecutor, type ReasoningEffort } from "./types.js";
import { reportRepositoryProviderMismatches, syncRepositories } from "./runtime/repositories.js";
import { resetWorkspace } from "./workspace/reset.js";
import { reclaimWorkspaces } from "./workspace/reclamation.js";
import { retainArtifacts } from "./artifact-retention.js";

const TERMINATION_SIGNALS = ["SIGINT", "SIGTERM", "SIGHUP", "SIGBREAK"] as const;

export interface ShutdownHandlerOptions {
  clearTimer: () => void;
  endStreams: () => void;
  closeConsole: () => Promise<void>;
  closeStore: () => void;
  release: () => void;
  /** Resolves once any poll cycle already in flight when shutdown began has finished. */
  awaitInFlightPoll?: () => Promise<unknown>;
  exit?: (code: number) => void;
  onComplete?: () => void;
  onError?: (error: unknown) => void;
}

/** Build the single-flight shutdown handler used by the process signal hooks. */
export function createShutdownHandler(options: ShutdownHandlerOptions): () => Promise<void> {
  let stopping = false;
  return async (): Promise<void> => {
    if (stopping) {
      try {
        options.release();
      } finally {
        (options.exit ?? ((code: number) => process.exit(code)))(1);
      }
      return;
    }
    stopping = true;
    try {
      options.clearTimer();
      // A poll cycle already running when shutdown began must finish before
      // the store closes underneath it, or its next query throws.
      await options.awaitInFlightPoll?.().catch(() => undefined);
      options.endStreams();
      await options.closeConsole();
      options.closeStore();
      options.onComplete?.();
    } catch (error) {
      try {
        options.closeStore();
      } finally {
        options.onError?.(error);
      }
      throw error;
    }
  };
}

export async function main(argv: readonly string[] = process.argv.slice(2)): Promise<void> {
  const configPath = argv[0] ?? process.env.GREMLYN_CONFIG ?? "gremlyn.yaml";
  const config = loadConfig(configPath);
  const lock = DataDirectoryLock.acquire(config.dataDir);
  const lockHandlers = installLockSafetyHandlers(lock);
  let closeStore: () => void = () => undefined;
  try {
    const store = new Store({ dataDir: config.dataDir });
    let storeClosed = false;
    closeStore = (): void => {
      if (storeClosed) return;
      storeClosed = true;
      store.close();
    };
    const interrupted = new JobStore(store.db).interruptIncompleteJobs();
    for (const definition of Object.values(config.agents)) {
      verifyCredentialSource(
        definition.id,
        definition.credentialSource,
        definition.credentialFiles,
      );
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

    const credentialSources = new Map(
      Object.values(config.agents).map((def) => [def.id, def.credentialSource]),
    );
    const credentialFiles = new Map(
      Object.values(config.agents).map((def) => [def.id, def.credentialFiles]),
    );
    // Legacy startup sweep for Cline/legacy attempt dirs. Managed OpenCode
    // attempts (dirs journaling a manifest) are skipped here and handled by the
    // dedicated recovery below. Before a legacy dir is removed, rotated
    // credentials are written back — the crash skipped the runtime path that
    // normally rescues them.
    cleanupStaleAttemptDirs(config.dataDir, store.db, interrupted, {
      resolveExecutorKind: (agent) =>
        config.agents[agent]?.kind ?? executors.get(agent)?.id ?? agent,
      onRemoveAttempt: ({ attemptId, agent, attemptDataDir }) => {
        if (agent === null) return;
        const executor = executors.get(agent);
        const source = credentialSources.get(agent);
        if (executor === undefined || source === undefined || executor.usesSharedCredentials) {
          return;
        }
        try {
          persistRotatedCredentials(
            source,
            attemptDataDir,
            credentialFiles.get(agent),
            executor.id,
          );
        } catch (error) {
          logger.warn("startup credential write-back failed", {
            attemptId,
            agent,
            message: error instanceof Error ? error.message : String(error),
          });
        }
      },
    });

    const repositories = syncRepositories(store.db, config.repositories, config.agentTimeoutSec);
    reportRepositoryProviderMismatches(repositories, config.agents, logger);
    const operatorActions = new OperatorActionStore(store.db);
    // Managed startup recovery (task 3.6): decide every attempt dir holding a
    // managed OpenCode manifest — recover it only when its owner is known
    // inactive AND its child tree is proven quiescent through the pinned
    // session API, otherwise quarantine it durably (the manifest and generated
    // files survive and the workspace is barred from retry reuse).
    await recoverStaleManagedAttempts({
      dataDir: config.dataDir,
      db: store.db,
      actions: operatorActions,
      logger,
      // Recognize a pre-journal OpenCode attempt from its recorded agent alias
      // so recovery quarantines it instead of leaving it to the Cline-style
      // sweep. The alias kind is the file-config kind, falling back to the
      // registered executor id.
      resolveExecutorKind: (agent) =>
        config.agents[agent]?.kind ?? executors.get(agent)?.id ?? agent,
      resolveWorker: (attempt, workspacePath) => {
        const executor = executors.get(attempt.agent);
        if (executor === undefined) return undefined;
        const definition = config.agents[attempt.agent];
        const version =
          definition === undefined ? undefined : EXECUTOR_EXPECTED_VERSIONS[definition.kind];
        return {
          cwd: workspacePath,
          env: buildAgentEnvironment(
            process.env,
            executor.additionalEnvironment(
              attemptDataDirFor(config.dataDir, attempt.id),
              credentialSources.get(attempt.agent),
            ),
          ),
          // Exact alias-aware worker context: never fall back to a hardcoded
          // `opencode` when the crashed attempt ran another installation.
          binary: definition?.binary ?? attempt.agent,
          ...(version === undefined ? {} : { version }),
        };
      },
    });
    const reclamationRepositories = repositories.map(({ id, sourcePath, workspaceRoot }) => ({
      id,
      sourcePath,
      workspaceRoot,
    }));
    const sweepWorkspaces = async (phase: "startup" | "poll"): Promise<void> => {
      const report = await reclaimWorkspaces({
        db: store.db,
        repositories: reclamationRepositories,
        minimumAgeMs: config.workspaceReclamation.minimumAgeSec * 1_000,
        actions: operatorActions,
        // Protect a workspace still owned by an unresolved OpenCode invocation
        // tree (ownership journal / quarantine record / manifest) from being
        // reclaimed as inactive-clean.
        dataDir: config.dataDir,
      });
      logger.info("workspace reclamation sweep", {
        phase,
        candidates: report.candidates,
        reclaimed: report.reclaimed,
        retained: report.retained,
      });
    };
    const sweepArtifacts = async (phase: "startup" | "poll"): Promise<void> => {
      const report = await retainArtifacts({
        dataDir: config.dataDir,
        db: store.db,
        maximumAgeMs: config.artifactRetention.maximumAgeSec * 1_000,
        maximumTotalBytes: config.artifactRetention.maximumTotalBytes,
        actions: operatorActions,
      });
      logger.info("artifact retention sweep", {
        phase,
        candidates: report.candidates,
        totalBytes: report.totalBytes,
        removed: report.removed,
        removedBytes: report.removedBytes,
        remainingBytes: report.remainingBytes,
      });
    };
    if (config.workspaceReclamation.enabled) await sweepWorkspaces("startup");
    if (config.artifactRetention.enabled) await sweepArtifacts("startup");
    const registry = createDefaultCommandRegistry();
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
      operatorActions,
    });
    for (const repository of repositories) orchestrator.registerRepository(repository);
    const eventSource = new PollingEventSource(github, store.db);
    const consoleServer = buildConsoleServer({
      db: store.db,
      token: config.consoleToken,
      secrets: [config.githubToken, config.consoleToken],
      operatorActions,
      dataDir: config.dataDir,
      timezone: config.consoleTimezone,
      pollIntervalSec: config.pollIntervalSec,
      concurrency: config.concurrency,
      // Effort tiers and provider semantics are resolved per repository from its
      // configured agent's kind and declared tiers.
      agents: config.agents,
      // Native-agent discovery for the console uses the configured executor's
      // exact binary, pinned version, source cwd and sanitized environment —
      // never a hardcoded default `opencode` and never a test runner.
      opencodeWorker: (input) => {
        const executor = executors.get(input.executorId);
        if (executor?.resolveWorker === undefined) return undefined;
        return executor.resolveWorker({
          executorId: input.executorId,
          cwd: input.cwd,
          env: buildAgentEnvironment(
            process.env,
            executor.additionalEnvironment(config.dataDir, input.credentialSource),
          ),
        });
      },
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
            .prepare(
              "SELECT model, provider, effort, timeout_seconds FROM repositories WHERE id = ?",
            )
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

    let polling = false;
    const poll = async (): Promise<void> => {
      if (polling) return;
      polling = true;
      try {
        for (const repository of repositories.filter((entry) => {
          const row = store.db
            .prepare("SELECT enabled FROM repositories WHERE id = ?")
            .get(entry.id) as { enabled: number } | undefined;
          return row?.enabled === 1;
        })) {
          // handleEvent returns once each command is queued, so this tick stays
          // short no matter how long the queued jobs run. One repository's
          // transport failure must not skip the repositories after it.
          try {
            const events = await eventSource.poll({
              id: repository.id,
              owner: repository.owner,
              repo: repository.name,
            });
            await Promise.all(events.map((event) => orchestrator.handleEvent(repository, event)));
          } catch (error) {
            logger.error("poll failed", {
              repository: repository.id,
              error: error instanceof Error ? error.message : String(error),
            });
          }
        }
      } catch (error) {
        logger.error("poll failed", {
          error: error instanceof Error ? error.message : String(error),
        });
      }
      if (config.workspaceReclamation.enabled) {
        try {
          await sweepWorkspaces("poll");
        } catch (error) {
          logger.warn("workspace reclamation sweep failed", {
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }
      if (config.artifactRetention.enabled) {
        try {
          await sweepArtifacts("poll");
        } catch (error) {
          logger.warn("artifact retention sweep failed", {
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }
      polling = false;
    };

    await consoleServer.listen(
      consoleListenOptions({ host: config.consoleHost, port: config.consolePort }),
    );
    logger.info("orchestrator started", {
      host: config.consoleHost,
      port: config.consolePort,
      repositories: repositories.length,
    });
    let inFlightPoll: Promise<void> = poll();
    await inFlightPoll;
    const timer = setInterval(() => {
      inFlightPoll = poll();
    }, config.pollIntervalSec * 1_000);

    let resolveStopped!: () => void;
    let rejectStopped!: (error: unknown) => void;
    const stopped = new Promise<void>((resolve, reject) => {
      resolveStopped = resolve;
      rejectStopped = reject;
    });
    const stop = createShutdownHandler({
      clearTimer: () => clearInterval(timer),
      endStreams: () => consoleServer.endLiveUpdateStreams(),
      closeConsole: () => consoleServer.close(),
      closeStore,
      release: () => lock.release(),
      awaitInFlightPoll: () => inFlightPoll,
      onComplete: resolveStopped,
      onError: rejectStopped,
    });
    const onSignal = (): void => {
      void stop().catch(() => undefined);
    };
    const installedSignals: (typeof TERMINATION_SIGNALS)[number][] = [];
    for (const signal of TERMINATION_SIGNALS) {
      try {
        process.on(signal, onSignal);
        installedSignals.push(signal);
      } catch {
        // Some signals are platform-specific (SIGBREAK on POSIX).
      }
    }
    try {
      await stopped;
    } finally {
      for (const signal of installedSignals) process.removeListener(signal, onSignal);
    }
  } finally {
    closeStore();
    lockHandlers.remove();
    lock.release();
  }
}

export function installLockSafetyHandlers(lock: DataDirectoryLock): { remove: () => void } {
  const onExit = (): void => lock.release();
  const onFatal = (kind: string, value: unknown): void => {
    process.stderr.write(
      `${JSON.stringify({
        at: new Date().toISOString(),
        level: "error",
        event: kind,
        error: value instanceof Error ? value.message : String(value),
      })}\n`,
    );
    try {
      lock.release();
    } finally {
      process.exitCode = 1;
      process.exit(1);
    }
  };
  const onUncaughtException = (error: Error): void => onFatal("uncaught exception", error);
  const onUnhandledRejection = (reason: unknown): void => onFatal("unhandled rejection", reason);
  process.once("exit", onExit);
  process.once("uncaughtException", onUncaughtException);
  process.once("unhandledRejection", onUnhandledRejection);
  return {
    remove: () => {
      process.removeListener("exit", onExit);
      process.removeListener("uncaughtException", onUncaughtException);
      process.removeListener("unhandledRejection", onUnhandledRejection);
    },
  };
}

/**
 * Legacy startup sweep for attempt data dirs that a crashed run left behind
 * (Cline and any non-managed attempt; task 3.6).
 *
 * A job the startup sweep marked interrupted cannot have a live Gremlyn owner
 * again (the data-dir lock guarantees it), and a Cline attempt has no child
 * session that could outlive its run, so removing the per-attempt dir is safe
 * and matches the historical behavior. Managed OpenCode attempts are SKIPPED
 * here: their data dir journals the manifest that the dedicated startup
 * recovery (`recoverStaleManagedAttempts`) needs, and deleting it before child
 * quiescence is proven would destroy the only record of what the attempt owned.
 *
 * `onRemoveAttempt` runs before a dir is removed so callers can rescue
 * per-attempt state (e.g. an OAuth refresh token the agent rotated) exactly
 * like the runtime failure path does.
 */
export function cleanupStaleAttemptDirs(
  dataDir: string,
  db: import("better-sqlite3").Database,
  interruptedJobIds?: number[],
  options?: {
    /**
     * Resolve an attempt's configured agent alias to its executor kind, so a
     * pre-journal OpenCode attempt (no manifest, no ownership journal) is left
     * for the dedicated recovery module instead of being swept as Cline.
     */
    resolveExecutorKind?: (agent: string) => string | undefined;
    onRemoveAttempt?: (input: {
      attemptId: number;
      agent: string | null;
      attemptDataDir: string;
    }) => void;
  },
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
    // A managed/native/default OpenCode attempt (one that journaled a manifest,
    // a generic ownership record, or a recovery record) belongs to the startup
    // recovery module, never to this sweep: its data dir must survive until
    // child quiescence is proven through the pinned session API.
    if (isManagedAttemptDataDir(dir)) continue;
    // If this attempt belongs to an interrupted job, remove it.
    // Otherwise keep it: a running attempt must not be disturbed.
    try {
      const attempt = db
        .prepare(
          "SELECT id, job_id, agent, outcome, workspace_path, agent_session_id FROM attempts WHERE id = ?",
        )
        .get(attemptId) as
        | {
            id: number;
            job_id: number;
            agent: string | null;
            outcome: string | null;
            workspace_path: string | null;
            agent_session_id: string | null;
          }
        | undefined;
      if (!attempt) {
        // Orphan directory left by a killed process with no DB record (or old run).
        removeAttemptDataDir(dir);
        continue;
      }
      // A pre-journal OpenCode attempt whose alias resolves to OpenCode carries
      // service-owned evidence this sweep cannot prove quiescent: defer it.
      if (
        attempt.agent !== null &&
        shouldDeferAttemptToRecovery({
          attemptDataDir: dir,
          attempt: {
            agent: attempt.agent,
            workspace_path: attempt.workspace_path,
            agent_session_id: attempt.agent_session_id,
          },
          ...(options?.resolveExecutorKind === undefined
            ? {}
            : { resolveExecutorKind: options.resolveExecutorKind }),
        })
      ) {
        continue;
      }
      const job = db.prepare("SELECT status FROM jobs WHERE id = ?").get(attempt.job_id) as
        { status: string } | undefined;
      if (job?.status === "interrupted" || attempt.outcome === "interrupted") {
        options?.onRemoveAttempt?.({
          attemptId,
          agent: attempt.agent,
          attemptDataDir: dir,
        });
        removeAttemptDataDir(dir);
        continue;
      }
      // Also handle explicit interruptedJobIds list from startup sweep
      if (interruptedJobIds?.includes(attempt.job_id)) {
        options?.onRemoveAttempt?.({
          attemptId,
          agent: attempt.agent,
          attemptDataDir: dir,
        });
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
