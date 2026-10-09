/**
 * Focused tests for task 3.5: tracking and settling an OpenCode attempt's
 * child sessions before validation and publication
 * (`src/agent/managed-sessions.ts`, design D4).
 *
 * The pinned surfaces asserted here were verified against the official
 * OpenCode 2.0.16 OpenAPI specification (matching the task-1.2 design probe):
 * `GET /api/session/{sessionID}` returns `{data: Session.Info}` with `outcome`
 * (`succeeded`/`failed`/`interrupted`, ABSENT while execution remains
 * unsettled), a `parentID`, and `location.directory`; `GET /api/session`
 * takes a `parentID` filter ("filter by parent session") plus `directory` and
 * pages through `cursor.next`; `GET /api/session/active` returns
 * `{data: {[ses…]: {type:"running"}}}` ("sessions absent from the result are
 * inactive"); `POST /api/session/{id}/interrupt` returns `{interrupted:
 * boolean}` and, per the probe, makes the interrupted child's outcome
 * `interrupted` and removes it from the active map.
 *
 * Discovery is deliberately conservative: a session is only ever a child when
 * the parentID-filtered listing returned it AND its own record echoes that
 * parentID AND its location is the attempt directory. The active map is never
 * an enumeration source. Every test here asserts that posture, plus the
 * bounded wait (remaining attempt timeout) and the fail-closed handling of
 * unknown/missing child state.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  OPENCODE_SESSION_CLI_TIMEOUT_MS,
  OPENCODE_SESSION_INTERRUPT_GRACE_MS,
  OPENCODE_SESSION_LIST_PAGE_LIMIT,
  OPENCODE_SESSION_POLL_INTERVAL_MS,
  OpenCodeSessionCliError,
  OpenCodeSessionDiscoveryError,
  OpenCodeSessionSettleError,
  classifyChildSession,
  cliSessionRequestPath,
  createCliManagedSessionHttp,
  discoverAttemptChildSessions,
  parseActiveSessions,
  parseCliHttpStatus,
  parseInterruptResponse,
  parseSessionListing,
  parseSessionRecord,
  sessionActivePath,
  sessionChildListQuery,
  sessionInterruptPath,
  sessionListPath,
  sessionRecordPath,
  settleAttemptChildren,
  type ManagedHttpResult,
  type ManagedSessionHttp,
  type OpenCodeSessionOutcome,
} from "../src/agent/managed-sessions.js";
import type { ProcessResult, ProcessRunner } from "../src/agent/launcher.js";

const CWD = "C:\\attempts\\att-1";
const PARENT = "ses_parent";
const CHILD = "ses_child";

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

/**
 * The attempt's own root parent record: no `parentID` (a root session is never
 * a child) and, by default, a terminal outcome — the shape `readAttemptParent`
 * and the settlement require before the attempt is quiescent. Pass
 * `{ outcome: undefined }` to script a parent that is still settling.
 */
function parentEnvelope(
  opts: { readonly outcome?: OpenCodeSessionOutcome; readonly directory?: string } = {},
): ManagedHttpResult {
  if ("outcome" in opts) {
    return sessionEnvelope(PARENT, {
      parentID: null,
      ...(opts.outcome === undefined ? {} : { outcome: opts.outcome }),
      ...(opts.directory === undefined ? {} : { directory: opts.directory }),
    });
  }
  return sessionEnvelope(PARENT, {
    parentID: null,
    outcome: "succeeded",
    ...(opts.directory === undefined ? {} : { directory: opts.directory }),
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
  /**
   * Direct listing for a NESTED parent (parentID other than {@link PARENT}).
   * Omitted means "no grandchildren", which keeps the original flat fixtures
   * behaving exactly as before the descendant walk existed.
   */
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

/** The POSTed interrupt targets in order, for call assertions. */
function posts(server: FakeServer): string[] {
  return server.calls.filter((call) => call.method === "POST").map((call) => call.path);
}

function hasGet(server: FakeServer, path: string): boolean {
  return server.calls.some((call) => call.method === "GET" && call.path === path);
}

function listQueries(server: FakeServer): Array<Record<string, string>> {
  return server.calls
    .filter(
      (call) =>
        call.method === "GET" && call.path === sessionListPath() && call.query !== undefined,
    )
    .map((call) => call.query!);
}

/* ------------------------------------------------------------------ *
 * Paths — the pinned routes and their filters
 * ------------------------------------------------------------------ */

test("pinned session route paths are exact", () => {
  assert.equal(sessionRecordPath("ses_abc"), "/api/session/ses_abc");
  assert.equal(sessionListPath(), "/api/session");
  assert.equal(sessionActivePath(), "/api/session/active");
  assert.equal(sessionInterruptPath("ses_abc"), "/api/session/ses_abc/interrupt");
});

test("a session id is percent-encoded into the path", () => {
  assert.equal(sessionRecordPath("ses/a b"), "/api/session/ses%2Fa%20b");
  assert.equal(sessionInterruptPath("ses/a b"), "/api/session/ses%2Fa%20b/interrupt");
});

test("the child list query carries the parent, the attempt directory, and ascending order", () => {
  assert.deepEqual(sessionChildListQuery(PARENT, CWD), {
    parentID: PARENT,
    directory: CWD,
    order: "asc",
  });
  assert.deepEqual(sessionChildListQuery(PARENT, CWD, { cursor: "c1" }), {
    parentID: PARENT,
    directory: CWD,
    order: "asc",
    cursor: "c1",
  });
});

/* ------------------------------------------------------------------ *
 * Parsers
 * ------------------------------------------------------------------ */

test("parseSessionRecord reads outcome, parentID, and location", () => {
  const parsed = parseSessionRecord(sessionEnvelope(CHILD, { outcome: "interrupted" }).body);
  assert.ok(parsed !== undefined);
  assert.equal(parsed.id, CHILD);
  assert.equal(parsed.parentID, PARENT);
  assert.equal(parsed.outcome, "interrupted");
  assert.equal(parsed.directory, CWD);
});

test("parseSessionRecord treats an absent outcome as unsettled and a root session as parentless", () => {
  // parentID: null means the session record carries no parentID field (a root
  // session); an outcome absent means execution is still unsettled.
  const parsed = parseSessionRecord(
    result200({ data: sessionRecord(PARENT, { parentID: null }) }).body,
  );
  assert.ok(parsed !== undefined);
  assert.equal(parsed.parentID, undefined);
  assert.equal(parsed.outcome, undefined);
});

test("parseSessionRecord fails closed on unusable records", () => {
  for (const unusable of [
    {},
    { data: null },
    { data: { id: CHILD } }, // no location
    { data: { id: "nope" } }, // session ids do not follow the pinned shape
    { data: { id: CHILD, location: { directory: "" } } },
    sessionRecord(CHILD, { outcome: "cancelled" as OpenCodeSessionOutcome }), // outside the pinned enum
    { data: { id: CHILD, location: { directory: CWD }, outcome: 42 } },
  ]) {
    assert.equal(
      parseSessionRecord(unusable),
      undefined,
      `expected ${JSON.stringify(unusable)} to be unusable`,
    );
  }
});

test("parseSessionListing reads items and the next cursor", () => {
  const listing = parseSessionListing(
    listEnvelope([sessionRecord(CHILD, { outcome: "succeeded" })], "c2").body,
  );
  assert.ok(listing !== undefined);
  assert.equal(listing.items.length, 1);
  assert.equal(listing.items[0]?.outcome, "succeeded");
  assert.equal(listing.nextCursor, "c2");
});

test("parseSessionListing treats an empty page with no next page as final", () => {
  const listing = parseSessionListing(listEnvelope([]).body);
  assert.ok(listing !== undefined);
  assert.deepEqual(listing.items, []);
  assert.equal(listing.nextCursor, undefined);
});

test("parseSessionListing only treats an explicit null cursor as the last page", () => {
  const last = parseSessionListing(
    result200({ data: [], cursor: { previous: null, next: null } }).body,
  );
  assert.ok(last !== undefined);
  assert.deepEqual(last.items, []);
  assert.equal(last.nextCursor, undefined);

  const next = parseSessionListing(
    result200({ data: [], cursor: { previous: "c1", next: "c2" } }).body,
  );
  assert.ok(next !== undefined);
  assert.deepEqual(next.items, []);
  assert.equal(next.nextCursor, "c2");
});

test("parseSessionListing rejects a missing or malformed cursor instead of treating it as final", () => {
  // A malformed end-of-list shape is not proof the page chain ended; treating it
  // as final would silently truncate the child set and could hide a running
  // descendant, so every non-`null` `next` shape must reject the page.
  for (const body of [
    { data: [] }, // no cursor at all
    { data: [], cursor: null },
    { data: [], cursor: 42 },
    { data: [], cursor: [] },
    { data: [], cursor: {} }, // missing next
    { data: [], cursor: { previous: null } }, // still missing next
    { data: [], cursor: { next: 7 } }, // non-string next
    { data: [], cursor: { next: true } },
    { data: [], cursor: { next: "" } }, // empty string is not a cursor
  ]) {
    assert.equal(
      parseSessionListing(body),
      undefined,
      `expected ${JSON.stringify(body)} to be rejected`,
    );
  }
});

test("parseSessionListing fails closed when any item is unusable", () => {
  assert.equal(
    parseSessionListing(result200({ data: [{ id: "bad" }], cursor: {} }).body),
    undefined,
  );
  assert.equal(
    parseSessionListing(result200({ data: sessionRecord("x"), cursor: {} }).body),
    undefined,
  );
});

test("parseActiveSessions reads the running map and rejects other shapes", () => {
  const active = parseActiveSessions(activeEnvelope([CHILD]).body);
  assert.ok(active !== undefined);
  assert.equal(active.has(CHILD), true);
  assert.equal(active.has("ses_zzz"), false);

  for (const unusable of [
    {},
    { data: null },
    { data: { [CHILD]: { type: "idle" } } }, // not the pinned "running" drain type
    { data: { not_a_session: { type: "running" } } },
  ]) {
    assert.equal(parseActiveSessions(unusable), undefined);
  }
});

test("parseInterruptResponse reads the interrupted flag and rejects non-booleans", () => {
  assert.deepEqual(parseInterruptResponse({ interrupted: true }), { interrupted: true });
  assert.deepEqual(parseInterruptResponse({ interrupted: false }), { interrupted: false });
  for (const unusable of [{}, { interrupted: "yes" }, null, 42]) {
    assert.equal(parseInterruptResponse(unusable), undefined);
  }
});

/* ------------------------------------------------------------------ *
 * classifyChildSession — the status-outcome + active-map verdict
 * ------------------------------------------------------------------ */

function record(
  id: string,
  outcome?: OpenCodeSessionOutcome,
): Parameters<typeof classifyChildSession>[0] {
  const base = { id, directory: CWD };
  return outcome === undefined ? base : { ...base, outcome };
}

test("a terminal outcome absent from the active map is settled", () => {
  const verdict = classifyChildSession(record(CHILD, "succeeded"), new Set());
  assert.equal(verdict.state, "settled");
  if (verdict.state === "settled") assert.equal(verdict.outcome, "succeeded");
});

test("no outcome means running — even when absent from the active map", () => {
  const verdict = classifyChildSession(record(CHILD), new Set());
  assert.equal(verdict.state, "running");
  const activeVerdict = classifyChildSession(record(CHILD), new Set([CHILD]));
  assert.equal(activeVerdict.state, "running");
});

test("an outcome that contradicts the active map is unknown", () => {
  const verdict = classifyChildSession(record(CHILD, "interrupted"), new Set([CHILD]));
  assert.equal(verdict.state, "unknown");
});

test("a missing record is unknown", () => {
  const verdict = classifyChildSession(undefined, new Set([CHILD]));
  assert.equal(verdict.state, "unknown");
});

/* ------------------------------------------------------------------ *
 * Discovery — attributed parent/child enumeration under one location
 * ------------------------------------------------------------------ */

test("discovery returns a known-empty tree for a parent with no children", async () => {
  const server = makeServer({ session: () => parentEnvelope() });
  const result = await discoverAttemptChildSessions({
    parentSessionId: PARENT,
    attemptDirectory: CWD,
    http: server.http,
    timeoutMs: 10_000,
    now: fakeClock().now,
    sleep: async () => {},
  });
  assert.deepEqual(result.children, []);
  assert.ok(hasGet(server, sessionRecordPath(PARENT)));
  assert.deepEqual(listQueries(server), [{ parentID: PARENT, directory: CWD, order: "asc" }]);
});

test("discovery attributes children whose records echo the parent and the attempt directory", async () => {
  const server = makeServer({
    session: () => parentEnvelope(),
    list: () =>
      listEnvelope([
        sessionRecord("ses_a", { outcome: "succeeded" }),
        sessionRecord("ses_b"), // still running: outcome absent
      ]),
  });
  const result = await discoverAttemptChildSessions({
    parentSessionId: PARENT,
    attemptDirectory: CWD,
    http: server.http,
    timeoutMs: 10_000,
  });
  assert.deepEqual(
    result.children.map((child) => child.id),
    ["ses_a", "ses_b"],
  );
  assert.equal(result.children[0]?.outcome, "succeeded");
  assert.equal(result.children[1]?.outcome, undefined);
});

test("discovery pages through cursor.next and threads the cursor into the query", async () => {
  const server = makeServer({
    session: () => parentEnvelope(),
    list: (query) => {
      if (query.cursor === "c1") {
        return listEnvelope([sessionRecord("ses_b", { outcome: "failed" })]);
      }
      return listEnvelope([sessionRecord("ses_a", { outcome: "succeeded" })], "c1");
    },
  });
  const result = await discoverAttemptChildSessions({
    parentSessionId: PARENT,
    attemptDirectory: CWD,
    http: server.http,
    timeoutMs: 10_000,
  });
  assert.deepEqual(
    result.children.map((child) => child.id),
    ["ses_a", "ses_b"],
  );
  const queries = listQueries(server);
  assert.equal(queries[0]?.cursor, undefined);
  assert.equal(queries[1]?.cursor, "c1");
});

test("discovery rejects a listing whose page cursor repeats", async () => {
  const server = makeServer({
    session: () => parentEnvelope(),
    list: () => listEnvelope([sessionRecord("ses_a", { outcome: "succeeded" })], "c1"),
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
      assert.ok(error.message.includes("repeated cursor"));
      assert.ok(error.message.includes("cannot be trusted"));
      return true;
    },
  );
});

test("discovery caps the number of listing pages", async () => {
  let pages = 0;
  const server = makeServer({
    session: () => parentEnvelope(),
    list: () => {
      pages += 1;
      return listEnvelope([sessionRecord(`ses_p${pages}`)], `c${pages}`);
    },
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
      assert.ok(error.message.includes("exceeded"));
      assert.ok(error.message.includes(String(OPENCODE_SESSION_LIST_PAGE_LIMIT)));
      // The bound must fail BEFORE a non-existent page 51 is fetched.
      assert.ok(pages <= OPENCODE_SESSION_LIST_PAGE_LIMIT);
      return true;
    },
  );
});

test("discovery polls a parent record that is not readable yet, within the bound", async () => {
  const { now, sleep, slept } = fakeClock();
  const server = makeServer({
    session: (id) =>
      id === PARENT
        ? now() < 10
          ? { status: 404, body: {} }
          : parentEnvelope()
        : { status: 404, body: {} },
  });
  const result = await discoverAttemptChildSessions({
    parentSessionId: PARENT,
    attemptDirectory: CWD,
    http: server.http,
    timeoutMs: 100,
    pollIntervalMs: 10,
    now,
    sleep,
  });
  assert.deepEqual(result.children, []);
  assert.ok(slept() >= 1);
});

test("discovery polls an unreadable listing, but a stale parent never fails silently", async () => {
  const { now, sleep, slept } = fakeClock();
  const server = makeServer({
    session: () => parentEnvelope(),
    list: () => (now() < 10 ? "glitch" : listEnvelope([])),
  });
  const result = await discoverAttemptChildSessions({
    parentSessionId: PARENT,
    attemptDirectory: CWD,
    http: server.http,
    timeoutMs: 100,
    pollIntervalMs: 10,
    now,
    sleep,
  });
  assert.deepEqual(result.children, []);
  assert.ok(slept() >= 1);
});

test("discovery fails closed when the parent never becomes readable within the bound", async () => {
  const { now, sleep } = fakeClock();
  const server = makeServer({ session: () => ({ status: 404, body: {} }) });
  await assert.rejects(
    () =>
      discoverAttemptChildSessions({
        parentSessionId: PARENT,
        attemptDirectory: CWD,
        http: server.http,
        timeoutMs: 25,
        pollIntervalMs: 10,
        now,
        sleep,
      }),
    (error: unknown) => {
      assert.ok(error instanceof OpenCodeSessionDiscoveryError);
      assert.ok(error.message.includes("remaining attempt timeout"));
      return true;
    },
  );
});

test("discovery does not settle a listing whose child record fails to attribute to the parent", async () => {
  const server = makeServer({
    session: () => parentEnvelope(),
    list: () => listEnvelope([sessionRecord("ses_orphan", { parentID: "ses_other" })]),
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

test("discovery refuses a child that lives in another directory", async () => {
  const server = makeServer({
    session: () => parentEnvelope(),
    list: () => listEnvelope([sessionRecord("ses_elsewhere", { directory: "C:\\other\\repo" })]),
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

test("discovery refuses a parent session that lives in another directory", async () => {
  const server = makeServer({
    session: () => parentEnvelope({ directory: "C:\\other\\repo" }),
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
      assert.ok(error.message.includes("not this attempt's session"));
      return true;
    },
  );
});

test("discovery reports a readable-but-unparsable listing instead of retrying forever", async () => {
  const server = makeServer({
    session: () => parentEnvelope(),
    list: () => result200({ data: [{ id: "not-a-session" }], cursor: {} }),
  });
  await assert.rejects(
    () =>
      discoverAttemptChildSessions({
        parentSessionId: PARENT,
        attemptDirectory: CWD,
        http: server.http,
        timeoutMs: 10_000,
        now: fakeClock().now,
        sleep: async () => {},
      }),
    OpenCodeSessionDiscoveryError,
  );
});

/* ------------------------------------------------------------------ *
 * Settlement
 * ------------------------------------------------------------------ */

test("a known-empty tree is quiescent only once the parent proves it cannot spawn", async () => {
  // An empty listing alone proves nothing: the parent itself could still spawn
  // a background child. Only a parent record carrying a terminal outcome and
  // absent from a freshly read active map (with the listing still empty) makes
  // the tree quiescent.
  const server = makeServer({
    session: () => parentEnvelope({ outcome: "succeeded" }),
  });
  const settlement = await settleAttemptChildren({
    parentSessionId: PARENT,
    attemptDirectory: CWD,
    http: server.http,
    timeoutMs: 10_000,
  });
  assert.deepEqual(settlement.children, []);
  assert.deepEqual(settlement.interruptedSessionIds, []);
  assert.equal(settlement.rounds, 1);
  // The active map IS consulted now: the parent's inactivity is part of the proof.
  assert.ok(hasGet(server, sessionActivePath()));
  assert.deepEqual(posts(server), []);
});

test("an empty tree waits for a still-unsettled parent and interrupts it on the bounded wait", async () => {
  let parentInterrupted = false;
  const server = makeServer({
    // The parent record has no terminal outcome until the attempt interrupts it.
    session: (id) =>
      id === PARENT
        ? parentEnvelope({
            outcome: parentInterrupted ? "interrupted" : undefined,
          })
        : { status: 404, body: {} },
    interrupt: (id) => {
      assert.equal(id, PARENT);
      parentInterrupted = true;
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
  // The empty tree waited (parent had no outcome), then interrupted the parent
  // when the attempt budget ran out and confirmed the terminal outcome.
  assert.deepEqual(settlement.children, []);
  assert.deepEqual(settlement.interruptedSessionIds, [PARENT]);
  assert.ok(settlement.rounds > 1);
});

test("an empty tree whose parent never becomes terminal fails closed", async () => {
  const server = makeServer({
    // The parent record never gains a terminal outcome, even after interrupt.
    session: () => parentEnvelope({ outcome: undefined }),
    interrupt: () => result200({ interrupted: true }),
  });
  const { now, sleep } = fakeClock();
  await assert.rejects(
    () =>
      settleAttemptChildren({
        parentSessionId: PARENT,
        attemptDirectory: CWD,
        http: server.http,
        timeoutMs: 25,
        pollIntervalMs: 10,
        interruptGraceMs: 50,
        now,
        sleep,
      }),
    (error: unknown) => {
      assert.ok(error instanceof OpenCodeSessionSettleError);
      assert.deepEqual(error.unsettledSessionIds, [PARENT]);
      assert.ok(error.message.includes(PARENT));
      return true;
    },
  );
});

test("an empty tree fails closed when the parent's outcome contradicts the active map", async () => {
  const server = makeServer({
    session: () => parentEnvelope({ outcome: "succeeded" }),
    active: () => activeEnvelope([PARENT]),
  });
  await assert.rejects(
    () =>
      settleAttemptChildren({
        parentSessionId: PARENT,
        attemptDirectory: CWD,
        http: server.http,
        timeoutMs: 10_000,
      }),
    (error: unknown) => {
      assert.ok(error instanceof OpenCodeSessionSettleError);
      assert.deepEqual(error.unknownSessionIds, [PARENT]);
      assert.ok(error.message.includes("contradict"));
      return true;
    },
  );
});

test("the parent record must come back with the expected session id", async () => {
  const server = makeServer({
    session: () => sessionEnvelope("ses_someone_else"),
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
      assert.ok(error.message.includes("ses_someone_else"));
      assert.ok(error.message.includes("cannot be trusted"));
      return true;
    },
  );
});

test("settle cannot declare quiescence until the active map has been read successfully", async () => {
  // The child looks settled on round 1, but the active map glitches: absence is
  // not proven, so the settlement must NOT return on that round.
  let activeCalls = 0;
  const server = makeServer({
    session: (id) =>
      id === PARENT
        ? parentEnvelope()
        : sessionEnvelope(id, { parentID: PARENT, outcome: "succeeded" }),
    list: () => listEnvelope([sessionRecord("ses_a", { outcome: "succeeded" })]),
    active: () => {
      activeCalls += 1;
      return activeCalls === 1 ? { status: 500, body: {} } : activeEnvelope([]);
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
  assert.equal(settlement.rounds, 2, "the glitched active map forced another round");
  assert.deepEqual(settlement.children, [
    { id: "ses_a", outcome: "succeeded", interrupted: false },
  ]);
});

test("a never-readable active map fails the settlement at the bound instead of trusting an empty map", async () => {
  const server = makeServer({
    session: (id) =>
      id === PARENT
        ? parentEnvelope()
        : sessionEnvelope(id, { parentID: PARENT, outcome: "succeeded" }),
    list: () => listEnvelope([sessionRecord("ses_a", { outcome: "succeeded" })]),
    active: () => ({ status: 500, body: {} }),
  });
  const { now, sleep } = fakeClock();
  await assert.rejects(
    () =>
      settleAttemptChildren({
        parentSessionId: PARENT,
        attemptDirectory: CWD,
        http: server.http,
        timeoutMs: 25,
        pollIntervalMs: 10,
        interruptGraceMs: 50,
        now,
        sleep,
      }),
    (error: unknown) => {
      assert.ok(error instanceof OpenCodeSessionSettleError);
      assert.ok(error.message.includes("active sessions map could not be successfully read"));
      assert.ok(error.message.includes("validation and publication must not begin"));
      return true;
    },
  );
});

test("settle never returns clean on a round whose listing glitched, even when every child reads settled", async () => {
  // Round 2's listing glitches and the per-child fallback reads the child as
  // settled — but a glitched listing cannot prove no NEW child appeared, so the
  // settlement must wait for a successful listing round before returning.
  let listCalls = 0;
  const server = makeServer({
    session: (id) =>
      id === PARENT ? parentEnvelope() : sessionEnvelope("ses_a", { outcome: "succeeded" }),
    list: () => {
      listCalls += 1;
      if (listCalls === 1) return listEnvelope([sessionRecord("ses_a")]); // discovery: unsettled
      if (listCalls === 2) return { status: 500, body: {} }; // round 1: glitched listing
      return listEnvelope([sessionRecord("ses_a", { outcome: "succeeded" })]); // round 2: ok
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
  // The glitched round must not authorize a clean return.
  assert.equal(settlement.rounds, 2);
  assert.deepEqual(settlement.children, [
    { id: "ses_a", outcome: "succeeded", interrupted: false },
  ]);
});

test("an empty parent-only tree hands an appeared child to the full settlement", async () => {
  // Empty at first, then the parent spawns a child while the settlement waits:
  // the parent-only proof hands off to the full child settlement.
  let listCalls = 0;
  const server = makeServer({
    session: (id) =>
      id === PARENT
        ? parentEnvelope()
        : sessionEnvelope(id, { parentID: PARENT, outcome: "succeeded" }),
    list: () => {
      listCalls += 1;
      return listCalls === 1
        ? listEnvelope([])
        : listEnvelope([sessionRecord("ses_a", { outcome: "succeeded" })]);
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
  assert.deepEqual(
    settlement.children.map((child) => child.id),
    ["ses_a"],
  );
  assert.deepEqual(settlement.interruptedSessionIds, []);
});

test("an empty tree cannot prove quiescence when the parent spawns around the listing", async () => {
  // The parent is still running at the first settlement round; the listing the
  // OLD ordering trusted as final is empty, and the parent then spawns a child
  // and turns terminal. Because the parent record is read BEFORE the
  // authoritative listing (the fix), that round cannot prove quiescence and the
  // child is adopted by a later full listing. Reading the listing first and the
  // parent afterwards would falsely return an empty tree.
  let listCalls = 0;
  let parentDone = false;
  const server = makeServer({
    session: (id) =>
      id === PARENT
        ? parentEnvelope({ outcome: parentDone ? "succeeded" : undefined })
        : sessionEnvelope("ses_late", { outcome: "succeeded" }),
    list: () => {
      listCalls += 1;
      if (listCalls === 1) return listEnvelope([]); // discovery: nothing spawned yet
      if (listCalls === 2) {
        // Spawn + terminal transition lands right after the listing the old
        // ordering would have trusted, so only a later listing can see it.
        parentDone = true;
        return listEnvelope([]);
      }
      return listEnvelope([sessionRecord("ses_late", { outcome: "succeeded" })]);
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
    ["ses_late"],
    "the late-spawned child must be adopted, never proved as an empty tree",
  );
});

test("non-empty settlement refuses to return while the parent could still spawn", async () => {
  // The child is already terminal and inactive, but the parent is NOT: it could
  // spawn a brand new child the moment the listing is trusted, so the clean
  // return must wait for the parent's own quiescence (interrupting it when the
  // attempt budget runs out).
  let parentOutcome: OpenCodeSessionOutcome | undefined;
  const server = makeServer({
    session: (id) =>
      id === PARENT
        ? parentEnvelope({ outcome: parentOutcome })
        : sessionEnvelope("ses_a", { outcome: "succeeded" }),
    list: () => listEnvelope([sessionRecord("ses_a", { outcome: "succeeded" })]),
    interrupt: (id) => {
      assert.equal(id, PARENT);
      parentOutcome = "interrupted";
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
  // The child stayed settled; only the still-unsettled parent had to be
  // interrupted before the tree was declared quiescent.
  assert.deepEqual(settlement.children, [
    { id: "ses_a", outcome: "succeeded", interrupted: false },
  ]);
  assert.deepEqual(settlement.interruptedSessionIds, [PARENT]);
  assert.ok(settlement.rounds > 1, "the unproven parent forced extra rounds");
});

test("non-empty settlement fails closed when the parent never becomes terminal", async () => {
  const server = makeServer({
    // The child is settled forever; the parent is never terminal, even after
    // interrupt, so the attempt must fail rather than publish alongside a
    // parent that can still spawn.
    session: (id) =>
      id === PARENT
        ? parentEnvelope({ outcome: undefined })
        : sessionEnvelope("ses_a", { outcome: "succeeded" }),
    list: () => listEnvelope([sessionRecord("ses_a", { outcome: "succeeded" })]),
    interrupt: () => result200({ interrupted: true }),
  });
  const { now, sleep } = fakeClock();
  await assert.rejects(
    () =>
      settleAttemptChildren({
        parentSessionId: PARENT,
        attemptDirectory: CWD,
        http: server.http,
        timeoutMs: 25,
        pollIntervalMs: 10,
        interruptGraceMs: 50,
        now,
        sleep,
      }),
    (error: unknown) => {
      assert.ok(error instanceof OpenCodeSessionSettleError);
      assert.deepEqual(error.unsettledSessionIds, [PARENT]);
      assert.ok(error.message.includes(PARENT));
      assert.ok(error.message.includes("validation and publication must not begin"));
      return true;
    },
  );
});

test("the parent record must not carry a parentID: a root attempt is never a child", async () => {
  const server = makeServer({
    // The old fake shape: the "parent" record still claims a parent of its own.
    session: () => sessionEnvelope(PARENT),
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
      assert.ok(error.message.includes("parentID"));
      assert.ok(error.message.includes("cannot itself be a child"));
      return true;
    },
  );
});

test("settle proves quiescence in one round when every child is already settled", async () => {
  const server = makeServer({
    session: (id) =>
      id === PARENT
        ? parentEnvelope()
        : sessionEnvelope(id, { parentID: PARENT, outcome: "succeeded" }),
    list: () => listEnvelope([sessionRecord("ses_a", { outcome: "succeeded" })]),
  });
  const settlement = await settleAttemptChildren({
    parentSessionId: PARENT,
    attemptDirectory: CWD,
    http: server.http,
    timeoutMs: 10_000,
  });
  assert.deepEqual(settlement.children, [
    { id: "ses_a", outcome: "succeeded", interrupted: false },
  ]);
  assert.deepEqual(settlement.interruptedSessionIds, []);
  assert.equal(settlement.rounds, 1);
  assert.ok(hasGet(server, sessionActivePath()));
  assert.deepEqual(posts(server), []);
});

test("settle waits for a running child to complete instead of interrupting it", async () => {
  let listCalls = 0;
  const server = makeServer({
    session: (id) =>
      id === PARENT
        ? parentEnvelope()
        : sessionEnvelope(id, {
            parentID: PARENT,
            ...(listCalls >= 3 ? { outcome: "succeeded" } : {}),
          }),
    list: () => {
      listCalls += 1;
      return listEnvelope([
        sessionRecord("ses_a", { outcome: listCalls >= 3 ? "succeeded" : undefined }),
      ]);
    },
  });
  const { now, sleep, slept } = fakeClock();
  const settlement = await settleAttemptChildren({
    parentSessionId: PARENT,
    attemptDirectory: CWD,
    http: server.http,
    timeoutMs: 1_000_000,
    pollIntervalMs: 250,
    now,
    sleep,
  });
  // Discovery (1) + round 1 (running) + round 2 (settled).
  assert.equal(listCalls, 3);
  assert.equal(slept(), 1);
  assert.deepEqual(settlement.children, [
    { id: "ses_a", outcome: "succeeded", interrupted: false },
  ]);
  assert.deepEqual(settlement.interruptedSessionIds, []);
});

test("settle tracks a late-spawned background child as long as it attributes to the parent", async () => {
  let listCalls = 0;
  const server = makeServer({
    session: (id) =>
      id === PARENT
        ? parentEnvelope()
        : sessionEnvelope(id, {
            parentID: PARENT,
            ...(id === "ses_a" || listCalls >= 3 ? { outcome: "succeeded" } : {}),
          }),
    list: () => {
      listCalls += 1;
      if (listCalls === 1) return listEnvelope([sessionRecord("ses_a", { outcome: "succeeded" })]);
      return listEnvelope([
        sessionRecord("ses_a", { outcome: "succeeded" }),
        sessionRecord("ses_b", { outcome: listCalls >= 3 ? "succeeded" : undefined }),
      ]);
    },
  });
  const settlement = await settleAttemptChildren({
    parentSessionId: PARENT,
    attemptDirectory: CWD,
    http: server.http,
    timeoutMs: 1_000_000,
    pollIntervalMs: 250,
    now: fakeClock().now,
    sleep: async () => {},
  });
  assert.deepEqual(
    settlement.children.map((child) => child.id),
    ["ses_a", "ses_b"],
  );
  assert.deepEqual(settlement.interruptedSessionIds, []);
});

test("expiring the remaining timeout interrupts backend children and confirms the outcome", async () => {
  let interrupted = false;
  const { now, sleep } = fakeClock();
  const server = makeServer({
    session: (id) =>
      id === PARENT
        ? parentEnvelope()
        : sessionEnvelope(id, {
            parentID: PARENT,
            ...(interrupted ? { outcome: "interrupted" } : {}),
          }),
    list: () =>
      listEnvelope([
        sessionRecord("ses_bg", {
          outcome: interrupted ? "interrupted" : undefined,
        }),
      ]),
    interrupt: (id) => {
      assert.equal(id, "ses_bg");
      interrupted = true;
      return result200({ interrupted: true });
    },
  });
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
  assert.deepEqual(settlement.interruptedSessionIds, ["ses_bg"]);
  assert.deepEqual(settlement.children, [
    { id: "ses_bg", outcome: "interrupted", interrupted: true },
  ]);
});

test("cancellation interrupts active children on the next observation", async () => {
  let interrupted = false;
  const server = makeServer({
    session: (id) =>
      id === PARENT
        ? parentEnvelope()
        : sessionEnvelope(id, {
            parentID: PARENT,
            ...(interrupted ? { outcome: "interrupted" } : {}),
          }),
    list: () =>
      listEnvelope([sessionRecord("ses_bg", { outcome: interrupted ? "interrupted" : undefined })]),
    interrupt: () => {
      interrupted = true;
      return result200({ interrupted: true });
    },
  });
  const controller = new AbortController();
  controller.abort();
  const settlement = await settleAttemptChildren({
    parentSessionId: PARENT,
    attemptDirectory: CWD,
    http: server.http,
    timeoutMs: 1_000_000, // the signal, not the clock, must trigger the interrupt
    pollIntervalMs: 10,
    signal: controller.signal,
    now: fakeClock().now,
    sleep: async () => {},
  });
  assert.deepEqual(settlement.interruptedSessionIds, ["ses_bg"]);
  assert.deepEqual(settlement.children, [
    { id: "ses_bg", outcome: "interrupted", interrupted: true },
  ]);
});

test("a cancelled settlement keeps polling in the interrupt phase instead of spinning", async () => {
  // With an already-aborted signal, the DEFAULT sleeper must still wait the
  // bounded poll interval once the interrupt phase begins; an abort-aware wait
  // would resolve instantly every round and hammer the interrupt route. The
  // number of interrupt POSTs must therefore be bounded by the grace / poll
  // budget rather than by how fast the loop can spin.
  let interrupts = 0;
  const server = makeServer({
    session: () => parentEnvelope(),
    list: () => listEnvelope([sessionRecord("ses_bg")]), // never settles
    interrupt: () => {
      interrupts += 1;
      return result200({ interrupted: true });
    },
  });
  const controller = new AbortController();
  controller.abort();
  const pollIntervalMs = 50;
  const interruptGraceMs = 300;
  await assert.rejects(
    () =>
      settleAttemptChildren({
        parentSessionId: PARENT,
        attemptDirectory: CWD,
        http: server.http,
        timeoutMs: 1_000_000,
        pollIntervalMs,
        interruptGraceMs,
        signal: controller.signal,
        // Real clock and the DEFAULT sleeper: the finding is in the default wait.
      }),
    OpenCodeSessionSettleError,
  );
  assert.ok(
    interrupts <= Math.ceil(interruptGraceMs / pollIntervalMs) + 5,
    `interrupt rounds must be bounded by the grace/poll budget, got ${interrupts}`,
  );
});

test("a child that ignores interrupt until the grace expires fails the attempt", async () => {
  const { now, sleep } = fakeClock();
  const server = makeServer({
    session: (id) => (id === PARENT ? parentEnvelope() : sessionEnvelope(id, { parentID: PARENT })),
    list: () => listEnvelope([sessionRecord("ses_stubborn")]),
    interrupt: () => result200({ interrupted: true }),
  });
  await assert.rejects(
    () =>
      settleAttemptChildren({
        parentSessionId: PARENT,
        attemptDirectory: CWD,
        http: server.http,
        timeoutMs: 10,
        pollIntervalMs: 10,
        interruptGraceMs: 50,
        now,
        sleep,
      }),
    (error: unknown) => {
      assert.ok(error instanceof OpenCodeSessionSettleError);
      assert.deepEqual(error.unsettledSessionIds, ["ses_stubborn"]);
      assert.ok(error.message.includes("ses_stubborn"));
      assert.ok(error.message.includes("validation and publication must not begin"));
      return true;
    },
  );
});

test("a missing child state (404) fails the settlement immediately", async () => {
  let listCalls = 0;
  const server = makeServer({
    session: (id) => (id === PARENT ? parentEnvelope() : { status: 404, body: {} }),
    list: () => {
      listCalls += 1;
      // Discovery read succeeds; the observation listing glitches, forcing the
      // per-child pinned read, which 404s.
      return listCalls === 1 ? listEnvelope([sessionRecord("ses_gone")]) : "glitch";
    },
  });
  await assert.rejects(
    () =>
      settleAttemptChildren({
        parentSessionId: PARENT,
        attemptDirectory: CWD,
        http: server.http,
        timeoutMs: 1_000_000,
        now: fakeClock().now,
        sleep: async () => {},
      }),
    (error: unknown) => {
      assert.ok(error instanceof OpenCodeSessionSettleError);
      assert.deepEqual(error.unknownSessionIds, ["ses_gone"]);
      assert.ok(error.message.includes("ses_gone"));
      return true;
    },
  );
});

test("a child that vanishes from the listing fails the settlement", async () => {
  let listCalls = 0;
  const server = makeServer({
    session: () => parentEnvelope(),
    list: () => {
      listCalls += 1;
      return listCalls === 1
        ? listEnvelope([sessionRecord("ses_gone", { outcome: "failed" })])
        : listEnvelope([]);
    },
  });
  await assert.rejects(
    () =>
      settleAttemptChildren({
        parentSessionId: PARENT,
        attemptDirectory: CWD,
        http: server.http,
        timeoutMs: 1_000_000,
        now: fakeClock().now,
        sleep: async () => {},
      }),
    (error: unknown) => {
      assert.ok(error instanceof OpenCodeSessionSettleError);
      assert.deepEqual(error.unknownSessionIds, ["ses_gone"]);
      assert.ok(error.message.includes("vanished"));
      return true;
    },
  );
});

test("a child whose outcome contradicts the active map is unknown and fails", async () => {
  const server = makeServer({
    session: () => parentEnvelope(),
    list: () => listEnvelope([sessionRecord("ses_contradictory", { outcome: "succeeded" })]),
    active: () => activeEnvelope(["ses_contradictory"]),
  });
  await assert.rejects(
    () =>
      settleAttemptChildren({
        parentSessionId: PARENT,
        attemptDirectory: CWD,
        http: server.http,
        timeoutMs: 1_000_000,
        now: fakeClock().now,
        sleep: async () => {},
      }),
    (error: unknown) => {
      assert.ok(error instanceof OpenCodeSessionSettleError);
      assert.deepEqual(error.unknownSessionIds, ["ses_contradictory"]);
      assert.ok(error.message.includes("contradict"));
      return true;
    },
  );
});

test("an unusable active map fails the settlement: quiescence cannot be cross-checked", async () => {
  const server = makeServer({
    session: (id) =>
      id === PARENT
        ? parentEnvelope()
        : sessionEnvelope(id, { parentID: PARENT, outcome: "succeeded" }),
    list: () => listEnvelope([sessionRecord("ses_a", { outcome: "succeeded" })]),
    active: () => result200({ data: { ses_a: { type: "idle" } } }),
  });
  await assert.rejects(
    () =>
      settleAttemptChildren({
        parentSessionId: PARENT,
        attemptDirectory: CWD,
        http: server.http,
        timeoutMs: 1_000_000,
        now: fakeClock().now,
        sleep: async () => {},
      }),
    (error: unknown) => {
      assert.ok(error instanceof OpenCodeSessionSettleError);
      assert.ok(error.message.includes("active sessions map"));
      return true;
    },
  );
});

test("an unusable child listing during observation fails the settlement", async () => {
  let listCalls = 0;
  const server = makeServer({
    session: () => parentEnvelope(),
    list: () => {
      listCalls += 1;
      return listCalls === 1
        ? listEnvelope([sessionRecord("ses_a", { outcome: "succeeded" })])
        : result200({ data: [{ id: "not-a-session" }], cursor: {} });
    },
  });
  await assert.rejects(
    () =>
      settleAttemptChildren({
        parentSessionId: PARENT,
        attemptDirectory: CWD,
        http: server.http,
        timeoutMs: 1_000_000,
        now: fakeClock().now,
        sleep: async () => {},
      }),
    (error: unknown) => {
      assert.ok(error instanceof OpenCodeSessionSettleError);
      assert.ok(error.message.includes("SessionsResponse"));
      return true;
    },
  );
});

test("an interrupt that 404s fails the settlement with the id preserved", async () => {
  const server = makeServer({
    session: () => parentEnvelope(),
    list: () => listEnvelope([sessionRecord("ses_bg")]),
    interrupt: () => ({ status: 404, body: {} }),
  });
  await assert.rejects(
    () =>
      settleAttemptChildren({
        parentSessionId: PARENT,
        attemptDirectory: CWD,
        http: server.http,
        timeoutMs: 0,
        pollIntervalMs: 10,
        now: fakeClock().now,
        sleep: async () => {},
      }),
    (error: unknown) => {
      assert.ok(error instanceof OpenCodeSessionSettleError);
      assert.deepEqual(error.unknownSessionIds, ["ses_bg"]);
      assert.ok(error.message.includes("ses_bg"));
      return true;
    },
  );
});

test("an unparsable interrupt response fails the settlement", async () => {
  const server = makeServer({
    session: () => parentEnvelope(),
    list: () => listEnvelope([sessionRecord("ses_bg")]),
    interrupt: () => result200({ interrupted: "yes" }),
  });
  await assert.rejects(
    () =>
      settleAttemptChildren({
        parentSessionId: PARENT,
        attemptDirectory: CWD,
        http: server.http,
        timeoutMs: 0,
        pollIntervalMs: 10,
        now: fakeClock().now,
        sleep: async () => {},
      }),
    (error: unknown) => {
      assert.ok(error instanceof OpenCodeSessionSettleError);
      assert.deepEqual(error.unknownSessionIds, ["ses_bg"]);
      return true;
    },
  );
});

test("the active map never enumerates children: unrelated running sessions are ignored", async () => {
  // A completely unrelated session is running. It is not a child of the parent,
  // so it must neither appear in the settlement nor be interrupted.
  let interrupted = false;
  const server = makeServer({
    session: (id) =>
      id === PARENT
        ? parentEnvelope()
        : sessionEnvelope(id, {
            parentID: PARENT,
            ...(interrupted ? { outcome: "interrupted" } : {}),
          }),
    list: () =>
      listEnvelope([sessionRecord("ses_bg", { outcome: interrupted ? "interrupted" : undefined })]),
    // Per the pinned probe, interrupt removes the child from the active map;
    // the unrelated session stays running the whole time.
    active: () =>
      activeEnvelope(interrupted ? ["ses_zzz_unrelated"] : ["ses_zzz_unrelated", "ses_bg"]),
    interrupt: (id) => {
      assert.equal(id, "ses_bg"); // only our own attributed child may be interrupted
      interrupted = true;
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
    now,
    sleep,
  });
  assert.deepEqual(
    settlement.children.map((child) => child.id),
    ["ses_bg"],
  );
  assert.deepEqual(posts(server), [sessionInterruptPath("ses_bg")]);
});

test("the whole flow uses exactly the pinned routes", async () => {
  let interrupted = false;
  const server = makeServer({
    session: (id) =>
      id === PARENT
        ? parentEnvelope()
        : sessionEnvelope(id, {
            parentID: PARENT,
            ...(interrupted ? { outcome: "interrupted" } : {}),
          }),
    list: () =>
      listEnvelope([sessionRecord("ses_bg", { outcome: interrupted ? "interrupted" : undefined })]),
    interrupt: () => {
      interrupted = true;
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
    now,
    sleep,
  });
  assert.equal(settlement.interruptedSessionIds.includes("ses_bg"), true);
  assert.ok(hasGet(server, sessionRecordPath(PARENT)), "parent record via GET /api/session/{id}");
  assert.equal(listQueries(server).length > 0, true);
  // Every listing uses the pinned filtered route: the attempt directory, an
  // ascending order, and an attributed session as the parent. The root listing
  // must appear; the descendant walk legitimately lists nested parents too.
  assert.ok(listQueries(server).some((query) => query.parentID === PARENT));
  for (const query of listQueries(server)) {
    assert.ok(
      typeof query.parentID === "string" && query.parentID.startsWith("ses_"),
      `every listing filters by an attributed session, got ${JSON.stringify(query)}`,
    );
    assert.equal(query.directory, CWD);
    assert.equal(query.order, "asc");
  }
  assert.ok(hasGet(server, sessionActivePath()), "active map via GET /api/session/active");
  assert.ok(
    posts(server).includes(sessionInterruptPath("ses_bg")),
    "interrupt via POST /api/session/{id}/interrupt",
  );
});

test("defaults bound the poll interval and interrupt grace on 2.0.16", () => {
  // These are behavioral constants the design relies on; assert them so a
  // change notices.
  assert.equal(OPENCODE_SESSION_POLL_INTERVAL_MS, 250);
  assert.equal(OPENCODE_SESSION_INTERRUPT_GRACE_MS, 5_000);
});

/* ------------------------------------------------------------------ *
 * createCliManagedSessionHttp (production `opencode api` adapter)
 * ------------------------------------------------------------------ */

/** A canned process result from the injected runner. */
function cliResult(
  stdout: string,
  opts: { readonly stderr?: string; readonly exitCode?: number } = {},
): ProcessResult {
  return {
    stdout,
    stderr: opts.stderr ?? "",
    exitCode: opts.exitCode ?? 0,
    timedOut: false,
    isCanceled: false,
  };
}

/** A scripted ProcessRunner that records every call in argv order. */
function makeCliRunner(
  script: (
    binary: string,
    args: readonly string[],
    options: Parameters<ProcessRunner>[2],
  ) => ProcessResult,
): { runner: ProcessRunner; calls: Array<Parameters<ProcessRunner>> } {
  const calls: Array<Parameters<ProcessRunner>> = [];
  const runner: ProcessRunner = (binary, args, options) => {
    calls.push([binary, args, options]);
    return Promise.resolve(script(binary, args, options));
  };
  return { runner, calls };
}

test("cliSessionRequestPath percent-encodes keys and values into the request path", () => {
  assert.equal(
    cliSessionRequestPath(sessionListPath(), sessionChildListQuery(PARENT, CWD)),
    "/api/session?parentID=ses_parent&directory=C%3A%5Cattempts%5Catt-1&order=asc",
  );
  // A path with no query is passed through untouched (session ids are already
  // percent-encoded by sessionRecordPath before the adapter sees them).
  assert.equal(cliSessionRequestPath(sessionRecordPath("ses/a b")), "/api/session/ses%2Fa%20b");
  // A path that already carries a query continues with `&`.
  assert.equal(cliSessionRequestPath("/p?b=1", { c: "2" }), "/p?b=1&c=2");
});

test("parseCliHttpStatus reads the pinned HTTP status line and ignores other text", () => {
  assert.equal(parseCliHttpStatus("HTTP 404 Not Found"), 404);
  assert.equal(parseCliHttpStatus("HTTP 404 Not Found\n"), 404);
  assert.equal(parseCliHttpStatus("some log\nHTTP 500 Internal Server Error\n"), 500);
  assert.equal(
    parseCliHttpStatus("Error: Could not reach server at http://127.0.0.1:9"),
    undefined,
  );
  assert.equal(parseCliHttpStatus(""), undefined);
});

test("the CLI adapter runs the child-list GET with the query encoded into the path, under the exact cwd/env", async () => {
  const { runner, calls } = makeCliRunner(() =>
    cliResult(JSON.stringify({ data: [], cursor: { previous: null, next: null } })),
  );
  const http = createCliManagedSessionHttp({
    binary: "opencode-test",
    cwd: CWD,
    env: { PATH: "test-path", XDG_STATE_HOME: "C:\\state" },
    runner,
  });
  const result = await http.get(sessionListPath(), sessionChildListQuery(PARENT, CWD));
  assert.deepEqual(result, {
    status: 200,
    body: { data: [], cursor: { previous: null, next: null } },
  });
  assert.equal(calls.length, 1);
  const [binary, args, options] = calls[0]!;
  assert.equal(binary, "opencode-test");
  assert.deepEqual(args, [
    "api",
    "GET",
    "/api/session?parentID=ses_parent&directory=C%3A%5Cattempts%5Catt-1&order=asc",
  ]);
  assert.equal(options.cwd, CWD);
  assert.deepEqual(options.env, { PATH: "test-path", XDG_STATE_HOME: "C:\\state" });
});

test("the CLI adapter POSTs the interrupt route and parses the JSON body", async () => {
  const { runner, calls } = makeCliRunner(() => cliResult(JSON.stringify({ interrupted: true })));
  const http = createCliManagedSessionHttp({ binary: "opencode-test", cwd: CWD, env: {}, runner });
  const result = await http.post(sessionInterruptPath("ses/a b"));
  assert.deepEqual(result, { status: 200, body: { interrupted: true } });
  const [, args] = calls[0]!;
  assert.deepEqual(args, ["api", "POST", "/api/session/ses%2Fa%20b/interrupt"]);
});

test("the CLI adapter preserves a 404 from stderr instead of flattening it into a transport error", async () => {
  const { runner } = makeCliRunner(() =>
    cliResult(
      JSON.stringify({
        _tag: "SessionNotFoundError",
        sessionID: "ses_gone",
        message: "Session not found: ses_gone",
      }),
      { stderr: "HTTP 404 Not Found", exitCode: 1 },
    ),
  );
  const http = createCliManagedSessionHttp({ cwd: CWD, env: {}, runner });
  const result = await http.get(sessionRecordPath("ses_gone"));
  // The settlement decides "missing" from status 404 alone; this must not reject.
  assert.deepEqual(result, {
    status: 404,
    body: {
      _tag: "SessionNotFoundError",
      sessionID: "ses_gone",
      message: "Session not found: ses_gone",
    },
  });
});

test("the CLI adapter resolves a stderr-only 404 (no body) with status 404", async () => {
  const { runner } = makeCliRunner(() =>
    cliResult("", { stderr: "HTTP 404 Not Found", exitCode: 1 }),
  );
  const http = createCliManagedSessionHttp({ cwd: CWD, env: {}, runner });
  const result = await http.post(sessionInterruptPath("ses_gone"));
  assert.deepEqual(result, { status: 404, body: undefined });
});

test("the CLI adapter rejects a failure that carries no HTTP status as a transport error", async () => {
  const { runner } = makeCliRunner(() =>
    cliResult("", { stderr: "Error: Could not reach server at http://127.0.0.1:9", exitCode: 1 }),
  );
  const http = createCliManagedSessionHttp({ cwd: CWD, env: {}, runner });
  await assert.rejects(
    () => http.get(sessionActivePath()),
    (error: unknown) => {
      assert.ok(error instanceof OpenCodeSessionCliError);
      assert.ok(error.message.includes("HTTP status"));
      assert.deepEqual(error.argv, ["opencode", "api", "GET", "/api/session/active"]);
      return true;
    },
  );
});

test("the CLI adapter rejects a successful call whose stdout is not a usable JSON body", async () => {
  for (const stdout of ["not json at all", ""]) {
    const { runner } = makeCliRunner(() => cliResult(stdout));
    const http = createCliManagedSessionHttp({ cwd: CWD, env: {}, runner });
    await assert.rejects(
      () => http.get(sessionRecordPath("ses_x")),
      (error: unknown) => {
        assert.ok(error instanceof OpenCodeSessionCliError);
        assert.ok(error.message.includes("OpenCode session API call"));
        return true;
      },
    );
  }
});

test("the CLI adapter bounds every api call with a process timeout", async () => {
  const { runner, calls } = makeCliRunner((_binary, _args) =>
    cliResult(JSON.stringify({ interrupted: false })),
  );
  const http = createCliManagedSessionHttp({
    binary: "opencode-test",
    cwd: CWD,
    env: {},
    runner,
  });
  await http.get(sessionRecordPath("ses_a"));
  await http.post(sessionInterruptPath("ses_a"));
  assert.equal(calls.length, 2);
  for (const [, , options] of calls) {
    assert.equal(options.timeoutMs, OPENCODE_SESSION_CLI_TIMEOUT_MS);
  }
});

test("the CLI adapter honors a caller-supplied per-call timeout", async () => {
  const { runner, calls } = makeCliRunner(() =>
    cliResult(JSON.stringify({ data: { id: "ses_a", location: { directory: CWD } } })),
  );
  const http = createCliManagedSessionHttp({
    cwd: CWD,
    env: {},
    timeoutMs: 1_000,
    runner,
  });
  const result = await http.get(sessionRecordPath("ses_a"));
  assert.deepEqual(result.status, 200);
  const [, , options] = calls[0]!;
  assert.equal(options.timeoutMs, 1_000);
});

test("the CLI adapter drives discovery with exactly the pinned child-list argv", async () => {
  const { runner, calls } = makeCliRunner((_binary, args) => {
    const target = args[2];
    if (target === sessionRecordPath(PARENT)) {
      return cliResult(JSON.stringify({ data: sessionRecord(PARENT, { parentID: null }) }));
    }
    if (target?.startsWith(`${sessionListPath()}?`)) {
      // Honor the parentID filter: the root has CHILD, every nested parent is
      // empty. The recursive walk now lists each admitted descendant, and a
      // root child echoed for a nested query would (correctly) fail closed.
      const isRoot = target.includes(`parentID=${PARENT}`);
      return cliResult(
        JSON.stringify({
          data: isRoot ? [sessionRecord(CHILD, { outcome: "succeeded" })] : [],
          cursor: { previous: null, next: null },
        }),
      );
    }
    return cliResult("", { stderr: "HTTP 404 Not Found", exitCode: 1 });
  });
  const http = createCliManagedSessionHttp({ binary: "opencode-test", cwd: CWD, env: {}, runner });
  const result = await discoverAttemptChildSessions({
    parentSessionId: PARENT,
    attemptDirectory: CWD,
    http,
    timeoutMs: 10_000,
  });
  assert.deepEqual(
    result.children.map((child) => child.id),
    [CHILD],
  );
  // The exact listing argv is the encoded path the live probe verified; the
  // CLI's ignored --param style must never be emitted.
  const listingTarget = calls
    .filter(([, args]) => args[1] === "GET" && args[2]?.startsWith(`${sessionListPath()}?`))
    .map(([, args]) => args[2])[0];
  assert.equal(
    listingTarget,
    "/api/session?parentID=ses_parent&directory=C%3A%5Cattempts%5Catt-1&order=asc",
  );
  assert.ok(
    calls.every(([, args]) => args[0] === "api" && args[1] === "GET"),
    "every CLI call is `opencode api GET <path>`",
  );
  assert.ok(
    calls.every(([, args]) => !args.includes("--param")),
    "the adapter never uses the unreliable --param flag",
  );
});
