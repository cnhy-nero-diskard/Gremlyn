import assert from "node:assert/strict";
import { test } from "node:test";
import { resolve } from "node:path";
import {
  openCodeStreamParentId,
  readOpenCodeInitialIdentity,
} from "../src/agent/opencode-identity.js";
import type { ManagedSessionHttp } from "../src/agent/managed-sessions.js";

test("early parent evidence ignores nested tool content and malformed identifiers", () => {
  assert.equal(
    openCodeStreamParentId('{"type":"step_start","sessionID":"ses_parent"}'),
    "ses_parent",
  );
  for (const line of [
    "not json",
    '{"part":{"sessionID":"ses_other"}}',
    '{"sessionID":"ses_bad\\n"}',
    "null",
  ]) {
    assert.equal(openCodeStreamParentId(line), undefined);
  }
});

test("initial identity comes from first scoped assistant, never mutable current session agent or instructions", async () => {
  const cwd = resolve("identity-workspace");
  const calls: string[] = [];
  const http: ManagedSessionHttp = {
    async get(path, query) {
      calls.push(path);
      if (path.endsWith("/message")) {
        assert.deepEqual(query, { type: "assistant", order: "asc", limit: "1" });
        return {
          status: 200,
          body: {
            data: [
              {
                type: "assistant",
                agent: "native-reviewer",
                model: { providerID: "fixture", id: "model", variant: "high" },
                content: [{ text: "PRIVATE INSTRUCTIONS" }],
              },
            ],
            cursor: {},
          },
        };
      }
      return {
        status: 200,
        body: { data: { id: "ses_parent", agent: "later-agent", location: { directory: cwd } } },
      };
    },
    async post() {
      throw new Error("read-only identity");
    },
  };
  const identity = await readOpenCodeInitialIdentity({ http, cwd, parentSessionId: "ses_parent" });
  assert.deepEqual(identity, { agentId: "native-reviewer", model: "fixture/model#high" });
  assert.equal(calls.length, 2);
  assert.doesNotMatch(JSON.stringify(identity), /PRIVATE|later-agent|content/u);
});

test("wrong root/directory, missing messages, unreadable and hung APIs leave identity unknown", async () => {
  const cwd = resolve("identity-workspace");
  for (const data of [
    { id: "ses_other", location: { directory: cwd } },
    { id: "ses_parent", parentID: "ses_other", location: { directory: cwd } },
    { id: "ses_parent", location: { directory: resolve("another-workspace") } },
  ]) {
    const http: ManagedSessionHttp = {
      async get() {
        return { status: 200, body: { data } };
      },
      async post() {
        throw new Error();
      },
    };
    assert.deepEqual(
      await readOpenCodeInitialIdentity({ http, cwd, parentSessionId: "ses_parent" }),
      {},
    );
  }
  const http: ManagedSessionHttp = {
    get() {
      return new Promise(() => {});
    },
    async post() {
      throw new Error();
    },
  };
  assert.deepEqual(
    await readOpenCodeInitialIdentity({ http, cwd, parentSessionId: "ses_parent", timeoutMs: 5 }),
    {},
  );
});
