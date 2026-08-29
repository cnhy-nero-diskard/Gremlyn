import type { ReactionContent } from "../github/client.js";
import type { JobStatus } from "../types.js";

/**
 * Maps a job's lifecycle status to the reaction the orchestrator leaves on
 * the triggering review comment, so the comment itself surfaces progress
 * without anyone opening the job.
 *
 * - `eyes`: the command was seen and accepted, work has not started yet.
 * - `rocket`: an attempt is actively preparing, running, validating,
 *   publishing, or reporting.
 * - `hooray`: the job finished successfully.
 * - `confused`: the job failed, was cancelled, or was interrupted.
 */
export function reactionForStatus(status: JobStatus): ReactionContent {
  switch (status) {
    case "queued":
      return "eyes";
    case "preparing":
    case "running":
    case "validating":
    case "publishing":
    case "reporting":
      return "rocket";
    case "succeeded":
      return "hooray";
    case "failed":
    case "cancelled":
    case "interrupted":
      return "confused";
  }
}
