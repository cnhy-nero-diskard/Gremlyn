/**
 * Focused tests for the recursive descendant walk in
 * `src/agent/managed-sessions.ts` (OpenSpec `select-native-opencode-agent`
 * task 4.1, and the session-module portions of 4.2/4.3; design D4).
 *
 * The flat session tests live in `managed-sessions.test.ts`; this file proves
 * the *nested* behaviour those fixtures deliberately do not model:
 *
 * - the whole descendant tree is walked, breadth first, with every edge
 *   echoing its parent and living in the attempt workspace;
 * - still-running nested descendants (and a running ancestor that spawns a
 *   late nested child) block quiescence and are interrupted;
 * - wrong-parent, wrong-directory, cycle, duplicate, depth-cap and node-cap
 *   conditions fail closed;
 * - records are retained across a glitched round and a vanished/moved
 *   descendant fails closed;
 * - a hung injected transport is bounded per call;
 * - interruption never touches a session the attempt did not attribute.
 *
 * The fake transport speaks the same two pinned first-class facts as the real
 * one: a session record carries `parentID`, and `GET /api/session` filters by
 * `parentID`, so the walk can only ever trust an echoed parent edge.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  OPENCODE_SESSION_TREE_DEPTH_LIMIT,
  OPENCODE_SESSION_TREE_NODE_LIMIT,
  OpenCodeSessionDiscoveryError,
  OpenCodeSessionSettleError,
  discoverAttemptChildSessions,
  settleAttemptChildren,
  sessionActivePath,
  sessionListPath,
  sessionRecordPath,
  type ManagedHttpResult,
  type ManagedSessionHttp,
  type OpenCodeSessionOutcome,
} from "../src/agent/managed-sessions.js";

const CWD = "C:\\attempts\\att-recursive";
const PARENT = "ses_parent";

/* ------------------------------------------------------------------ *
 * Scripted fake server + fake clock
 * ------------------------------------------------------------------ */

type Scripted = ManagedHttpResult | "glitch" | "throw";

function result200(body: unknown): ManagedHttpResult {
  return { status: 200, body };
}

function sessionRecord(
  id: string,
  opts: { parentID?: string | null; outcome?: OpenCodeSessionOutcome; directory?: string } = {},
): Record<string, unknown> {
  const { parentID = PARENT, outcome, directory = CWD } = opts;
  const record: Record<string, unknown> = {
    id,
    projectID: "proj",
    cost: 0,
    tokens: { input: 0, output: 0 },
    time: { created: 1, updated: 2 },
    location: { directory },
  };
  if (parentID !== null && parentID !== undefined) record.parentID = parentID;
  if (outcome !== undefined) record.outcome = outcome;
  return record;
}

function sessionEnvelope(
  id: string,
  opts?: Parameters<typeof sessionRecord>[1],
): ManagedHttpResult {
  return result200({ data: sessionRecord(id, opts) });
}

function parentEnvelope(
  outcome: OpenCodeSessionOutcome | undefined = "succeeded",
): ManagedHttpResult {
  return sessionEnvelope(PARENT, {
    parentID: null,
    ...(outcome === undefined ? {} : { outcome }),
  });
}

function listEnvelope(records: readonly unknown[], nextCursor?: string): ManagedHttpResult {
  return result200({ data: records, cursor: { previous: null, next: nextCursor ?? null } });
}

function activeEnvelope(ids: readonly string[]): ManagedHttpResult {
  const data: Record<string, unknown> = {};
  for (const id of ids) data[id] = { type: "running" };
  return result200({ data });
}

interface Script {
  session?(id: string): Scripted;
  list?(query: Record<string, string>): Scripted;
  children?(parentId: string, query: Record<string, string>): Scripted;
  active?(): Scripted;
  interrupt?(id: string): Scripted;
}

interface FakeServer {
  readonly http: ManagedSessionHttp;
  readonly calls: Array<{
    readonly method: "GET" | "POST";
    readonly path: string;
    readonly query?: Record<string, string>;
  }>;
}

function makeServer(script: Partial<Script> = {}): FakeServer {
  const calls: FakeServer["calls"] = [];
  const resolve = async (
    value: Scripted | undefined,
    fallback: ManagedHttpResult,
  ): Promise<ManagedHttpResult> => {
    const scripted = value ?? fallback;
    if (scripted === "throw") throw new Error("transport failure");
    if (scripted === "glitch") return { status: 500, body: {} };
    return scripted;
  };
  const http: ManagedSessionHttp = {
    async get(path, query) {
      calls.push({ method: "GET", path, ...(query === undefined ? {} : { query: { ...query } }) });
      if (path === sessionActivePath()) return resolve(script.active?.(), activeEnvelope([]));
      if (path === sessionListPath()) {
        const q = query ?? {};
        if (q.parentID !== undefined && q.parentID !== PARENT) {
          return resolve(script.children?.(q.parentID, q), listEnvelope([]));
        }
        return resolve(script.list?.(q), listEnvelope([]));
      }
      const id = decodeURIComponent(path.slice(sessionRecordPath("").length));
      return resolve(script.session?.(id), { status: 404, body: {} });
    },
    async post(path) {
      calls.push({ method: "POST", path });
      const id = decodeURIComponent(
        path.slice(0, -"/interrupt".length).slice(sessionRecordPath("").length),
      );
      return resolve(script.interrupt?.(id), result200({ interrupted: true }));
    },
  };
  return { http, calls };
}

function fakeClock(): {
  now: () => number;
  sleep: (ms: number) => Promise<void>;
  slept: () => number;
} {
  let t = 0;
  let sleeps = 0;
  return {
    now: () => t,
    sleep: async (ms) => {
      sleeps += 1;
      t += ms;
    },
    slept: () => sleeps,
  };
}

function posts(server: FakeServer): string[] {
  return server.calls.filter((call) => call.method === "POST").map((call) => call.path);
}

function resolveParent(
  getChildren: (parentId: string) => readonly string[],
  id: string,
): string | undefined {
  if (id === PARENT) return undefined;
  const queue = [PARENT];
  while (queue.length > 0) {
    const parentId = queue.shift()!;
    for (const child of getChildren(parentId)) {
      if (child === id) return parentId;
      queue.push(child);
    }
  }
  return undefined;
}

/**
 * A fake server backed by a live parent-keyed tree. `getChildren` is re-read on
 * every call so tests can spawn descendants between rounds; every direct record
 * echoes the parent it was listed under.
 */
function makeTreeServer(opts: {
  readonly getChildren: (parentId: string) => readonly string[];
  readonly outcomeOf: (id: string) => OpenCodeSessionOutcome | undefined;
  readonly directoryOf?: (id: string) => string;
  readonly parentOutcome?: () => OpenCodeSessionOutcome | undefined;
  readonly runningIds?: () => readonly string[];
  readonly onInterrupt?: (id: string) => void;
}): FakeServer {
  const directoryOf = opts.directoryOf ?? (() => CWD);
  const parentOutcome = opts.parentOutcome ?? (() => "succeeded");
  const recordFor = (id: string, parentID: string): Record<string, unknown> => {
    const outcome = opts.outcomeOf(id);
    return sessionRecord(id, {
      parentID,
      ...(outcome === undefined ? {} : { outcome }),
      directory: directoryOf(id),
    });
  };
  return makeServer({
    session: (id) => {
      if (id === PARENT) {
        const outcome = parentOutcome();
        return sessionEnvelope(PARENT, {
          parentID: null,
          ...(outcome === undefined ? {} : { outcome }),
        });
      }
      const parentID = resolveParent(opts.getChildren, id);
      if (parentID === undefined) return { status: 404, body: {} };
      const outcome = opts.outcomeOf(id);
      return sessionEnvelope(id, {
        parentID,
        ...(outcome === undefined ? {} : { outcome }),
        directory: directoryOf(id),
      });
    },
    list: () => listEnvelope(opts.getChildren(PARENT).map((id) => recordFor(id, PARENT))),
    children: (parentId) =>
      listEnvelope(opts.getChildren(parentId).map((id) => recordFor(id, parentId))),
    active: () => activeEnvelope(opts.runningIds?.() ?? []),
    interrupt: (id) => {
      opts.onInterrupt?.(id);
      return result200({ interrupted: true });
    },
  });
}

/* ------------------------------------------------------------------ *
 * Bounds
 * ------------------------------------------------------------------ */

test("the recursive bounds are the designed caps", () => {
  assert.equal(OPENCODE_SESSION_TREE_DEPTH_LIMIT, 16);
  assert.equal(OPENCODE_SESSION_TREE_NODE_LIMIT, 1024);
});

/* ------------------------------------------------------------------ *
 * Recursive discovery and settlement
 * ------------------------------------------------------------------ */

test("discovery walks nested descendants in breadth-first order with their parents", async () => {
  const tree = {
    [PARENT]: ["ses_child"],
    ses_child: ["ses_grand_a", "ses_grand_b"],
    ses_grand_a: ["ses_great"],
  };
  const server = makeTreeServer({
    getChildren: (parentId) => tree[parentId as keyof typeof tree] ?? [],
    outcomeOf: () => "succeeded",
  });
  const result = await discoverAttemptChildSessions({
    parentSessionId: PARENT,
    attemptDirectory: CWD,
    http: server.http,
    timeoutMs: 10_000,
  });
  assert.deepEqual(
    result.children.map((child) => child.id),
    ["ses_child", "ses_grand_a", "ses_grand_b", "ses_great"],
  );
  assert.equal(result.children.find((c) => c.id === "ses_grand_a")?.parentID, "ses_child");
  assert.equal(result.children.find((c) => c.id === "ses_great")?.parentID, "ses_grand_a");
});

test("settle returns nested descendants with their parent and depth", async () => {
  const tree = { [PARENT]: ["ses_child"], ses_child: ["ses_grand"] };
  const server = makeTreeServer({
    getChildren: (parentId) => tree[parentId as keyof typeof tree] ?? [],
    outcomeOf: () => "succeeded",
  });
  const settlement = await settleAttemptChildren({
    parentSessionId: PARENT,
    attemptDirectory: CWD,
    http: server.http,
    timeoutMs: 10_000,
  });
  assert.deepEqual(settlement.children, [
    { id: "ses_child", outcome: "succeeded", interrupted: false },
    {
      id: "ses_grand",
      outcome: "succeeded",
      interrupted: false,
      parentID: "ses_child",
      depth: 2,
    },
  ]);
});

test("a still-running nested descendant blocks quiescence and is interrupted", async () => {
  let grandInterrupted = false;
  const server = makeServer({
    session: (id) =>
      id === PARENT
        ? parentEnvelope()
        : sessionEnvelope(id, {
            parentID: id === "ses_child" ? PARENT : "ses_child",
            outcome:
              id === "ses_grand" ? (grandInterrupted ? "interrupted" : undefined) : "succeeded",
          }),
    list: () => listEnvelope([sessionRecord("ses_child", { outcome: "succeeded" })]),
    children: (parentId) =>
      parentId === "ses_child"
        ? listEnvelope([
            sessionRecord("ses_grand", {
              parentID: "ses_child",
              outcome: grandInterrupted ? "interrupted" : undefined,
            }),
          ])
        : listEnvelope([]),
    active: () => activeEnvelope(grandInterrupted ? [] : ["ses_grand"]),
    interrupt: (id) => {
      assert.equal(id, "ses_grand");
      grandInterrupted = true;
      return result200({ interrupted: true });
    },
  });
  const { now, sleep } = fakeClock();
  const settlement = await settleAttemptChildren({
    parentSessionId: PARENT,
    attemptDirectory: CWD,
    http: server.http,
    timeoutMs: 25,
    pollIntervalMs: 10,
    interruptGraceMs: 1_000,
    now,
    sleep,
  });
  assert.deepEqual(settlement.interruptedSessionIds, ["ses_grand"]);
  const grand = settlement.children.find((child) => child.id === "ses_grand");
  assert.equal(grand?.outcome, "interrupted");
  assert.equal(grand?.parentID, "ses_child");
  assert.equal(grand?.depth, 2);
});

test("a running ancestor that spawns a late nested child has it adopted and settled", async () => {
  let spawned = false;
  let parentDone = false;
  let childDone = false;
  let grandDone = false;
  const childrenOf = (parentId: string): readonly string[] => {
    if (parentId === PARENT) return spawned ? ["ses_child"] : [];
    if (parentId === "ses_child") return ["ses_grand"];
    return [];
  };
  const outcomeOf = (id: string): OpenCodeSessionOutcome | undefined => {
    if (id === "ses_child") return childDone ? "interrupted" : undefined;
    if (id === "ses_grand") return grandDone ? "interrupted" : undefined;
    return "succeeded";
  };
  const server = makeTreeServer({
    getChildren: childrenOf,
    outcomeOf,
    parentOutcome: () => (parentDone ? "interrupted" : undefined),
    runningIds: () => [
      ...(parentDone ? [] : [PARENT]),
      ...(spawned && !childDone ? ["ses_child"] : []),
      ...(spawned && !grandDone ? ["ses_grand"] : []),
    ],
    onInterrupt: (id) => {
      if (id === PARENT) parentDone = true;
      if (id === "ses_child") childDone = true;
      if (id === "ses_grand") grandDone = true;
    },
  });
  const { now, sleep } = fakeClock();
  const settlement = await settleAttemptChildren({
    parentSessionId: PARENT,
    attemptDirectory: CWD,
    http: server.http,
    timeoutMs: 30,
    pollIntervalMs: 10,
    interruptGraceMs: 1_000,
    now,
    sleep: async (ms) => {
      await sleep(ms);
      // The ancestor stays running for a round, then spawns its subtree.
      if (spawned === false) spawned = true;
    },
  });
  assert.deepEqual(
    settlement.children.map((child) => child.id),
    ["ses_child", "ses_grand"],
  );
  assert.equal(settlement.children.find((c) => c.id === "ses_grand")?.parentID, "ses_child");
  for (const id of ["ses_child", "ses_grand", PARENT]) {
    assert.ok(settlement.interruptedSessionIds.includes(id), `${id} must be interrupted`);
  }
});

test("a descendant spawned around the listing is adopted, never returned as a clean tree", async () => {
  // Discovery admits ses_child. During settlement the parent is still running
  // and creates a second child right after a listing that omits it, then turns
  // terminal. Because the parent record is read BEFORE the authoritative listing
  // (the fix), the round that proves the parent terminal can never be the same
  // listing that missed ses_late: the child appears in a later full listing and
  // is settled. Reading the listing first would return clean with only ses_child.
  let listCalls = 0;
  let parentDone = false;
  const late = "ses_late";
  const server = makeServer({
    // `parentEnvelope` defaults an explicit `undefined` back to "succeeded", so
    // build the still-running parent record directly.
    session: (id) =>
      id === PARENT
        ? parentDone
          ? parentEnvelope("succeeded")
          : sessionEnvelope(PARENT, { parentID: null })
        : sessionEnvelope(id, { parentID: PARENT, outcome: "succeeded" }),
    list: () => {
      listCalls += 1;
      if (listCalls === 1) {
        return listEnvelope([sessionRecord("ses_child", { outcome: "succeeded" })]);
      }
      if (listCalls === 2) {
        // The second child spawns and the parent settles right after this
        // listing, so the parent is terminal by the time it is next read.
        parentDone = true;
        return listEnvelope([sessionRecord("ses_child", { outcome: "succeeded" })]);
      }
      return listEnvelope([
        sessionRecord("ses_child", { outcome: "succeeded" }),
        sessionRecord(late, { outcome: "succeeded" }),
      ]);
    },
    active: () => activeEnvelope(parentDone ? [] : [PARENT]),
  });
  const { now, sleep } = fakeClock();
  const settlement = await settleAttemptChildren({
    parentSessionId: PARENT,
    attemptDirectory: CWD,
    http: server.http,
    timeoutMs: 1_000_000,
    pollIntervalMs: 10,
    now,
    sleep,
  });
  assert.deepEqual(
    settlement.children.map((child) => child.id),
    ["ses_child", late],
    "the descendant spawned after the listing must be adopted, not omitted",
  );
});

test("a descendant spawned after its own listing blocks settlement until it terminates", async () => {
  let aChildListings = 0;
  let bSpawned = false;
  let aDone = false;
  let bDone = false;
  let sleeps = 0;
  let activeSawB = false;
  const server = makeServer({
    session: (id) => {
      if (id === PARENT) return parentEnvelope();
      if (id === "ses_a") {
        // The higher-level listing below can be stale: the direct record read
        // immediately before A's child listing still says A is running.
        return sessionEnvelope("ses_a", {
          parentID: PARENT,
          ...(aDone ? { outcome: "succeeded" as const } : {}),
        });
      }
      if (id === "ses_b" && bSpawned) {
        return sessionEnvelope("ses_b", {
          parentID: "ses_a",
          ...(bDone ? { outcome: "succeeded" as const } : {}),
        });
      }
      return { status: 404, body: {} };
    },
    // The root's listed row may already look terminal, while A's own direct
    // record still reports it running. Its child listing is not safe to trust.
    list: () => listEnvelope([sessionRecord("ses_a", { outcome: "succeeded" })]),
    children: (parentId) => {
      if (parentId !== "ses_a") return listEnvelope([]);
      aChildListings += 1;
      if (aChildListings === 1) return listEnvelope([]); // Initial discovery.
      if (aChildListings === 2) {
        // A creates B and finishes immediately after its child listing. The
        // active-map read that follows sees B, but not A.
        bSpawned = true;
        aDone = true;
        return listEnvelope([]);
      }
      return listEnvelope([
        sessionRecord("ses_b", {
          parentID: "ses_a",
          ...(bDone ? { outcome: "succeeded" as const } : {}),
        }),
      ]);
    },
    active: () => {
      if (bSpawned && !bDone) activeSawB = true;
      return activeEnvelope(bSpawned && !bDone ? ["ses_b"] : []);
    },
  });
  const { now, sleep } = fakeClock();
  const settlement = await settleAttemptChildren({
    parentSessionId: PARENT,
    attemptDirectory: CWD,
    http: server.http,
    timeoutMs: 1_000_000,
    pollIntervalMs: 10,
    now,
    sleep: async (ms) => {
      await sleep(ms);
      sleeps += 1;
      if (sleeps >= 2) bDone = true;
    },
  });

  assert.equal(
    activeSawB,
    true,
    "B must be active after A's listing and before settlement can return",
  );
  assert.equal(bDone, true, "settlement must wait for B's terminal outcome");
  assert.deepEqual(
    settlement.children.map((child) => child.id),
    ["ses_a", "ses_b"],
  );
  assert.equal(settlement.children.find((child) => child.id === "ses_b")?.outcome, "succeeded");
});

/* ------------------------------------------------------------------ *
 * Fail-closed edges
 * ------------------------------------------------------------------ */

test("a cycle in the descendant tree fails closed", async () => {
  const server = makeServer({
    session: () => parentEnvelope(),
    list: () => listEnvelope([sessionRecord("ses_a", { outcome: "succeeded" })]),
    children: (parentId) =>
      parentId === "ses_a"
        ? listEnvelope([sessionRecord(PARENT, { parentID: "ses_a" })])
        : listEnvelope([]),
  });
  await assert.rejects(
    () =>
      discoverAttemptChildSessions({
        parentSessionId: PARENT,
        attemptDirectory: CWD,
        http: server.http,
        timeoutMs: 10_000,
      }),
    (error: unknown) => {
      assert.ok(error instanceof OpenCodeSessionDiscoveryError);
      assert.ok(error.message.includes("cycle or duplicate"));
      return true;
    },
  );
});

test("a duplicate descendant id fails closed", async () => {
  const server = makeServer({
    session: () => parentEnvelope(),
    list: () =>
      listEnvelope([
        sessionRecord("ses_dup", { outcome: "succeeded" }),
        sessionRecord("ses_dup", { outcome: "succeeded" }),
      ]),
  });
  await assert.rejects(
    () =>
      discoverAttemptChildSessions({
        parentSessionId: PARENT,
        attemptDirectory: CWD,
        http: server.http,
        timeoutMs: 10_000,
      }),
    (error: unknown) => {
      assert.ok(error instanceof OpenCodeSessionDiscoveryError);
      assert.ok(error.message.includes("cycle or duplicate"));
      return true;
    },
  );
});

test("a nested record that does not echo its parent fails closed", async () => {
  const server = makeServer({
    session: () => parentEnvelope(),
    list: () => listEnvelope([sessionRecord("ses_a", { outcome: "succeeded" })]),
    children: (parentId) =>
      parentId === "ses_a"
        ? listEnvelope([sessionRecord("ses_orphan", { parentID: "ses_other" })])
        : listEnvelope([]),
  });
  await assert.rejects(
    () =>
      discoverAttemptChildSessions({
        parentSessionId: PARENT,
        attemptDirectory: CWD,
        http: server.http,
        timeoutMs: 10_000,
      }),
    (error: unknown) => {
      assert.ok(error instanceof OpenCodeSessionDiscoveryError);
      assert.ok(error.message.includes("ses_orphan"));
      assert.ok(error.message.includes("cannot be trusted"));
      return true;
    },
  );
});

test("a nested record in another workspace fails closed", async () => {
  const server = makeServer({
    session: () => parentEnvelope(),
    list: () => listEnvelope([sessionRecord("ses_a", { outcome: "succeeded" })]),
    children: (parentId) =>
      parentId === "ses_a"
        ? listEnvelope([
            sessionRecord("ses_elsewhere", { parentID: "ses_a", directory: "C:\\other\\repo" }),
          ])
        : listEnvelope([]),
  });
  await assert.rejects(
    () =>
      discoverAttemptChildSessions({
        parentSessionId: PARENT,
        attemptDirectory: CWD,
        http: server.http,
        timeoutMs: 10_000,
      }),
    (error: unknown) => {
      assert.ok(error instanceof OpenCodeSessionDiscoveryError);
      assert.ok(error.message.includes("another run's child"));
      return true;
    },
  );
});

test("a previously seen child echoed by its own listing fails closed without interrupting", async () => {
  // Discovery's nested listing is empty; the first observation round then
  // returns ses_child again for parentID=ses_child (a filter-ignoring echo).
  // Even though the id was already attributed with an unchanged recorded
  // parent, the edge proof must reject it — a service ignoring the filter can
  // hide a native descendant.
  let childListCalls = 0;
  const server = makeServer({
    session: (id) =>
      id === PARENT
        ? parentEnvelope()
        : sessionEnvelope(id, { parentID: PARENT, outcome: "succeeded" }),
    list: () => listEnvelope([sessionRecord("ses_child", { outcome: "succeeded" })]),
    children: (parentId) => {
      if (parentId !== "ses_child") return listEnvelope([]);
      childListCalls += 1;
      return childListCalls === 1
        ? listEnvelope([])
        : listEnvelope([sessionRecord("ses_child", { outcome: "succeeded" })]);
    },
    active: () => activeEnvelope(["ses_zzz_unrelated"]),
  });
  const { now, sleep } = fakeClock();
  await assert.rejects(
    () =>
      settleAttemptChildren({
        parentSessionId: PARENT,
        attemptDirectory: CWD,
        http: server.http,
        timeoutMs: 1_000_000,
        now,
        sleep,
      }),
    (error: unknown) => {
      assert.ok(error instanceof OpenCodeSessionDiscoveryError);
      assert.ok(error.message.includes("cannot be trusted"));
      return true;
    },
  );
  assert.deepEqual(posts(server), [], "a failed edge proof must interrupt nothing");
});

test("a previously seen nested child echoed by a different listing fails closed", async () => {
  let listCalls = 0;
  const server = makeServer({
    session: () => parentEnvelope(),
    list: () => {
      listCalls += 1;
      // Discovery sees ses_child; the observation round also returns the known
      // nested child ses_grand under the root (its recorded parent is
      // ses_child) — a different listing that cannot be trusted.
      return listCalls === 1
        ? listEnvelope([sessionRecord("ses_child", { outcome: "succeeded" })])
        : listEnvelope([
            sessionRecord("ses_child", { outcome: "succeeded" }),
            sessionRecord("ses_grand", { parentID: "ses_child", outcome: "succeeded" }),
          ]);
    },
    children: (parentId) =>
      parentId === "ses_child"
        ? listEnvelope([
            sessionRecord("ses_grand", { parentID: "ses_child", outcome: "succeeded" }),
          ])
        : listEnvelope([]),
    active: () => activeEnvelope(["ses_zzz_unrelated"]),
  });
  const { now, sleep } = fakeClock();
  await assert.rejects(
    () =>
      settleAttemptChildren({
        parentSessionId: PARENT,
        attemptDirectory: CWD,
        http: server.http,
        timeoutMs: 1_000_000,
        now,
        sleep,
      }),
    (error: unknown) => {
      assert.ok(error instanceof OpenCodeSessionDiscoveryError);
      assert.ok(error.message.includes("cannot be trusted"));
      return true;
    },
  );
  assert.deepEqual(posts(server), [], "a failed edge proof must interrupt nothing");
});

test("the depth cap fails closed instead of truncating the tree", async () => {
  const tree: Record<string, readonly string[]> = { [PARENT]: ["ses_d1"] };
  for (let level = 1; level < 17; level += 1) {
    tree[`ses_d${level}`] = [`ses_d${level + 1}`];
  }
  const server = makeTreeServer({
    getChildren: (parentId) => tree[parentId] ?? [],
    outcomeOf: () => "succeeded",
  });
  await assert.rejects(
    () =>
      discoverAttemptChildSessions({
        parentSessionId: PARENT,
        attemptDirectory: CWD,
        http: server.http,
        timeoutMs: 10_000,
      }),
    (error: unknown) => {
      assert.ok(error instanceof OpenCodeSessionDiscoveryError);
      assert.ok(error.message.includes(String(OPENCODE_SESSION_TREE_DEPTH_LIMIT)));
      assert.ok(error.message.includes("levels"));
      return true;
    },
  );
});

test("the node cap fails closed instead of truncating the tree", async () => {
  const ids = Array.from({ length: OPENCODE_SESSION_TREE_NODE_LIMIT + 1 }, (_, i) => `ses_n${i}`);
  const server = makeServer({
    session: () => parentEnvelope(),
    list: () => listEnvelope(ids.map((id) => sessionRecord(id, { outcome: "succeeded" }))),
  });
  await assert.rejects(
    () =>
      discoverAttemptChildSessions({
        parentSessionId: PARENT,
        attemptDirectory: CWD,
        http: server.http,
        timeoutMs: 10_000,
      }),
    (error: unknown) => {
      assert.ok(error instanceof OpenCodeSessionDiscoveryError);
      assert.ok(error.message.includes(String(OPENCODE_SESSION_TREE_NODE_LIMIT)));
      assert.ok(error.message.includes("nodes"));
      return true;
    },
  );
});

/* ------------------------------------------------------------------ *
 * Freshness, retention and races
 * ------------------------------------------------------------------ */

test("a glitched round retains known nested descendants and later proves quiescence", async () => {
  let childListCalls = 0;
  const server = makeServer({
    session: (id) =>
      id === PARENT
        ? parentEnvelope()
        : sessionEnvelope(id, {
            parentID: id === "ses_child" ? PARENT : "ses_child",
            outcome: "succeeded",
          }),
    list: () => listEnvelope([sessionRecord("ses_child", { outcome: "succeeded" })]),
    children: (parentId) => {
      if (parentId !== "ses_child") return listEnvelope([]);
      childListCalls += 1;
      // Discovery (call 1) and the second round (call 3) are complete; the first
      // observation round (call 2) glitches and must fall back to per-node reads.
      if (childListCalls === 2) return { status: 500, body: {} };
      return listEnvelope([
        sessionRecord("ses_grand", { parentID: "ses_child", outcome: "succeeded" }),
      ]);
    },
  });
  const { now, sleep } = fakeClock();
  const settlement = await settleAttemptChildren({
    parentSessionId: PARENT,
    attemptDirectory: CWD,
    http: server.http,
    timeoutMs: 1_000_000,
    pollIntervalMs: 10,
    now,
    sleep,
  });
  assert.equal(settlement.rounds, 2, "the glitched round cannot authorize quiescence");
  assert.deepEqual(
    settlement.children.map((child) => child.id),
    ["ses_child", "ses_grand"],
  );
});

test("a nested descendant that vanishes from a later complete round fails closed", async () => {
  let childListCalls = 0;
  const server = makeServer({
    session: (id) =>
      id === PARENT
        ? parentEnvelope()
        : sessionEnvelope(id, {
            parentID: id === "ses_child" ? PARENT : "ses_child",
            outcome: "succeeded",
          }),
    list: () => listEnvelope([sessionRecord("ses_child", { outcome: "succeeded" })]),
    children: (parentId) => {
      if (parentId !== "ses_child") return listEnvelope([]);
      childListCalls += 1;
      return childListCalls === 1
        ? listEnvelope([
            sessionRecord("ses_grand", { parentID: "ses_child", outcome: "succeeded" }),
          ])
        : listEnvelope([]);
    },
  });
  const { now, sleep } = fakeClock();
  await assert.rejects(
    () =>
      settleAttemptChildren({
        parentSessionId: PARENT,
        attemptDirectory: CWD,
        http: server.http,
        timeoutMs: 1_000_000,
        now,
        sleep,
      }),
    (error: unknown) => {
      assert.ok(error instanceof OpenCodeSessionSettleError);
      assert.deepEqual(error.unknownSessionIds, ["ses_grand"]);
      assert.ok(error.message.includes("vanished"));
      return true;
    },
  );
});

test("a nested descendant that changes parent fails closed", async () => {
  let listCalls = 0;
  let childCalls = 0;
  const server = makeServer({
    session: (id) =>
      id === PARENT
        ? parentEnvelope()
        : sessionEnvelope(id, { parentID: PARENT, outcome: "succeeded" }),
    list: () => {
      listCalls += 1;
      // Discovery sees ses_child only; the observation round also returns
      // ses_grand directly under the root, contradicting its known parent.
      return listCalls === 1
        ? listEnvelope([sessionRecord("ses_child", { outcome: "succeeded" })])
        : listEnvelope([
            sessionRecord("ses_child", { outcome: "succeeded" }),
            sessionRecord("ses_grand", { parentID: PARENT, outcome: "succeeded" }),
          ]);
    },
    children: (parentId) => {
      if (parentId !== "ses_child") return listEnvelope([]);
      childCalls += 1;
      return childCalls === 1
        ? listEnvelope([
            sessionRecord("ses_grand", { parentID: "ses_child", outcome: "succeeded" }),
          ])
        : listEnvelope([]);
    },
  });
  const { now, sleep } = fakeClock();
  await assert.rejects(
    () =>
      settleAttemptChildren({
        parentSessionId: PARENT,
        attemptDirectory: CWD,
        http: server.http,
        timeoutMs: 1_000_000,
        now,
        sleep,
      }),
    (error: unknown) => {
      assert.ok(error instanceof OpenCodeSessionSettleError);
      assert.deepEqual(error.unknownSessionIds, ["ses_grand"]);
      assert.ok(error.message.includes("changed parent"));
      return true;
    },
  );
});

/* ------------------------------------------------------------------ *
 * Bounded transport and attribution
 * ------------------------------------------------------------------ */

test("a hung injected transport is bounded per call and fails closed", async () => {
  const hanging: ManagedSessionHttp = {
    get: () => new Promise(() => {}),
    post: () => new Promise(() => {}),
  };
  const { now, sleep } = fakeClock();
  const started = Date.now();
  await assert.rejects(
    () =>
      discoverAttemptChildSessions({
        parentSessionId: PARENT,
        attemptDirectory: CWD,
        http: hanging,
        timeoutMs: 50,
        pollIntervalMs: 10,
        perCallTimeoutMs: 5,
        now,
        sleep,
      }),
    (error: unknown) => {
      assert.ok(error instanceof OpenCodeSessionDiscoveryError);
      assert.ok(error.message.includes("remaining attempt timeout"));
      return true;
    },
  );
  // The bound is the fake-clock budget, not an unbounded wait on the transport.
  assert.ok(Date.now() - started < 5_000, "the hung transport must be bounded");
});

test("interruption never touches a session the attempt did not attribute", async () => {
  const interruptedIds: string[] = [];
  const childrenOf = (parentId: string): readonly string[] => {
    if (parentId === PARENT) return ["ses_child"];
    if (parentId === "ses_child") return ["ses_grand"];
    return [];
  };
  let grandDone = false;
  const server = makeTreeServer({
    getChildren: childrenOf,
    outcomeOf: (id) => (id === "ses_grand" && !grandDone ? undefined : "succeeded"),
    runningIds: () => [...(grandDone ? [] : ["ses_grand"]), "ses_zzz_unrelated"],
    onInterrupt: (id) => {
      interruptedIds.push(id);
      if (id === "ses_grand") grandDone = true;
    },
  });
  const { now, sleep } = fakeClock();
  const settlement = await settleAttemptChildren({
    parentSessionId: PARENT,
    attemptDirectory: CWD,
    http: server.http,
    timeoutMs: 25,
    pollIntervalMs: 10,
    interruptGraceMs: 1_000,
    now,
    sleep,
  });
  assert.deepEqual(interruptedIds, ["ses_grand"]);
  assert.equal(settlement.interruptedSessionIds.includes("ses_zzz_unrelated"), false);
  assert.deepEqual(
    settlement.children.map((child) => child.id),
    ["ses_child", "ses_grand"],
  );
  assert.deepEqual(posts(server), ["/api/session/ses_grand/interrupt"]);
});

test("a nested call is capped by the remaining budget, not the per-call maximum", async () => {
  // Discovery succeeds on the root listing, then every nested listing hangs. If
  // each nested call could spend the full per-call maximum, the walk would
  // outlive the whole attempt budget; the cap must instead track the remaining
  // deadline and fail closed promptly.
  const children = Array.from({ length: 40 }, (_, i) => `ses_c${i}`);
  const hanging = (): Promise<ManagedHttpResult> => new Promise(() => {});
  const http: ManagedSessionHttp = {
    get: (path, query) => {
      if (path === sessionActivePath()) return Promise.resolve(activeEnvelope([]));
      if (path === sessionListPath()) {
        const parentId = query?.parentID;
        if (parentId === PARENT) {
          return Promise.resolve(
            listEnvelope(
              children.map((id) => sessionRecord(id, { parentID: PARENT, outcome: "succeeded" })),
            ),
          );
        }
        return hanging();
      }
      if (path === sessionRecordPath(PARENT)) return Promise.resolve(parentEnvelope());
      return Promise.resolve({ status: 404, body: {} });
    },
    post: () => Promise.resolve(result200({ interrupted: true })),
  };
  const started = Date.now();
  await assert.rejects(
    () =>
      settleAttemptChildren({
        parentSessionId: PARENT,
        attemptDirectory: CWD,
        http,
        timeoutMs: 80,
        pollIntervalMs: 10,
        perCallTimeoutMs: 60_000, // far larger than the whole budget
        interruptGraceMs: 40,
      }),
    OpenCodeSessionDiscoveryError,
  );
  assert.ok(
    Date.now() - started < 5_000,
    "the nested call must be capped by the remaining budget, not the per-call maximum",
  );
});

test("cancellation switches to interruption without touching unrelated sessions", async () => {
  const interruptedIds: string[] = [];
  const childrenOf = (parentId: string): readonly string[] =>
    parentId === PARENT ? ["ses_child"] : [];
  let childDone = false;
  const server = makeTreeServer({
    getChildren: childrenOf,
    outcomeOf: (id) => (id === "ses_child" && !childDone ? undefined : "succeeded"),
    runningIds: () => [...(childDone ? [] : ["ses_child"]), "ses_zzz_unrelated"],
    onInterrupt: (id) => {
      interruptedIds.push(id);
      if (id === "ses_child") childDone = true;
    },
  });
  const controller = new AbortController();
  controller.abort();
  const settlement = await settleAttemptChildren({
    parentSessionId: PARENT,
    attemptDirectory: CWD,
    http: server.http,
    timeoutMs: 1_000_000,
    pollIntervalMs: 10,
    signal: controller.signal,
    now: fakeClock().now,
    sleep: async () => {},
  });
  // Observation reads abort promptly, the attributed child is interrupted (the
  // POST is never aborted), and the unrelated running session is left alone.
  assert.deepEqual(interruptedIds, ["ses_child"]);
  assert.deepEqual(settlement.interruptedSessionIds, ["ses_child"]);
  assert.equal(
    posts(server).includes("/api/session/ses_zzz_unrelated/interrupt"),
    false,
    "an unrelated running session must never be interrupted",
  );
});
