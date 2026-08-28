import { existsSync, readFileSync } from "node:fs";
import { basename, dirname, join, normalize, resolve, win32 } from "node:path";
import { git } from "../workspace/gitops.js";
import type { AgentDefinition, RepoConfig } from "../config/loader.js";
import type { ReasoningEffort } from "../types.js";

export interface RepositoryIdentity {
  owner: string;
  name: string;
}

export interface InferredValue<T> {
  value: T;
  provenance: string;
}

export interface ValidationCommandCandidate {
  command: string[];
  script: string;
  provenance: string;
}

export interface RepositoryInference {
  identity?: InferredValue<RepositoryIdentity>;
  workspaceRoot: InferredValue<string>;
  validationCommands: ValidationCommandCandidate[];
  settings?: InferredValue<RepositorySettings>;
}

export interface RepositorySettings {
  agent: string;
  provider: string;
  model: string;
  effort: ReasoningEffort;
}

/** Parse the GitHub SSH, HTTPS, and ssh:// origin forms supported by Gremlyn. */
export function parseOriginUrl(origin: string): RepositoryIdentity | undefined {
  const value = origin.trim();
  const sshScp = /^git@github\.com:([^/\s]+)\/([^/\s]+?)(?:\.git)?\/?$/iu.exec(value);
  if (sshScp) return identityFromParts(sshScp[1], sshScp[2]);

  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    return undefined;
  }
  if (parsed.hostname.toLowerCase() !== "github.com") return undefined;
  if (parsed.protocol !== "https:" && parsed.protocol !== "ssh:") return undefined;
  const parts = parsed.pathname.split("/").filter((part) => part.length > 0);
  if (parts.length !== 2) return undefined;
  const name = parts[1]!.replace(/\.git$/iu, "");
  return identityFromParts(parts[0], name);
}

function identityFromParts(
  owner: string | undefined,
  name: string | undefined,
): RepositoryIdentity | undefined {
  if (!owner || !name || owner === "." || name === ".") return undefined;
  return { owner, name };
}

/** Inspect a checkout's origin without guessing from its directory name. */
export async function inferIdentityFromOrigin(
  sourcePath: string,
): Promise<InferredValue<RepositoryIdentity> | undefined> {
  try {
    const { stdout } = await git(["remote", "get-url", "origin"], { cwd: sourcePath });
    const identity = parseOriginUrl(stdout);
    return identity ? { value: identity, provenance: "derived from origin remote" } : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Propose a sibling workspace root. If the immediate sibling is covered by
 * another configured source, walk outward until a safe sibling is found.
 */
export function proposeWorkspaceRoot(
  sourcePath: string,
  otherSourcePaths: readonly string[] = [],
): InferredValue<string> | undefined {
  const source = resolveComparable(sourcePath);
  const sourceName =
    source.platform === "win32" ? win32.basename(source.path) : basename(source.path);
  let parent = source.dirname;
  const seen = new Set<string>();

  for (let attempt = 0; attempt < 32; attempt += 1) {
    const suffix = attempt === 0 ? "" : `-${attempt + 1}`;
    const candidate = comparableJoin(parent, `${sourceName}-workspaces${suffix}`, source.platform);
    const conflict = otherSourcePaths
      .map((other) => resolveComparable(other, source.platform))
      .find((other) => isContained(candidate, other));
    if (!conflict && !seen.has(candidate.path) && !isContained(candidate, source)) {
      return { value: candidate.path, provenance: "sibling of source path" };
    }
    seen.add(candidate.path);
    parent = conflict ? conflict.dirname : dirnamePortable(parent, source.platform);
    if (parent === "." || parent === "") break;
  }
  return undefined;
}

/** Return recognized npm scripts as literal argv candidates, never execution defaults. */
export function inferValidationCommands(sourcePath: string): ValidationCommandCandidate[] {
  const packagePath = join(sourcePath, "package.json");
  if (!existsSync(packagePath)) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(packagePath, "utf8")) as unknown;
  } catch {
    return [];
  }
  if (!isRecord(parsed) || !isRecord(parsed.scripts)) return [];
  const scripts = parsed.scripts;
  const names = ["test", "build", "typecheck", "lint"];
  const candidates: ValidationCommandCandidate[] = [];
  for (const name of names) {
    if (typeof scripts[name] !== "string") continue;
    const command = name === "test" ? ["npm", "test"] : ["npm", "run", name];
    candidates.push({
      command,
      script: name,
      provenance: "package.json script",
    });
  }
  return candidates;
}

/** Inherit all four execution settings from an existing registration. */
export function inheritRepositorySettings(
  existing: RepoConfig | undefined,
  agents: Record<string, AgentDefinition>,
  preferredAgent?: string,
): InferredValue<RepositorySettings> | undefined {
  if (existing) {
    return {
      value: {
        agent: existing.agent,
        provider: existing.provider,
        model: existing.model,
        effort: existing.effort,
      },
      provenance: "inherited from existing repository entry",
    };
  }
  const agentId = preferredAgent ?? Object.keys(agents)[0];
  if (!agentId) return undefined;
  const agent = agents[agentId];
  if (!agent || agent.efforts.length === 0) return undefined;
  return {
    value: {
      agent: agent.id,
      provider: "",
      model: "",
      effort: agent.efforts[agent.efforts.length - 1]!,
    },
    provenance: "inherited from configured agent ceiling",
  };
}

export async function inferRepository(
  sourcePath: string,
  options: {
    existingEntries?: readonly RepoConfig[];
    agents?: Record<string, AgentDefinition>;
    preferredAgent?: string;
  } = {},
): Promise<RepositoryInference> {
  const existingEntries = options.existingEntries ?? [];
  const identity = await inferIdentityFromOrigin(sourcePath);
  const workspaceRoot = proposeWorkspaceRoot(
    sourcePath,
    existingEntries.map((entry) => entry.sourcePath),
  );
  const settings = options.agents
    ? inheritRepositorySettings(existingEntries[0], options.agents, options.preferredAgent)
    : undefined;
  return {
    ...(identity ? { identity } : {}),
    ...(workspaceRoot
      ? { workspaceRoot }
      : {
          workspaceRoot: {
            value: "",
            provenance: "sibling of source path (no safe sibling could be proposed)",
          },
        }),
    validationCommands: inferValidationCommands(sourcePath),
    ...(settings ? { settings } : {}),
  };
}

interface ComparablePath {
  path: string;
  dirname: string;
  platform: "posix" | "win32";
}

function resolveComparable(value: string, preferred?: "posix" | "win32"): ComparablePath {
  const platform = preferred ?? (looksWindows(value) ? "win32" : "posix");
  const path = platform === "win32" ? win32.resolve(value) : resolve(value);
  const normalized = normalizeComparable(path, platform);
  return {
    path: normalized,
    dirname: platform === "win32" ? win32.dirname(normalized) : dirname(normalized),
    platform,
  };
}

function comparableJoin(
  parent: string,
  child: string,
  platform: "posix" | "win32",
): ComparablePath {
  const path = platform === "win32" ? win32.join(parent, child) : join(parent, child);
  return resolveComparable(path, platform);
}

function dirnamePortable(value: string, platform: "posix" | "win32"): string {
  return platform === "win32" ? win32.dirname(value) : dirname(value);
}

function normalizeComparable(value: string, platform: "posix" | "win32"): string {
  const normalized = platform === "win32" ? win32.normalize(value) : normalize(value);
  return platform === "win32" ? normalized.toLowerCase() : normalized;
}

function isContained(child: ComparablePath, parent: ComparablePath): boolean {
  if (child.platform !== parent.platform) return false;
  const childPath = normalizeComparable(child.path, child.platform);
  const parentPath = normalizeComparable(parent.path, parent.platform).replace(/[\\/]$/u, "");
  return (
    childPath === parentPath ||
    childPath.startsWith(`${parentPath}${child.platform === "win32" ? "\\" : "/"}`)
  );
}

function looksWindows(value: string): boolean {
  return /^[a-z]:[\\/]/iu.test(value) || value.includes("\\") || value.startsWith("\\\\");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
