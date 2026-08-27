import { existsSync } from "node:fs";
import { rm } from "node:fs/promises";
import { resolve } from "node:path";
import type { OperatorActionStore } from "../store/actions.js";
import { git } from "./gitops.js";
import {
  isBeneath,
  prepareWorkspace,
  type PreparedWorkspace,
  WorkspaceError,
  workspacePathFor,
} from "./worktree.js";

/**
 * Explicit workspace reset (design D9, workspace-isolation spec).
 *
 * `git reset --hard` and `git clean -fd` exist ONLY here: discarding working
 * tree contents happens solely through this deliberately requested action,
 * and only after the target path is asserted to lie beneath a configured
 * workspace root. Everything else refuses to touch workspace contents.
 */

export async function resetWorkspace(options: {
  sourcePath: string;
  workspaceRoot: string;
  prNumber: number;
  headBranch: string;
  headSha: string;
  targetPath?: string;
  actions: Pick<OperatorActionStore, "record">;
}): Promise<PreparedWorkspace> {
  const expectedPath = workspacePathFor(options.workspaceRoot, options.prNumber);
  const targetPath = options.targetPath ?? expectedPath;
  const validTarget =
    isBeneath(targetPath, options.workspaceRoot) && resolve(targetPath) === resolve(expectedPath);

  if (!validTarget) {
    options.actions.record({
      action: "workspace-reset",
      target: targetPath,
      effect: "refused",
      detail: { reason: "workspace-outside-root" },
    });
    throw new WorkspaceError(
      "workspace-outside-root",
      `refusing to reset ${targetPath}: it is not the configured workspace for PR ${options.prNumber}`,
    );
  }

  if (existsSync(targetPath)) {
    try {
      await git(["worktree", "remove", "--force", targetPath], {
        cwd: options.sourcePath,
      });
    } catch {
      await rm(targetPath, { recursive: true, force: true });
      await git(["worktree", "prune"], { cwd: options.sourcePath });
    }
  }

  const prepared = await prepareWorkspace(options);
  options.actions.record({
    action: "workspace-reset",
    target: targetPath,
    effect: "recreated",
    detail: { prNumber: options.prNumber, headSha: prepared.headSha },
  });
  return prepared;
}
