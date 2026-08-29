import type Database from "better-sqlite3";
import { execa } from "execa";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { isAbsolute, join, resolve as resolvePath } from "node:path";

export interface ValidationProcessResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

export type ValidationProcessRunner = (
  executable: string,
  args: readonly string[],
  options: { cwd: string; shell: false },
) => Promise<ValidationProcessResult>;

/**
 * Resolve a project-local launcher against the workspace.
 *
 * A repository's own wrapper — `gradlew.bat`, `mvnw`, `./scripts/check.sh` —
 * lives in the checkout, not on PATH. Spawning it by bare name fails with
 * "'gradlew.bat' is not recognized as an internal or external command" even
 * though `cwd` is the workspace: Windows resolves the executable before the
 * child's working directory applies, and prefixing `./` does not help either.
 * Only an absolute path works.
 *
 * Resolution is conditional on the file actually existing in the workspace, so
 * a PATH tool of the same shape (`npm.cmd`) is left untouched.
 */
function resolveWorkspaceExecutable(executable: string, cwd: string): string {
  if (isAbsolute(executable)) return executable;
  const candidate = resolvePath(cwd, executable);
  return existsSync(candidate) ? candidate : executable;
}

const defaultRunner: ValidationProcessRunner = async (executable, args, options) => {
  const result = await execa(resolveWorkspaceExecutable(executable, options.cwd), args, {
    ...options,
    reject: false,
  });
  return { stdout: result.stdout, stderr: result.stderr, exitCode: result.exitCode ?? -1 };
};

export interface ValidationRun {
  seq: number;
  command: string[];
  exitCode: number;
  durationMs: number;
  outputRef: string;
}

export interface ValidationOutcome {
  configured: boolean;
  succeeded: boolean;
  runs: ValidationRun[];
}

/** Run configured argv commands sequentially, retaining each result separately. */
export async function runValidationCommands(input: {
  commands: readonly (readonly string[])[];
  cwd: string;
  dataDir: string;
  attemptId: number;
  db?: Database.Database;
  runner?: ValidationProcessRunner;
  redact?: (value: string) => string;
}): Promise<ValidationOutcome> {
  if (input.commands.length === 0) {
    return { configured: false, succeeded: true, runs: [] };
  }
  const runner = input.runner ?? defaultRunner;
  const redact = input.redact ?? ((value: string) => value);
  const outputDir = join(input.dataDir, "validation");
  mkdirSync(outputDir, { recursive: true });
  const runs: ValidationRun[] = [];

  for (const [index, command] of input.commands.entries()) {
    const [executable, ...args] = command;
    if (!executable) throw new Error(`validation command ${index + 1} has no executable`);
    const started = performance.now();
    const result = await runner(executable, args, { cwd: input.cwd, shell: false });
    const durationMs = Math.max(0, Math.round(performance.now() - started));
    const seq = index + 1;
    const outputRef = join(outputDir, `attempt-${input.attemptId}-${seq}.json`);
    writeFileSync(
      outputRef,
      JSON.stringify(
        {
          command,
          stdout: redact(result.stdout),
          stderr: redact(result.stderr),
          exitCode: result.exitCode,
          durationMs,
        },
        null,
        2,
      ) + "\n",
      "utf8",
    );
    const run = { seq, command: [...command], exitCode: result.exitCode, durationMs, outputRef };
    runs.push(run);
    input.db
      ?.prepare(
        `INSERT INTO validation_runs
           (attempt_id, seq, command, exit_code, duration_ms, output_ref)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(input.attemptId, seq, JSON.stringify(command), result.exitCode, durationMs, outputRef);
    if (result.exitCode !== 0) break;
  }

  return {
    configured: true,
    succeeded: runs.length === input.commands.length && runs.every((run) => run.exitCode === 0),
    runs,
  };
}
