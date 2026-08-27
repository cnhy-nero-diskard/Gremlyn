import {
  currentBranch,
  git,
  mergeInProgress,
  statusEntries,
  unmergedEntries,
} from "../workspace/gitops.js";

export type InspectionFailureReason = "workspace-invalid" | "wrong-branch" | "workspace-conflicted";

export type WorkspaceInspection =
  | { ok: true; modified: boolean; branch: string }
  | { ok: false; modified: boolean; branch: string | null; reason: InspectionFailureReason };

/** Inspect git state independently of anything the agent reported. */
export async function inspectWorkspace(
  workspacePath: string,
  expectedBranch: string,
): Promise<WorkspaceInspection> {
  let modified = false;
  let branch: string | null = null;
  try {
    const inside = await git(["rev-parse", "--is-inside-work-tree"], { cwd: workspacePath });
    if (inside.stdout.trim() !== "true") {
      return { ok: false, modified, branch, reason: "workspace-invalid" };
    }
    const entries = await statusEntries(workspacePath);
    modified = entries.length > 0;
    branch = await currentBranch(workspacePath);
    if (branch !== expectedBranch) {
      return { ok: false, modified, branch, reason: "wrong-branch" };
    }
    if (
      (await unmergedEntries(workspacePath)).length > 0 ||
      (await mergeInProgress(workspacePath))
    ) {
      return { ok: false, modified, branch, reason: "workspace-conflicted" };
    }
    if (await containsConflictMarkers(workspacePath)) {
      return { ok: false, modified, branch, reason: "workspace-conflicted" };
    }
    return { ok: true, modified, branch };
  } catch {
    return { ok: false, modified, branch, reason: "workspace-invalid" };
  }
}

async function containsConflictMarkers(workspacePath: string): Promise<boolean> {
  try {
    const result = await git(
      ["grep", "-n", "-I", "-E", "^(<<<<<<< |=======|>>>>>>> )", "--", "."],
      { cwd: workspacePath },
    );
    return result.stdout.length > 0;
  } catch {
    // git grep exits 1 when no matches are present.
    return false;
  }
}
