import { test } from "node:test";
import assert from "node:assert/strict";
import { Store } from "../src/store/db.js";
import { Logger } from "../src/log/logger.js";
import { createRedactor, REDACTED } from "../src/log/redact.js";

test("a log call containing a secret value emits it redacted", () => {
  const store = new Store({ dataDir: ":memory:", file: ":memory:" });
  const logger = new Logger({
    level: "debug",
    secrets: ["ghp_super_secret_value"],
    db: store.db,
  });
  logger.info("agent launched", {
    jobId: 7,
    attemptId: 3,
    detail: "token was ghp_super_secret_value ok",
  });
  const row = store.db
    .prepare("SELECT event, job_id, attempt_id, fields FROM log_entries")
    .get() as { event: string; job_id: number; attempt_id: number; fields: string };
  assert.equal(row.job_id, 7);
  assert.equal(row.attempt_id, 3);
  const fields = JSON.parse(row.fields) as { detail: string };
  assert.equal(fields.detail, `token was ${REDACTED} ok`);
  assert.ok(!row.fields.includes("ghp_super_secret_value"));
  store.close();
});

test("redactor replaces every occurrence of every secret", () => {
  const redact = createRedactor(["alpha-secret", "beta-secret"]);
  const out = redact("alpha-secret and beta-secret and alpha-secret again");
  assert.equal(out, `${REDACTED} and ${REDACTED} and ${REDACTED} again`);
});

test("log level filters lower-severity entries", () => {
  const store = new Store({ dataDir: ":memory:", file: ":memory:" });
  const logger = new Logger({ level: "warn", secrets: [], db: store.db });
  logger.info("not stored");
  logger.error("stored");
  const rows = store.db.prepare("SELECT event FROM log_entries").all() as {
    event: string;
  }[];
  assert.deepEqual(rows.map((r) => r.event), ["stored"]);
  store.close();
});
