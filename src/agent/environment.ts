/**
 * Host variables an agent process may receive. The list is intentionally
 * narrow and does not include application credentials or arbitrary GREMLYN_*
 * values.
 */
export const AGENT_ENV_ALLOWLIST = [
  "APPDATA",
  "COMSPEC",
  "HOME",
  "HOMEDRIVE",
  "HOMEPATH",
  "LOCALAPPDATA",
  "PATH",
  "PATHEXT",
  "SYSTEMDRIVE",
  "SYSTEMROOT",
  "TEMP",
  "TMP",
  "USERPROFILE",
  "WINDIR",
] as const;

export function buildAgentEnvironment(
  source: NodeJS.ProcessEnv = process.env,
  additional: Readonly<Record<string, string>> = {},
): Record<string, string> {
  const environment: Record<string, string> = {};
  for (const key of AGENT_ENV_ALLOWLIST) {
    const value = source[key];
    if (value !== undefined) environment[key] = value;
  }
  for (const [key, value] of Object.entries(additional)) environment[key] = value;
  return environment;
}
