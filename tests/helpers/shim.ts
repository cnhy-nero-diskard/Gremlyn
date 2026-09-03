import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

/**
 * Writes an npm-style `.cmd` shim plus its entry file into a fresh temp
 * directory, mimicking what `npm install` generates on Windows. `entryName`
 * is the shim's target file name (e.g. "cli.js" or "cli.exe") — its extension
 * is what `resolveWindowsShim` classifies to choose a script or native entry
 * fixture. The shim's final line is the one real shims share regardless of
 * what they wrap: `"%dp0%\<entry>" %*`.
 */
export function writeShimFixture(
  shimName: string,
  entryName: string,
): { dir: string; shimPath: string; entryPath: string } {
  const dir = mkdtempSync(join(tmpdir(), "gremlyn-shim-"));
  const entryPath = join(dir, entryName);
  mkdirSync(dirname(entryPath), { recursive: true });
  writeFileSync(entryPath, "", "utf8");
  const shimPath = join(dir, `${shimName}.cmd`);
  writeFileSync(
    shimPath,
    [
      "@ECHO off",
      "GOTO start",
      ":find_dp0",
      "SET dp0=%~dp0",
      "EXIT /b",
      ":start",
      "SETLOCAL",
      "CALL :find_dp0",
      `"%dp0%\\${entryName}"   %*`,
      "",
    ].join("\r\n"),
    "utf8",
  );
  return { dir, shimPath, entryPath };
}
