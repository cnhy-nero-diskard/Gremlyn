import { writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import type { AgentExecutor, AgentResult, AgentRunOptions } from "../types.js";

/**
 * Fake executor (design D10). A first-class peer of the real executor: every
 * simulated outcome from the design is selectable, and every invocation is
 * recorded for observation in tests.
 */

export const FAKE_OUTCOMES = [
  "success",
  "failure",
  "timeout",
  "no-changes",
  "files-modified",
  "validation-failure",
] as const;
export type FakeOutcome = (typeof FAKE_OUTCOMES)[number];

export interface FakeRun {
  options: AgentRunOptions;
  result: AgentResult;
}

export class FakeExecutor implements AgentExecutor {
  readonly id = "fake";
  /** Every invocation, in order, for assertion. */
  readonly runs: FakeRun[] = [];
  /** Defaults to true: most tests simulate one invocation per attempt. */
  readonly honorsRetries: boolean;

  constructor(
    private readonly behavior: {
      outcome: FakeOutcome;
      /** Files to write into the working directory, relative path → content. */
      edits?: Record<string, string>;
      /** Exit code override (default 0 for most outcomes, 1 for failure). */
      exitCode?: number;
      stdout?: string;
      stderr?: string;
      sessionId?: string;
      /** Artificial delay in ms before "completing" (timeout testing). */
      delayMs?: number;
      /** Simulate an executor whose CLI has no retry allowance of its own. */
      honorsRetries?: boolean;
    },
  ) {
    this.honorsRetries = behavior.honorsRetries ?? true;
  }

  async checkVersion(): Promise<void> {
    // A fake CLI is always the expected version.
  }

  additionalEnvironment(): Record<string, string> {
    return {};
  }

  async run(opts: AgentRunOptions): Promise<AgentResult> {
    const startedAt = new Date().toISOString();
    const b = this.behavior;
    const defaultExit = b.outcome === "failure" ? 1 : 0;
    const exitCode = b.exitCode ?? defaultExit;

    const result: AgentResult = {
      stdout: b.stdout ?? defaultStdoutFor(b.outcome),
      stderr: b.stderr ?? "",
      exitCode,
      ...(b.sessionId !== undefined ? { sessionId: b.sessionId } : {}),
      startedAt,
      endedAt: startedAt,
      timedOut: false,
    };

    if (b.outcome === "timeout") {
      // Simulate a hung agent: waits until aborted or an artificial delay
      // elapses. The runner terminates via the abort signal.
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, b.delayMs ?? 60_000);
        opts.signal.addEventListener("abort", () => {
          clearTimeout(timer);
          resolve();
        });
      });
      result.timedOut = true;
      result.exitCode = -1;
      result.stderr = b.stderr ?? "terminated";
    } else if (b.outcome !== "no-changes" && b.outcome !== "failure") {
      // success, files-modified, validation-failure: apply the scripted edits.
      for (const [rel, content] of Object.entries(b.edits ?? {})) {
        const abs = join(opts.cwd, rel);
        mkdirSync(dirname(abs), { recursive: true });
        writeFileSync(abs, content, "utf8");
      }
    }

    result.endedAt = new Date().toISOString();
    this.runs.push({ options: opts, result });
    return result;
  }
}

function defaultStdoutFor(outcome: FakeOutcome): string {
  switch (outcome) {
    case "success":
      return "RESOLVED: feedback implemented.";
    case "no-changes":
      return "DECLINED: feedback not implemented (see explanation).";
    case "failure":
      return "";
    case "timeout":
      return "";
    case "files-modified":
    case "validation-failure":
      return "Modified files per feedback.";
  }
}
