import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { AgentResult } from "../types.js";

/** Write bulky agent output outside SQLite and return its persisted reference. */
export function writeAgentOutput(
  dataDir: string,
  attemptId: number,
  result: AgentResult,
  redact: (value: string) => string = (value) => value,
): string {
  const outputDir = join(dataDir, "output");
  mkdirSync(outputDir, { recursive: true });
  const outputRef = join(outputDir, `attempt-${attemptId}.json`);
  writeFileSync(
    outputRef,
    JSON.stringify(
      {
        stdout: redact(result.stdout),
        stderr: redact(result.stderr),
        exitCode: result.exitCode,
        sessionId: result.sessionId ?? null,
        startedAt: result.startedAt,
        endedAt: result.endedAt,
        timedOut: result.timedOut,
      },
      null,
      2,
    ) + "\n",
    "utf8",
  );
  return outputRef;
}
