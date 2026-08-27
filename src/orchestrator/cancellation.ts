import { JobStore } from "../store/jobs.js";
import { statusEntries } from "../workspace/gitops.js";

/** Persist cancellation after independently inspecting the prepared workspace. */
export async function recordRunningCancellation(
  jobs: JobStore,
  jobId: number,
  attemptId: number,
  workspacePath: string,
): Promise<void> {
  const hasUncommittedChanges = (await statusEntries(workspacePath)).length > 0;
  jobs.cancelJob(jobId, attemptId, hasUncommittedChanges);
}
