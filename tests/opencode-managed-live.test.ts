/**
 * Gated live acceptance harness for the managed OpenCode flow (task 5.2).
 *
 * Unlike the seam-replaced integration tests (`managed-attempt-integration.test.ts`),
 * this file drives the REAL production path end to end with no fake process
 * seams:
 *
 * - the actual {@link OpenCodeExecutor} invokes the installed OpenCode CLI;
 * - the actual `ResolutionOrchestrator` runs the attempt lifecycle through the
 *   real engine with default managed-OpenCode wiring, so the preflight uses the
 *   real `opencode debug agents` inventory reader and child settlement uses the
 *   real `opencode api` session surface;
 * - GitHub is a {@link FixtureGitHubClient} (no external publication possible)
 *   and the "remote" is a local bare repository from
 *   {@link createTempRepo}, so the final push never leaves the machine.
 *
 * The scenario proves the delegation contract end to end:
 *
 * 1. The repository carries a dashboard profile whose primary must NOT edit
 *    files itself (no `edit`/`shell` permission) and whose single enabled
 *    child `reviewer` has `edit`. The trusted profile instructions and the
 *    repository's agent instructions both oblige the primary to delegate every
 *    edit to `reviewer`.
 * 2. The `!RESOLVE` feedback asks for `marker.txt` to become exactly
 *    `REVIEWED-OK` and forbids any other file change.
 * 3. The real model run must therefore invoke the child, the child must edit
 *    the marker (only it structurally can), and the parent must return.
 * 4. The orchestrator settles the child sessions through the real CLI session
 *    API, removes the generated `.opencode` agent files, then validates. The
 *    validation command asserts the marker's content and the absence of the
 *    generated agents — i.e. the child's work is provably present and complete
 *    BEFORE validation runs.
 * 5. Publication commits and pushes to the local bare remote; the final diff
 *    must contain only `marker.txt` and no `.opencode` path.
 *
 * OPT-IN ONLY. Every model call is a real provider call that can cost money, so
 * the harness skips unless the operator explicitly names a model. Prefer a
 * free / no-cost id (e.g. `opencode/deepseek-v4-flash-free`). The harness never
 * reads a secrets file — the OpenCode CLI resolves the operator's own
 * authenticated service through the normal agent environment (shared
 * credentials, as documented by `OpenCodeExecutor`).
 *
 * HOW TO RUN (this is the acceptance run; keep it bounded by the timeout):
 *
 *   # Unix
 *   GREMLYN_LIVE_OPENCODE_MODEL=opencode/deepseek-v4-flash-free \
 *     node --import tsx --test tests/opencode-managed-live.test.ts
 *
 *   # Windows (PowerShell)
 *   $env:GREMLYN_LIVE_OPENCODE_MODEL = "opencode/deepseek-v4-flash-free"
 *   node --import tsx --test tests/opencode-managed-live.test.ts
 *
 * Prerequisites:
 * - OpenCode 2.0.16 on PATH (or point `GREMLYN_LIVE_OPENCODE_BIN` at it); the
 *   harness skips when the installed release is not the pinned 2.0.16.
 * - An authenticated OpenCode service for the chosen `provider/model`
 *   (`opencode auth login`), otherwise the attempt fails as
 *   `agent-auth-failed` and the test reports it loudly.
 * - No network access to GitHub is needed or used: GitHub is a fixture and the
 *   git remote is a local bare repository.
 *
 * Without `GREMLYN_LIVE_OPENCODE_MODEL` the test skips immediately and spawns
 * nothing, so the normal `npm test` run is unaffected.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { extractVersion } from "../src/agent/cline.js";
import { buildAgentEnvironment } from "../src/agent/environment.js";
import { defaultRunner } from "../src/agent/launcher.js";
import {
  createCliManagedSessionHttp,
  parseSessionRecord,
  sessionRecordPath,
  type ManagedHttpResult,
  type OpenCodeSessionOutcome,
} from "../src/agent/managed-sessions.js";
import { readCliAgentInventory } from "../src/agent/managed-preflight.js";
import { discoverNativeAgents } from "../src/agent/native-discovery.js";
import { readOpenCodeInitialIdentity } from "../src/agent/opencode-identity.js";
import { EXPECTED_OPENCODE_VERSION, OpenCodeExecutor } from "../src/agent/opencode.js";
import { FixtureGitHubClient } from "../src/github/fixture.js";
import { createDefaultCommandRegistry } from "../src/ingest/commands.js";
import { Logger } from "../src/log/logger.js";
import { ResolutionOrchestrator } from "../src/orchestrator/resolution.js";
import { OperatorActionStore } from "../src/store/actions.js";
import { Store } from "../src/store/db.js";
import { saveOpenCodeAgentProfile } from "../src/store/opencode-profiles.js";
import {
  currentSelectionRevision,
  saveOpenCodeSelection,
} from "../src/store/opencode-selections.js";
import { syncRepositories } from "../src/runtime/repositories.js";
import type { NormalizedEvent } from "../src/types.js";
import { git } from "../src/workspace/gitops.js";
import { workspacePathFor } from "../src/workspace/worktree.js";
import { createTempRepo, pushCommit, remoteSha } from "./helpers/gitrepo.js";

/** Env opt-in: `provider/model` id for the real model run. Unset skips the test. */
const LIVE_MODEL_ENV = "GREMLYN_LIVE_OPENCODE_MODEL";
/** Optional env: the OpenCode binary to invoke. Defaults to `opencode`. */
const LIVE_BIN_ENV = "GREMLYN_LIVE_OPENCODE_BIN";

/** The marker the delegated child must write, byte-trimmed to this value. */
const MARKER_FILE = "marker.txt";
const MARKER_EXPECTED = "REVIEWED-OK";

/** Bounds the parent run plus child settlement (the attempt's configured timeout). */
const LIVE_ATTEMPT_TIMEOUT_SEC = 300;
/** Absolute harness cap; the attempt timeout is the real bound, this is a guard. */
const HARD_DEADLINE_MS = 360_000;

/** The marker content the fixture starts from. */
const MARKER_INITIAL = "0\n";

/* ------------------------------------------------------------------ *
 * Profile: primary must delegate; only the child can edit
 * ------------------------------------------------------------------ */

/**
 * The trusted dashboard profile. The primary has no `edit`/`shell` permission
 * (structurally unable to modify files), and its allowlist grants exactly the
 * single enabled child. The child has `edit`, so any successful marker edit is,
 * by construction, the child's work — OpenCode's permission engine enforces it,
 * not a prompt promise.
 */
function liveProfile(): Record<string, unknown> {
  return {
    version: 1,
    primary: {
      id: "primary",
      description: "Coordinating primary that delegates every edit to the reviewer child",
      permissions: [],
      instructions: [
        "You are the coordinating agent for a review-resolution task.",
        "You must NEVER edit files yourself and you have no editing or shell tools.",
        "Every file change in this task must be performed by your single enabled subagent, reviewer.",
        "The reviewer's runtime id shares your namespace: take your own agent id (its last segment is 'primary') and replace that final 'primary' segment with 'reviewer'.",
        "Use the `subagent` tool with that id, a short description, and a complete prompt describing exactly the file change requested in the review feedback. Run the subagent in the FOREGROUND (do not set background) and wait for it to finish before continuing.",
        "When the subagent returns, report what it changed and finish without making further changes.",
      ].join("\n"),
    },
    subagents: [
      {
        id: "reviewer",
        description: "Reviewer child that performs the requested marker edit",
        enabled: true,
        permissions: ["edit"],
        instructions: [
          "You are the reviewer subagent performing exactly the file change described in the prompt you receive.",
          "Edit only the named target file. Do not create, delete, or modify any other file.",
          "Do not run git commands, do not invoke any other agent, and do not use the shell.",
        ].join("\n"),
      },
    ],
  };
}

/**
 * Trusted repository-level instructions (rendered in the prompt as
 * "Repository-specific instructions"). Reinforces the delegation obligation at
 * the prompt level, independent of the untrusted review thread.
 */
const DELEGATION_INSTRUCTIONS = [
  "Delegate the requested file edit to your enabled subagent reviewer.",
  "Its runtime id is your own agent id with the final '/primary' segment replaced by '/reviewer'.",
  "Invoke the `subagent` tool with that id, a short description, and a complete prompt describing exactly the change requested in the review feedback, in the foreground, and wait for the result before finishing.",
  `Change ${MARKER_FILE} so its content is exactly:`,
  MARKER_EXPECTED,
  "Touch no other file and create no new files.",
].join("\n");

/* ------------------------------------------------------------------ *
 * Validation command: proves the child's work is complete and the
 * generated agent files are gone BEFORE the orchestrator's validation stage
 * ------------------------------------------------------------------ */

function markerAssertionCommand(): string[] {
  const script = [
    "const fs=require('node:fs');",
    `if(!fs.existsSync('${MARKER_FILE}')){console.error('${MARKER_FILE} is missing');process.exit(23);}`,
    `const content=fs.readFileSync('${MARKER_FILE}','utf8');`,
    `if(content.trim()!=='${MARKER_EXPECTED}'){console.error('${MARKER_FILE} is not exactly ${MARKER_EXPECTED}: '+JSON.stringify(content));process.exit(24);}`,
    "if(fs.existsSync('.opencode/agents')){console.error('.opencode generated agent files must be removed before validation');process.exit(25);}",
    "console.log('live acceptance: marker validated, generated agents removed');",
  ].join("");
  return ["node", "-e", script];
}

/* ------------------------------------------------------------------ *
 * Versions, paths, shell helpers
 * ------------------------------------------------------------------ */

function sameDirectory(left: string, right: string): boolean {
  const a = resolve(left).replace(/[\\/]+$/u, "");
  const b = resolve(right).replace(/[\\/]+$/u, "");
  return process.platform === "win32" ? a.toLowerCase() === b.toLowerCase() : a === b;
}

/** Run the pinned CLI's version probe without any secrets or config reads. */
async function probeOpenCodeVersion(bin: string): Promise<string | undefined> {
  try {
    const result = await defaultRunner(bin, ["--version"], {
      env: buildAgentEnvironment(process.env),
    });
    if (result.exitCode !== 0) return undefined;
    return extractVersion(result.stdout);
  } catch {
    return undefined;
  }
}

function withDeadline<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolvePromise, reject) => {
    const timer = setTimeout(() => reject(new Error(`${label} exceeded ${ms}ms`)), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolvePromise(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error instanceof Error ? error : new Error(String(error)));
      },
    );
  });
}

/* ------------------------------------------------------------------ *
 * Fixture: real orchestrator + real executor + real CLI seams, fake
 * GitHub, local bare remote
 * ------------------------------------------------------------------ */

interface LiveFixture {
  dataDir: string;
  store: Store;
  repository: NonNullable<ReturnType<typeof syncRepositories>>[number];
  github: FixtureGitHubClient;
  executor: OpenCodeExecutor;
  orchestrator: ResolutionOrchestrator;
  event: NormalizedEvent;
  gitRepo: Awaited<ReturnType<typeof createTempRepo>>;
  initialSha: string;
  workspace: string;
  prNumber: number;
  model: string;
  bin: string;
  nativeAgentId?: string;
}

async function setupLiveFixture(bin: string, model: string, native = false): Promise<LiveFixture> {
  const gitRepo = await createTempRepo();
  // Give the child a concrete, pre-existing target on the PR head.
  await pushCommit(
    gitRepo.sourcePath,
    gitRepo.headBranch,
    MARKER_FILE,
    MARKER_INITIAL,
    "add live acceptance target marker",
  );
  const initialSha = await remoteSha(gitRepo.remotePath, gitRepo.headBranch);
  const dataDir = mkdtempSync(join(tmpdir(), "gremlyn-live-opencode-"));
  const store = new Store({ dataDir, file: ":memory:" });
  const [repository] = syncRepositories(
    store.db,
    [
      {
        owner: "acme",
        name: "widgets",
        sourcePath: gitRepo.sourcePath,
        workspaceRoot: gitRepo.workspaceRoot,
        adoptWorktree: false,
        agent: "opencode",
        provider: "opencode",
        model,
        effort: "none",
        enabled: true,
        validationCommands: [markerAssertionCommand()],
        workspaceSeedFiles: [],
        agentInstructions: native
          ? `Edit only ${MARKER_FILE} to contain ${MARKER_EXPECTED}. Do not change any configuration, commit, push, or call GitHub.`
          : DELEGATION_INSTRUCTIONS,
        allowedModels: [model],
      },
    ],
    LIVE_ATTEMPT_TIMEOUT_SEC,
  );
  if (repository === undefined) throw new Error("live fixture repository was not registered");
  const saved = saveOpenCodeAgentProfile(store.db, {
    repoId: repository.id,
    expectedRevision: 0,
    candidate: liveProfile(),
    executorKind: "opencode",
  });
  assert.ok(saved.ok, "the live fixture profile must save");
  const activated = saveOpenCodeSelection(store.db, {
    repoId: repository.id,
    expectedRevision: currentSelectionRevision(store.db, repository.id),
    expectedProfileRevision: saved.revision,
    candidate: { source: "managed" },
    executorKind: "opencode",
  });
  assert.ok(activated.ok, "managed profile activation is explicit");
  let nativeAgentId: string | undefined;
  if (native) {
    const executor = new OpenCodeExecutor(bin);
    const env = buildAgentEnvironment(process.env, executor.additionalEnvironment(""));
    const worker = executor.resolveWorker({
      executorId: "opencode",
      cwd: repository.sourcePath,
      env,
    });
    const discovery = await discoverNativeAgents({
      worker,
      repositoryId: String(repository.id),
      refresh: true,
    });
    assert.equal(
      discovery.status,
      "ready",
      "native discovery must converge in the temporary repository",
    );
    if (discovery.status !== "ready") throw new Error("native discovery failed before model work");
    const eligible = discovery.agents;
    const requested = process.env.GREMLYN_LIVE_OPENCODE_AGENT;
    const choice =
      requested === undefined ? eligible[0] : eligible.find((entry) => entry.id === requested);
    assert.ok(choice, "the opt-in native primary must actually be discovered and eligible");
    nativeAgentId = choice.id;
    const selected = saveOpenCodeSelection(store.db, {
      repoId: repository.id,
      expectedRevision: currentSelectionRevision(store.db, repository.id),
      candidate: { source: "native", agentId: nativeAgentId },
      executorKind: "opencode",
    });
    assert.ok(
      selected.ok,
      "native source explicitly replaces active managed source without deleting its profile",
    );
  }

  const prNumber = 27;
  const github = new FixtureGitHubClient({
    login: "gremlyn-bot",
    prs: [
      {
        number: prNumber,
        title: "Acceptance marker",
        state: "open",
        merged: false,
        headBranch: gitRepo.headBranch,
        headSha: initialSha,
        headRepoOwner: "acme",
        headRepoName: "widgets",
        baseRepoOwner: "acme",
        baseRepoName: "widgets",
        htmlUrl: "https://example.test/acme/widgets/pull/27",
      },
    ],
    comments: [
      {
        id: 500,
        inReplyToId: null,
        path: MARKER_FILE,
        diffHunk: "@@ -1 +1 @@",
        body: `Please change ${MARKER_FILE} so its content is exactly ${MARKER_EXPECTED} and add no other files.`,
        authorLogin: "reviewer",
        createdAt: "2026-08-27T00:00:00.000Z",
        prNumber,
      },
      {
        id: 501,
        inReplyToId: 500,
        path: MARKER_FILE,
        diffHunk: "@@ -1 +1 @@",
        body: `!RESOLVE\nIn this pull request change ${MARKER_FILE} to contain exactly ${MARKER_EXPECTED} and nothing else. Do not create or change any other file.`,
        authorLogin: "developer",
        createdAt: "2026-08-27T00:01:00.000Z",
        prNumber,
      },
    ],
  });
  const executor = new OpenCodeExecutor(bin);
  const operatorActions = new OperatorActionStore(store.db);
  const logger = new Logger({ level: "error", secrets: [], db: store.db });
  const orchestrator = new ResolutionOrchestrator({
    db: store.db,
    dataDir,
    allowedAuthors: ["developer"],
    orchestratorLogin: "gremlyn-bot",
    timeoutSec: LIVE_ATTEMPT_TIMEOUT_SEC,
    retries: 1,
    github,
    registry: createDefaultCommandRegistry(),
    executors: new Map([["opencode", executor]]),
    logger,
    secrets: [],
    concurrency: 1,
    commitAuthor: { name: "Gremlyn", email: "gremlyn@localhost" },
    operatorActions,
    // Default wiring exercises the pinned production paths (CLI preflight +
    // CLI session transport under the attempt's cwd/env). A custom binary
    // recreates the same production transports with that binary.
    ...(bin === "opencode"
      ? {}
      : {
          managedOpenCode: {
            preflightInventory: readCliAgentInventory,
            sessionHttp: (worker) =>
              createCliManagedSessionHttp({ cwd: worker.cwd, env: worker.env, binary: bin }),
          },
        }),
  });
  orchestrator.registerRepository(repository);
  const event: NormalizedEvent = {
    owner: "acme",
    repo: "widgets",
    kind: "review-comment",
    commentId: 501,
    authorLogin: "developer",
    body: `!RESOLVE\nIn this pull request change ${MARKER_FILE} to contain exactly ${MARKER_EXPECTED} and nothing else. Do not create or change any other file.`,
    prNumber,
    observedAt: "2026-08-27T00:01:00.000Z",
  };
  return {
    dataDir,
    store,
    repository,
    github,
    executor,
    orchestrator,
    event,
    gitRepo,
    initialSha,
    workspace: workspacePathFor(gitRepo.workspaceRoot, prNumber),
    prNumber,
    model,
    bin,
    ...(nativeAgentId === undefined ? {} : { nativeAgentId }),
  };
}

async function resolveEvent(data: LiveFixture) {
  const [queued] = await data.orchestrator.handleEvent(data.repository, data.event);
  if (!queued) throw new Error("the event queued no job");
  return queued;
}

/* ------------------------------------------------------------------ *
 * Failure diagnostics — turn a live rejection into a readable verdict
 * ------------------------------------------------------------------ */

interface AttemptRow {
  agent: string;
  model: string;
  outcome: string | null;
  failure_stage: string | null;
  failure_reason: string | null;
  agent_session_id: string | null;
  output_ref: string | null;
  commit_sha: string | null;
  pushed: number;
}

function outputSnippet(outputRef: string | null, maxChars: number): string {
  if (outputRef === null) return "(no output artifact recorded)";
  try {
    const text = readFileSync(outputRef, "utf8");
    return text.length <= maxChars
      ? text
      : `${text.slice(0, maxChars)}\n... (${text.length - maxChars} more chars)`;
  } catch {
    return `(output artifact ${outputRef} unreadable)`;
  }
}

async function describeLiveFailure(
  data: LiveFixture,
  attemptId: number,
  cause: unknown,
): Promise<Error> {
  const lines = [
    "the gated live OpenCode acceptance run failed",
    `  model: ${data.model}  binary: ${data.bin}`,
    `  artifacts: dataDir=${data.dataDir}`,
    `  workspace: ${data.workspace}`,
    `  remote: ${data.gitRepo.remotePath}`,
  ];
  const attempt = data.store.db.prepare("SELECT * FROM attempts WHERE id = ?").get(attemptId) as
    AttemptRow | undefined;
  if (attempt !== undefined) {
    lines.push(
      `  attempt: outcome=${attempt.outcome ?? "(none)"} stage=${attempt.failure_stage ?? "(none)"} reason=${attempt.failure_reason ?? "(none)"}`,
      `  parent session: ${attempt.agent_session_id ?? "(none)"}`,
      `  commit: ${attempt.commit_sha ?? "(none)"} pushed=${attempt.pushed}`,
    );
    lines.push(`  agent output:\n${outputSnippet(attempt.output_ref, 2400)}`);
  }
  const children = data.store.db
    .prepare(
      "SELECT session_id, outcome, state, interrupted FROM managed_child_sessions WHERE attempt_id = ? ORDER BY id",
    )
    .all(attemptId) as Array<{
    session_id: string;
    outcome: string | null;
    state: string;
    interrupted: number;
  }>;
  if (children.length > 0) {
    lines.push(
      `  child sessions: ${children
        .map(
          (c) =>
            `${c.session_id}(state=${c.state},outcome=${c.outcome ?? "none"},interrupted=${c.interrupted})`,
        )
        .join(", ")}`,
    );
  }
  const runs = data.store.db
    .prepare("SELECT command, exit_code FROM validation_runs WHERE attempt_id = ? ORDER BY seq")
    .all(attemptId) as Array<{ command: string; exit_code: number | null }>;
  if (runs.length > 0) {
    lines.push(
      `  validation runs: ${runs.map((r) => `${r.command} -> ${String(r.exit_code)}`).join(" | ")}`,
    );
  }
  if (cause instanceof Error) {
    lines.push(`  underlying: ${cause.message}`);
  }
  return new Error(lines.join("\n"));
}

/* ------------------------------------------------------------------ *
 * Assertions
 * ------------------------------------------------------------------ */

interface LiveCompleted {
  kind: "completed";
  value: { commitSha?: string };
}

async function assertLiveAcceptance(
  data: LiveFixture,
  attemptId: number,
  parentSessionId: string,
): Promise<void> {
  const attempt = data.store.db
    .prepare("SELECT * FROM attempts WHERE id = ?")
    .get(attemptId) as AttemptRow;
  assert.equal(attempt.outcome, "succeeded", "the live attempt must succeed");
  assert.equal(attempt.agent, "opencode");
  assert.equal(attempt.model, data.model);
  assert.match(attempt.agent_session_id ?? "", /^ses/gu, "the parent session id must be recorded");

  // The job retained its profile snapshot (D2) so job detail can show the
  // repository's managed team.
  const job = data.store.db
    .prepare(
      "SELECT id, opencode_profile_json, opencode_profile_revision, review_context FROM jobs",
    )
    .get() as {
    id: number;
    opencode_profile_json: string | null;
    opencode_profile_revision: number | null;
    review_context: string | null;
  };
  assert.ok(job.opencode_profile_json !== null, "the job must snapshot the managed profile");
  assert.ok(job.opencode_profile_json.includes("reviewer"), "the snapshot must carry the child");
  assert.ok(
    job.review_context?.includes(`change ${MARKER_FILE}`) ?? false,
    "the review context must reach the prompt",
  );

  // Timeline: the managed lifecycle completed in order; validation runs only
  // after the run (and its settlement) finished.
  const timeline = data.store.db
    .prepare("SELECT status FROM status_events WHERE job_id = ? ORDER BY id")
    .all(job.id) as { status: string }[];
  assert.deepEqual(
    timeline.map((row) => row.status),
    ["queued", "preparing", "running", "validating", "publishing", "reporting", "succeeded"],
    "the attempt must reach succeeded through the full managed timeline",
  );

  // Validation evidence: the marker was already complete and the generated
  // agent files already gone when the orchestrator's validation command ran,
  // so completion observably precedes validation.
  const runs = data.store.db
    .prepare("SELECT command, exit_code FROM validation_runs WHERE attempt_id = ? ORDER BY seq")
    .all(attemptId) as Array<{ command: string; exit_code: number | null }>;
  assert.equal(runs.length, 1, "exactly one validation command");
  assert.equal(runs[0]!.exit_code, 0, "the evidence assertion must pass");
  assert.ok(runs[0]!.command.includes(MARKER_EXPECTED), "the assertion must check the marker");

  // Child session evidence (task 4.4): the delegated child completed on its
  // own (terminal outcome, never interrupted) before validation.
  const children = data.store.db
    .prepare(
      "SELECT session_id, outcome, state, interrupted FROM managed_child_sessions WHERE attempt_id = ? ORDER BY id",
    )
    .all(attemptId) as Array<{
    session_id: string;
    outcome: string | null;
    state: string;
    interrupted: number;
  }>;
  assert.ok(children.length >= 1, "at least one child session must be recorded");
  assert.ok(
    children.every((child) => child.state === "settled"),
    "every child must be provably quiescent",
  );
  assert.ok(
    children.some((child) => child.outcome === "succeeded" && child.interrupted === 0),
    "the delegated child must have completed on its own, never interrupted",
  );
  for (const child of children) {
    assert.match(child.session_id, /^ses/gu, "child session ids must be real session ids");
  }

  // Generated files were removed before validation/publication.
  const namespace = `attempt-${attemptId}`;
  assert.equal(
    existsSync(join(data.workspace, ".opencode", "agents", namespace)),
    false,
    "the generated agent namespace must be gone after cleanup",
  );

  // Final local bare diff: only the intended marker fix; no generated files.
  const headRef = data.gitRepo.headBranch;
  const changed = (
    await git([
      "--git-dir",
      data.gitRepo.remotePath,
      "diff",
      "--name-only",
      data.initialSha,
      headRef,
    ])
  ).stdout
    .trim()
    .split(/\r?\n/u)
    .filter((line) => line.length > 0);
  assert.deepEqual(changed, [MARKER_FILE], "the remote diff must contain only the intended fix");
  const patch = (
    await git(["--git-dir", data.gitRepo.remotePath, "diff", data.initialSha, headRef])
  ).stdout;
  assert.equal(
    patch.includes(".opencode"),
    false,
    "the published diff must exclude generated files",
  );
  const headMarker = (
    await git(["--git-dir", data.gitRepo.remotePath, "show", `${headRef}:${MARKER_FILE}`])
  ).stdout;
  assert.equal(headMarker.trim(), MARKER_EXPECTED, "the published marker must be the intended fix");

  // GitHub is the fixture: one success reply, no external publication.
  assert.equal(data.github.replies.length, 1, "the fixture must record exactly one reply");
  assert.match(data.github.replies[0]!.body, /Resolved in commit/u);
  assert.equal(data.github.reactions.get(501), "hooray");

  // Session proof against the live service: the parent and child records we
  // just settled and recorded are real, attributed sessions in the attempt
  // workspace. These are REAL `opencode api` calls through the pinned surface.
  const env = buildAgentEnvironment(process.env, data.executor.additionalEnvironment(""));
  const http = createCliManagedSessionHttp({ cwd: data.workspace, env });
  const parentResult: ManagedHttpResult = await http.get(sessionRecordPath(parentSessionId));
  assert.equal(parentResult.status, 200, "the live parent session must still be readable");
  const parent = parseSessionRecord(parentResult.body);
  assert.ok(parent !== undefined, "the live parent record must parse");
  assert.equal(parent.outcome, "succeeded", "the live parent must have completed");
  assert.equal(parent.parentID, undefined, "the parent must be a root session");
  assert.ok(
    sameDirectory(parent.directory, data.workspace),
    "the parent must run in the workspace",
  );
  for (const child of children) {
    const childResult: ManagedHttpResult = await http.get(sessionRecordPath(child.session_id));
    assert.equal(childResult.status, 200, `live child ${child.session_id} must be readable`);
    const record = parseSessionRecord(childResult.body);
    assert.ok(record !== undefined, `live child ${child.session_id} must parse`);
    assert.equal(record.parentID, parentSessionId, "the child must attribute to the parent");
    assert.ok(
      sameDirectory(record.directory, data.workspace),
      "the child must run in the workspace",
    );
    assert.equal(
      record.outcome,
      child.outcome as OpenCodeSessionOutcome | undefined,
      "the live child outcome must match the persisted settlement",
    );
  }
}

/* ------------------------------------------------------------------ *
 * The gated live test
 * ------------------------------------------------------------------ */

test("gated live acceptance: a real OpenCode 2.0.16 run delegates the edit to the reviewer child and publishes only the intended diff", async (t) => {
  const model = process.env[LIVE_MODEL_ENV];
  if (model === undefined || model.trim() === "") {
    t.skip(
      `${LIVE_MODEL_ENV} is unset; the live OpenCode acceptance harness is opt-in. ` +
        `Set it to a low/no-cost model id such as "opencode/deepseek-v4-flash-free" and ` +
        "re-run this file directly.",
    );
    return;
  }
  const bin = process.env[LIVE_BIN_ENV] ?? "opencode";
  const installed = await probeOpenCodeVersion(bin);
  if (installed !== EXPECTED_OPENCODE_VERSION) {
    t.skip(
      `${bin} reports version ${installed ?? "unusable"}; this harness is pinned to ` +
        `OpenCode ${EXPECTED_OPENCODE_VERSION}`,
    );
    return;
  }

  const data = await setupLiveFixture(bin, model);
  try {
    const queued = await resolveEvent(data);
    let completed;
    try {
      completed = await withDeadline(
        queued.completed,
        HARD_DEADLINE_MS,
        "live OpenCode acceptance",
      );
    } catch (error) {
      throw await describeLiveFailure(data, queued.attemptId, error);
    }
    // Narrow the queue result: this fixture cannot be rejected while the PR is
    // open, and it must not be cancelled.
    if (completed.kind !== "completed") {
      throw await describeLiveFailure(data, queued.attemptId, completed);
    }
    const outcome = completed as LiveCompleted;

    const attempt = data.store.db
      .prepare("SELECT agent_session_id FROM attempts WHERE id = ?")
      .get(queued.attemptId) as { agent_session_id: string | null };
    if (attempt.agent_session_id === null) {
      throw new Error(
        "the live run captured no parent session id; the settlement surface cannot be proven",
      );
    }

    await assertLiveAcceptance(data, queued.attemptId, attempt.agent_session_id);

    console.log(
      `live OpenCode acceptance passed: ${bin} ${data.model}, attempt ${queued.attemptId}, ` +
        `parent ${attempt.agent_session_id}, commit ${outcome.value.commitSha ?? "(none)"}`,
    );
  } finally {
    data.store.close();
  }
});

/**
 * Separate explicit model opt-in: GREMLYN_LIVE_NATIVE_OPENCODE_MODEL.
 * Optional GREMLYN_LIVE_OPENCODE_AGENT must name a discovered eligible primary.
 * No native definitions are provisioned/copied; a dormant managed profile is
 * retained deliberately to prove it does not take over native execution.
 */
test("gated live native acceptance: discovered primary has actual initial identity and publishes only to a local fixture remote", async (t) => {
  const model = process.env.GREMLYN_LIVE_NATIVE_OPENCODE_MODEL;
  if (model === undefined || model.trim() === "") {
    t.skip(
      "GREMLYN_LIVE_NATIVE_OPENCODE_MODEL is unset; native real-model acceptance is explicitly opt-in",
    );
    return;
  }
  const bin = process.env[LIVE_BIN_ENV] ?? "opencode";
  if ((await probeOpenCodeVersion(bin)) !== EXPECTED_OPENCODE_VERSION) {
    t.skip(`native acceptance requires pinned OpenCode ${EXPECTED_OPENCODE_VERSION}`);
    return;
  }
  const data = await setupLiveFixture(bin, model, true);
  try {
    const queued = await resolveEvent(data);
    const completed = await withDeadline(
      queued.completed,
      HARD_DEADLINE_MS,
      "native live acceptance",
    );
    assert.equal(
      completed.kind,
      "completed",
      `native attempt failed; preserved diagnostics at ${data.dataDir}`,
    );
    const job = data.store.db
      .prepare(
        "SELECT opencode_source, opencode_native_agent_id, opencode_profile_json FROM jobs WHERE id = ?",
      )
      .get(queued.jobId) as {
      opencode_source: string;
      opencode_native_agent_id: string;
      opencode_profile_json: string | null;
    };
    assert.equal(job.opencode_source, "native");
    assert.equal(job.opencode_native_agent_id, data.nativeAgentId);
    assert.equal(
      job.opencode_profile_json,
      null,
      "dormant managed instructions must not enter native capture",
    );
    const attempt = data.store.db
      .prepare("SELECT outcome, agent_session_id, commit_sha, pushed FROM attempts WHERE id = ?")
      .get(queued.attemptId) as {
      outcome: string;
      agent_session_id: string;
      commit_sha: string;
      pushed: number;
    };
    assert.equal(attempt.outcome, "succeeded");
    assert.match(attempt.agent_session_id, /^ses/u);
    const env = buildAgentEnvironment(process.env, data.executor.additionalEnvironment(""));
    const worker = data.executor.resolveWorker({
      executorId: "opencode",
      cwd: data.workspace,
      env,
    });
    const identity = await readOpenCodeInitialIdentity({
      http: createCliManagedSessionHttp(worker),
      parentSessionId: attempt.agent_session_id,
      cwd: data.workspace,
    });
    assert.equal(
      identity.agentId,
      data.nativeAgentId,
      "actual FIRST assistant identity must prove native selection, not the saved label or mutable current agent",
    );
    assert.ok(identity.model, "actual initial model is observed");
    assert.equal(
      existsSync(join(data.workspace, ".opencode", "agents", `attempt-${queued.attemptId}`)),
      false,
    );
    const changed = (
      await git([
        "--git-dir",
        data.gitRepo.remotePath,
        "diff",
        "--name-only",
        data.initialSha,
        data.gitRepo.headBranch,
      ])
    ).stdout
      .trim()
      .split(/\r?\n/u)
      .filter(Boolean);
    assert.deepEqual(changed, [MARKER_FILE]);
    assert.equal(
      (
        await git([
          "--git-dir",
          data.gitRepo.remotePath,
          "show",
          `${data.gitRepo.headBranch}:${MARKER_FILE}`,
        ])
      ).stdout.trim(),
      MARKER_EXPECTED,
    );
    assert.equal(attempt.pushed, 1);
    assert.equal(
      await remoteSha(data.gitRepo.remotePath, data.gitRepo.headBranch),
      attempt.commit_sha,
    );
    assert.equal(data.github.replies.length, 1, "only fixture GitHub records the success reply");
  } finally {
    data.store.close();
  }
});
