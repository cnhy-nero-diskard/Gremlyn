import { test } from "node:test";
import assert from "node:assert/strict";
import { reactionForStatus } from "../src/orchestrator/reactions.js";
import { JOB_STATUSES } from "../src/types.js";

test("reactionForStatus maps every job status to one of GitHub's reaction contents", () => {
  const expected: Record<string, string> = {
    queued: "eyes",
    preparing: "rocket",
    running: "rocket",
    validating: "rocket",
    publishing: "rocket",
    reporting: "rocket",
    succeeded: "hooray",
    failed: "confused",
    cancelled: "confused",
    interrupted: "confused",
  };
  for (const status of JOB_STATUSES) {
    assert.equal(reactionForStatus(status), expected[status], status);
  }
});
