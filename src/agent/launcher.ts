import { execa } from "execa";
import { existsSync, readFileSync } from "node:fs";
import { delimiter, dirname, join } from "node:path";

/**
 * Agent-agnostic process launcher (design D10). Every executor spawns its CLI
 * through {@link defaultRunner}; nothing here knows which agent it is running.
 */

export interface ProcessResult {
  stdout: string;
  stderr: string;
  exitCode: number | undefined;
  timedOut: boolean;
  isCanceled: boolean;
}

export type ProcessRunner = (
  binary: string,
  args: readonly string[],
  options: {
    cwd?: string;
    env: Record<string, string>;
    timeoutMs?: number;
    signal?: AbortSignal;
    /**
     * Called with each complete stdout line as it arrives, so a caller can
     * follow a run in progress. The buffered stdout is still returned in full
     * on exit; this is an addition, not a replacement.
     */
    onLine?: (line: string) => void;
  },
) => Promise<ProcessResult>;

/**
 * On Windows, an npm-installed CLI on PATH is a `.cmd` shim. Node refuses to
 * execute a `.cmd` directly (CVE-2024-27980) and routes it through `cmd.exe`,
 * whose command line is capped at 8191 characters — far below the 32767 that
 * `CreateProcess` allows. The resolution prompt carries the review thread and
 * the repository's agent instructions, so it clears 8191 easily, and the spawn
 * dies in milliseconds with "The command line is too long." before the agent
 * runs at all.
 *
 * The shim's own last line is `"%_prog%" "%dp0%\<entry>" %*`, so invoking that
 * entry with the current Node binary reproduces exactly what the shim does
 * while skipping `cmd.exe` and its limit. That rewrite only applies when the
 * entry is actually a Node script (`.js`, `.mjs`, `.cjs`): some CLIs (e.g.
 * opencode) ship a shim with an identical final line wrapping a native
 * executable instead, and handing that to Node parses its PE header as
 * JavaScript. A non-script entry is spawned directly — not returned as
 * undefined for the caller to fall back to the `.cmd` — because the fallback
 * would route through `cmd.exe` and hit the very 8191-character limit this
 * helper exists to avoid.
 *
 * Returns undefined whenever anything is unrecognised, leaving the caller to
 * spawn the binary as configured.
 */
export function resolveWindowsShim(binary: string): { binary: string; prefix: string[] } | undefined {
  if (process.platform !== "win32") return undefined;
  let shimPath: string | undefined;
  if (/\.cmd$/iu.test(binary) && existsSync(binary)) {
    shimPath = binary;
  } else {
    const direct = `${binary}.cmd`;
    if (existsSync(direct)) {
      shimPath = direct;
    } else {
      // A bare name (the common case): find the shim the way the OS would.
      for (const dir of (process.env.PATH ?? "").split(delimiter)) {
        if (dir === "") continue;
        const candidate = join(dir, `${binary}.cmd`);
        if (existsSync(candidate)) {
          shimPath = candidate;
          break;
        }
      }
    }
  }
  if (shimPath === undefined) return undefined;
  let contents: string;
  try {
    contents = readFileSync(shimPath, "utf8");
  } catch {
    return undefined;
  }
  // Anchor on the trailing `%*` of the invocation line. An unanchored match
  // finds the shim's earlier `IF EXIST "%dp0%\node.exe"` probe and resolves the
  // entry to node.exe itself, which then tries to parse its own binary as JS.
  const match = /"%dp0%\\([^"]+)"\s+%\*/u.exec(contents);
  if (!match?.[1]) return undefined;
  const entry = join(dirname(shimPath), match[1]);
  if (!existsSync(entry)) return undefined;
  if (/\.(?:m?js|cjs)$/iu.test(entry)) {
    return { binary: process.execPath, prefix: [entry] };
  }
  return { binary: entry, prefix: [] };
}

export const defaultRunner: ProcessRunner = async (binary, args, options) => {
  const shim = resolveWindowsShim(binary);
  if (shim) {
    binary = shim.binary;
    args = [...shim.prefix, ...args];
  }
  const subprocess = execa(binary, args, {
    ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
    env: options.env,
    extendEnv: false,
    shell: false,
    // Reads must hit EOF immediately. execa's default is an open pipe that is
    // never written to, so an agent that prompts for input would block until
    // the timeout instead of failing fast.
    stdin: "ignore",
    reject: false,
    ...(options.timeoutMs === undefined ? {} : { timeout: options.timeoutMs }),
    ...(options.signal === undefined ? {} : { cancelSignal: options.signal }),
  });
  if (options.onLine && subprocess.stdout) {
    // Observe the stream without consuming it: execa still buffers stdout, so
    // the completed result is unchanged whether or not anyone is watching.
    const emit = options.onLine;
    let pending = "";
    subprocess.stdout.on("data", (chunk: Buffer | string) => {
      pending += typeof chunk === "string" ? chunk : chunk.toString("utf8");
      const lines = pending.split(/\r?\n/u);
      // The trailing element is an incomplete line; hold it for the next chunk.
      pending = lines.pop() ?? "";
      for (const line of lines) {
        // A malformed line must never take down the run being observed.
        try {
          emit(line);
        } catch {
          /* ignore */
        }
      }
    });
    subprocess.stdout.on("end", () => {
      if (pending !== "") {
        try {
          emit(pending);
        } catch {
          /* ignore */
        }
        pending = "";
      }
    });
  }
  const result = await subprocess;
  return {
    stdout: result.stdout,
    stderr: result.stderr,
    exitCode: result.exitCode,
    timedOut: result.timedOut,
    isCanceled: result.isCanceled,
  };
};
