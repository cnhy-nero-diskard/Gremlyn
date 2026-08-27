import type Database from "better-sqlite3";
import { execa } from "execa";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

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

const defaultRunner: ValidationProcessRunner = async (executable, args, options) => {
  const result = await execa(executable, args, { ...options, reject: false });
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
