import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Store } from "../src/store/db.js";
import { JobStore } from "../src/store/jobs.js";
import { OperatorActionStore } from "../src/store/actions.js";
import { readOpenCodeProfile } from "../src/store/opencode-profiles.js";
import { readOpenCodeSelection, saveOpenCodeSelection } from "../src/store/opencode-selections.js";
import { buildConsoleServer } from "../src/console/server.js";
import { defaultOpenCodeAgentProfile } from "../src/config/opencode-profile.js";

test("offline operator flow keeps saves, activation, source changes and old-job retries distinct across restart", async () => {
  const dir = mkdtempSync(join(tmpdir(), "gremlyn-activation-flow-"));
  const file = join(dir, "store.db");
  let store = new Store({ dataDir: dir, file });
  const repoId = Number(
    store.db
      .prepare(
        `INSERT INTO repositories
         (owner, name, source_path, workspace_root, agent, model, provider, effort, enabled)
         VALUES ('fixture', 'activation-flow', 'offline-source', 'offline-workspaces',
                 'opencode', 'opencode/gpt-5.4', '', 'high', 1)`,
      )
      .run().lastInsertRowid,
  );
  const headers = { authorization: "Bearer offline-fixture-token" };
  let refreshFails = false;
  const notifications: number[] = [];
  const app = buildConsoleServer({
    db: store.db,
    token: "offline-fixture-token",
    secrets: [],
    operatorActions: new OperatorActionStore(store.db),
    actions: {
      repositorySettingsChanged: (id) => {
        notifications.push(id);
        if (refreshFails) throw new Error("offline refresh fixture failure");
      },
    },
  });
  const profile = defaultOpenCodeAgentProfile();
  const starterBefore = JSON.stringify(profile);
  const jobs = new JobStore(store.db);
  const create = (commentId: number): number => {
    const result = jobs.createJob({
      repoId,
      prNumber: 1,
      commentId,
      command: "RESOLVE",
      authorLogin: "fixture",
      observedAt: "2026-01-01T00:00:00Z",
    });
    assert.equal(result.kind, "created");
    if (result.kind !== "created") throw new Error("duplicate fixture");
    return result.jobId;
  };
  const post = (path: string, payload: unknown) =>
    app.inject({ method: "POST", url: `/repos/${String(repoId)}/${path}`, headers, payload });
  try {
    const oldDefault = create(9001);
    const saved = await post("opencode-profile", { expectedRevision: 0, candidate: profile });
    assert.equal(saved.statusCode, 200, saved.body);
    assert.equal(readOpenCodeSelection(store.db, repoId)?.selection.source, "default");
    const inactivePage = await app.inject({ method: "GET", url: "/", headers });
    assert.match(inactivePage.body, /Saved team: INACTIVE/u);
    assert.match(inactivePage.body, /Enabled in saved team/u);
    const savedBytes = JSON.stringify(readOpenCodeProfile(store.db, repoId)?.profile);
    const activate = await post("opencode-team-activation", {
      mode: "activate-saved",
      expectedProfileRevision: 1,
      expectedSelectionRevision: 0,
    });
    assert.equal(activate.statusCode, 200, activate.body);
    assert.equal(activate.json<{ active: boolean }>().active, true);
    assert.equal(readOpenCodeSelection(store.db, repoId)?.selection.source, "managed");
    assert.equal(JSON.stringify(readOpenCodeProfile(store.db, repoId)?.profile), savedBytes);
    assert.equal(readOpenCodeProfile(store.db, repoId)?.revision, 1);
    const activePage = await app.inject({ method: "GET", url: "/", headers });
    assert.match(activePage.body, /Team: ACTIVE FOR NEW JOBS/u);
    assert.match(activePage.body, /Available to orchestrator/u);
    const oldManaged = create(9002);
    const frozenManaged = jobs.getJob(oldManaged).opencode_profile_json;
    const firstAttempt = jobs.createAttempt({
      jobId: oldManaged,
      agent: "opencode",
      model: "opencode/gpt-5.4",
      provider: "",
      effort: "high",
    });
    jobs.setStatus(oldManaged, "failed", firstAttempt.attemptId);

    const switched = await post("opencode-selection", {
      expectedRevision: 1,
      selection: { source: "default" },
    });
    assert.equal(switched.statusCode, 200, switched.body);
    assert.equal(JSON.stringify(readOpenCodeProfile(store.db, repoId)?.profile), savedBytes);
    const switchedPage = await app.inject({ method: "GET", url: "/", headers });
    assert.match(switchedPage.body, /Saved team: INACTIVE/u);
    assert.match(switchedPage.body, /Enabled in saved team/u);
    // Fixture-only native configuration: no provider, inventory subprocess or GitHub call.
    const native = saveOpenCodeSelection(store.db, {
      repoId,
      expectedRevision: 2,
      candidate: { source: "native", agentId: "fixture-native" },
    });
    assert.equal(native.ok, true);
    const oldNative = create(9004);
    const backToDefault = await post("opencode-selection", {
      expectedRevision: 3,
      selection: { source: "default" },
    });
    assert.equal(backToDefault.statusCode, 200, backToDefault.body);

    const changed = structuredClone(profile);
    changed.primary.description = "Reviewed offline updated team";
    const auditCount = (): number =>
      (
        store.db.prepare("SELECT COUNT(*) AS count FROM operator_actions").get() as {
          count: number;
        }
      ).count;
    const auditsBeforeConflict = auditCount();
    const stale = await post("opencode-team-activation", {
      mode: "save-and-activate",
      expectedProfileRevision: 1,
      expectedSelectionRevision: 3,
      profile: changed,
    });
    assert.equal(stale.statusCode, 409, stale.body);
    assert.equal(auditCount(), auditsBeforeConflict);
    assert.equal(JSON.stringify(readOpenCodeProfile(store.db, repoId)?.profile), savedBytes);
    const countBeforeActivation = notifications.length;
    refreshFails = true;
    const combined = await post("opencode-team-activation", {
      mode: "save-and-activate",
      expectedProfileRevision: 1,
      expectedSelectionRevision: 4,
      profile: changed,
    });
    assert.equal(combined.statusCode, 200, combined.body);
    assert.equal(combined.json<{ active: boolean }>().active, true);
    assert.equal(combined.json<{ notification: string }>().notification, "failed");
    assert.equal(combined.json<{ refreshError: string }>().refreshError, "notification-failed");
    assert.equal(auditCount(), auditsBeforeConflict + 1);
    const auditDetail = JSON.stringify(
      store.db.prepare("SELECT detail FROM operator_actions ORDER BY id DESC LIMIT 1").get(),
    );
    assert.ok(!auditDetail.includes(changed.primary.description));
    assert.equal(notifications.length, countBeforeActivation + 1);
    assert.ok(notifications.every((id) => id === repoId));
    assert.equal(readOpenCodeProfile(store.db, repoId)?.revision, 2);
    assert.equal(readOpenCodeSelection(store.db, repoId)?.selection.source, "managed");
    const current = create(9003);
    assert.equal(jobs.getJob(current).opencode_profile_revision, 2);
    assert.equal(jobs.getJob(oldDefault).opencode_source, "default");
    assert.equal(jobs.getJob(oldDefault).opencode_profile_json, null);
    assert.equal(jobs.getJob(oldManaged).opencode_profile_json, frozenManaged);
    assert.equal(JSON.stringify(defaultOpenCodeAgentProfile()), starterBefore);

    // Reopen the durable store: retry resolves the original capture, not current settings.
    app.endLiveUpdateStreams();
    await app.close();
    store.close();
    store = new Store({ dataDir: dir, file });
    const restarted = new JobStore(store.db);
    assert.deepEqual(restarted.resolveCapturedSelection(oldDefault), { source: "default" });
    assert.deepEqual(restarted.resolveCapturedSelection(oldManaged), {
      source: "managed",
      profileRevision: 1,
    });
    assert.equal(restarted.getJob(oldManaged).opencode_profile_json, frozenManaged);
    const retry = restarted.retryJob({
      jobId: oldManaged,
      agent: "opencode",
      model: "opencode/gpt-5.4",
      provider: "",
      effort: "high",
    });
    assert.equal(retry.attemptNumber, 2);
    assert.equal(restarted.getJob(oldManaged).status, "queued");
    assert.equal(restarted.getJob(oldManaged).opencode_profile_json, frozenManaged);
    assert.equal(restarted.getJob(oldManaged).opencode_profile_revision, 1);
    assert.equal(restarted.getJob(current).opencode_profile_revision, 2);
    assert.deepEqual(restarted.resolveCapturedSelection(oldNative), {
      source: "native",
      agentId: "fixture-native",
    });
    assert.equal(restarted.getJob(oldNative).opencode_profile_json, null);
    assert.equal(readOpenCodeSelection(store.db, repoId)?.selection.source, "managed");
  } finally {
    app.endLiveUpdateStreams();
    await app.close();
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
