/**
 * Unit tests for the bounded, read-only delegation observer (tasks 3.1-3.4).
 *
 * The observer is driven directly with a scripted fake of the pinned session
 * surface and a recording sink, so attribution, bounds, coalescing, teardown
 * and failure isolation are exercised without spawning any process or reading a
 * model.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  DELEGATION_OBSERVER_GLOBAL_CONCURRENCY,
  DelegationConcurrencyLimiter,
  DelegationObserver,
  type DelegationCoverageRecord,
  type DelegationInvocationEnd,
  type DelegationInvocationRecord,
  type DelegationObservedNode,
  type DelegationObservationSink,
} from "../src/agent/delegation-observer.js";
import type {
  ManagedHttpResult,
  ManagedSessionHttp,
  OpenCodeSessionOutcome,
} from "../src/agent/managed-sessions.js";

/* ------------------------------------------------------------------ *
 * Fakes
 * ------------------------------------------------------------------ */

interface FakeSession {
  id: string;
  parentID?: string;
  directory: string;
  outcome?: OpenCodeSessionOutcome;
  agent?: string;
  model?: { providerID: string; id: string; variant?: string };
  time?: { created: number; updated: number };
}

class FakeSessionServer implements ManagedSessionHttp {
  readonly sessions = new Map<string, FakeSession>();
  readonly active = new Set<string>();
  readonly calls: Array<{ method: "GET" | "POST"; path: string; query?: Record<string, string> }> =
    [];
  /** Records appended to every listing, to exercise rejected-entry handling. */
  contaminants: FakeSession[] = [];
  /** Listing failures keyed by parent id. */
  listingFailFor = new Set<string>();
  /** Individual record failures keyed by session id. */
  recordFail = new Set<string>();
  /** Record-path bodies that differ from the listing snapshot. */
  recordOverrides = new Map<string, Record<string, unknown>>();
  /** Artificial delay (ms) applied to a specific request path. */
  recordDelayMs = new Map<string, number>();
  activeFail = false;
  pageCapCursors = false;
  repeatedCursor = false;
  /** When true, every read hangs forever (models a never-settling transport). */
  hangAll = false;
  /** When true, listings ignore the parentID filter (server bug simulation). */
  ignoreParentFilter = false;

  private inFlight = 0;
  maxInFlight = 0;

  add(session: FakeSession): FakeSessionServer {
    this.sessions.set(session.id, session);
    return this;
  }

  private recordBody(session: FakeSession): Record<string, unknown> {
    return {
      id: session.id,
      location: { directory: session.directory },
      ...(session.parentID === undefined ? {} : { parentID: session.parentID }),
      ...(session.outcome === undefined ? {} : { outcome: session.outcome }),
      ...(session.agent === undefined ? {} : { agent: session.agent }),
      ...(session.model === undefined ? {} : { model: session.model }),
      ...(session.time === undefined ? {} : { time: session.time }),
    };
  }

  private async readBody(path: string): Promise<ManagedHttpResult> {
    const delay = this.recordDelayMs.get(path);
    if (delay !== undefined) await new Promise<void>((done) => setTimeout(done, delay));
    const override = this.recordOverrides.get(path);
    if (override !== undefined) return { status: 200, body: { data: override } };
    const id = path.slice("/api/session/".length);
    if (this.recordFail.has(id)) return { status: 500, body: undefined };
    const session = this.sessions.get(id);
    if (session === undefined) return { status: 404, body: undefined };
    return { status: 200, body: { data: this.recordBody(session) } };
  }

  async get(path: string, query?: Record<string, string>): Promise<ManagedHttpResult> {
    if (this.hangAll) return new Promise<ManagedHttpResult>(() => {});
    this.calls.push({ method: "GET", path, ...(query === undefined ? {} : { query }) });
    this.inFlight += 1;
    this.maxInFlight = Math.max(this.maxInFlight, this.inFlight);
    try {
      if (path === "/api/session/active") {
        if (this.activeFail) return { status: 500, body: undefined };
        const data: Record<string, unknown> = {};
        for (const id of this.active) data[id] = { type: "running" };
        return { status: 200, body: { data } };
      }
      if (path === "/api/session") {
        const parent = query?.parentID;
        if (parent !== undefined && this.listingFailFor.has(parent)) {
          return { status: 500, body: undefined };
        }
        let rows = [...this.sessions.values()].filter((session) =>
          this.ignoreParentFilter ? true : session.parentID === parent,
        );
        rows = [...rows, ...this.contaminants];
        let next: string | null = null;
        if (this.repeatedCursor) next = "cursor-same";
        else if (this.pageCapCursors) next = `cursor-${String(this.calls.length)}`;
        return {
          status: 200,
          body: {
            data: rows.map((session) => this.recordBody(session)),
            cursor: { previous: null, next },
          },
        };
      }
      if (path.endsWith("/message")) return { status: 404, body: undefined };
      return await this.readBody(path);
    } finally {
      this.inFlight -= 1;
    }
  }

  async post(path: string): Promise<ManagedHttpResult> {
    this.calls.push({ method: "POST", path });
    return { status: 200, body: { interrupted: true } };
  }

  recordCallsFor(id: string): number {
    return this.calls.filter((call) => call.path === `/api/session/${id}`).length;
  }
}

class RecordingSink implements DelegationObservationSink {
  begins: DelegationInvocationRecord[] = [];
  nodes: DelegationObservedNode[] = [];
  coverages: DelegationCoverageRecord[] = [];
  ends: DelegationInvocationEnd[] = [];
  /** Global emission order, for asserting `end` is last. */
  order: string[] = [];
  throwOn = new Set<"begin" | "upsert" | "coverage" | "end">();

  begin(record: DelegationInvocationRecord): void {
    if (this.throwOn.has("begin")) throw new Error("sink begin failed");
    this.begins.push(record);
    this.order.push("begin");
  }
  upsert(node: DelegationObservedNode): void {
    if (this.throwOn.has("upsert")) throw new Error("sink upsert failed");
    this.nodes.push(node);
    this.order.push(`upsert:${node.sessionId}`);
  }
  coverage(record: DelegationCoverageRecord): void {
    if (this.throwOn.has("coverage")) throw new Error("sink coverage failed");
    this.coverages.push(record);
    this.order.push(`coverage:${record.status}`);
  }
  end(record: DelegationInvocationEnd): void {
    if (this.throwOn.has("end")) throw new Error("sink end failed");
    this.ends.push(record);
    this.order.push("end");
  }

  latest(sessionId: string): DelegationObservedNode | undefined {
    for (let index = this.nodes.length - 1; index >= 0; index -= 1) {
      const node = this.nodes[index];
      if (node?.sessionId === sessionId) return node;
    }
    return undefined;
  }

  ids(): string[] {
    return [...new Set(this.nodes.map((node) => node.sessionId))];
  }

  lastCoverage(): DelegationCoverageRecord | undefined {
    return this.coverages[this.coverages.length - 1];
  }
}

/** A sink whose every call never settles, to prove the observer stays bounded. */
class HangingSink implements DelegationObservationSink {
  begin(): Promise<void> {
    return new Promise<void>(() => {});
  }
  upsert(): Promise<void> {
    return new Promise<void>(() => {});
  }
  coverage(): Promise<void> {
    return new Promise<void>(() => {});
  }
  end(): Promise<void> {
    return new Promise<void>(() => {});
  }
}

function observerFor(
  server: FakeSessionServer,
  sink: RecordingSink,
  options: Partial<ConstructorParameters<typeof DelegationObserver>[0]> = {},
): DelegationObserver {
  return new DelegationObserver({
    attemptId: 7,
    ordinal: 1,
    workspacePath: "/workspace/attempt",
    http: server,
    sink,
    ...options,
  });
}

const DIR = "/workspace/attempt";

/* ------------------------------------------------------------------ *
 * 3.1 Root attachment
 * ------------------------------------------------------------------ */

test("observes a verified root and concurrent/background descendants", async () => {
  const server = new FakeSessionServer();
  server.add({ id: "ses_root", directory: DIR });
  server.add({ id: "ses_a", parentID: "ses_root", directory: DIR, agent: "reviewer" });
  server.add({ id: "ses_b", parentID: "ses_root", directory: DIR });
  server.active.add("ses_a");
  const sink = new RecordingSink();
  const observer = observerFor(server, sink);

  observer.attachRoot("ses_root");
  await observer.observeOnce();

  assert.equal(sink.latest("ses_root")?.state, "idle");
  assert.equal(sink.latest("ses_root")?.role, "root");
  assert.equal(sink.latest("ses_a")?.state, "running");
  assert.equal(sink.latest("ses_a")?.parentSessionId, "ses_root");
  assert.equal(sink.latest("ses_a")?.identity.agentId, "reviewer");
  assert.equal(sink.latest("ses_b")?.state, "idle");
  assert.equal(sink.lastCoverage()?.status, "healthy");
  assert.equal(sink.lastCoverage()?.partial, false);
});

test("missing root records a gap and stays unavailable", async () => {
  const server = new FakeSessionServer();
  const sink = new RecordingSink();
  const observer = observerFor(server, sink);

  await observer.observeOnce();

  assert.deepEqual(sink.ids(), []);
  assert.equal(sink.lastCoverage()?.status, "unavailable");
  assert.ok(sink.lastCoverage()?.gaps.includes("root-missing"));
});

test("a root that is not a root (has parentID) or is elsewhere is not attached", async () => {
  const server = new FakeSessionServer();
  server.add({ id: "ses_root", parentID: "ses_elsewhere", directory: DIR });
  const sink = new RecordingSink();
  const observer = observerFor(server, sink);
  observer.attachRoot("ses_root");
  await observer.observeOnce();

  assert.deepEqual(sink.ids(), []);
  assert.ok(sink.lastCoverage()?.gaps.includes("root-unverified"));

  const wrongDir = new FakeSessionServer();
  wrongDir.add({ id: "ses_root", directory: "/somewhere/else" });
  const sink2 = new RecordingSink();
  const observer2 = observerFor(wrongDir, sink2);
  observer2.attachRoot("ses_root");
  await observer2.observeOnce();
  assert.deepEqual(sink2.ids(), []);
  assert.ok(sink2.lastCoverage()?.gaps.includes("root-unverified"));
});

test("a vanished root becomes root-lost", async () => {
  const server = new FakeSessionServer();
  server.add({ id: "ses_root", directory: DIR });
  const sink = new RecordingSink();
  const observer = observerFor(server, sink);
  observer.attachRoot("ses_root");
  await observer.observeOnce();
  assert.equal(sink.latest("ses_root")?.role, "root");

  server.sessions.delete("ses_root");
  await observer.observeOnce();
  assert.ok(sink.lastCoverage()?.gaps.includes("root-lost"));
});

test("duplicate root ids are idempotent; a conflicting id is a gap", async () => {
  const server = new FakeSessionServer();
  server.add({ id: "ses_root", directory: DIR });
  const sink = new RecordingSink();
  const observer = observerFor(server, sink);
  observer.attachRoot("ses_root");
  observer.attachRoot("ses_root");
  observer.attachRoot("ses_other");
  await observer.observeOnce();

  assert.equal(sink.latest("ses_root")?.rootSessionId, "ses_root");
  assert.deepEqual(sink.ids(), ["ses_root"]);
  assert.ok(sink.lastCoverage()?.gaps.includes("root-unverified"));
});

test("an invalid session id is refused as a root", async () => {
  const server = new FakeSessionServer();
  const sink = new RecordingSink();
  const observer = observerFor(server, sink);
  observer.attachRoot("not-a-session");
  await observer.observeOnce();
  assert.deepEqual(sink.ids(), []);
  assert.ok(sink.lastCoverage()?.gaps.includes("root-unverified"));
});

/* ------------------------------------------------------------------ *
 * 3.2 Bounded recursive enumeration and strict attribution
 * ------------------------------------------------------------------ */

test("rejected contaminant records reduce coverage instead of attaching", async () => {
  const server = new FakeSessionServer();
  server.add({ id: "ses_root", directory: DIR });
  server.add({ id: "ses_ok", parentID: "ses_root", directory: DIR });
  server.contaminants = [
    { id: "ses_other_job", parentID: "ses_other_root", directory: DIR },
    { id: "ses_elsewhere", parentID: "ses_root", directory: "/another/attempt" },
  ];
  const sink = new RecordingSink();
  const observer = observerFor(server, sink);
  observer.attachRoot("ses_root");
  await observer.observeOnce();

  assert.deepEqual(sink.ids().sort(), ["ses_ok", "ses_root"]);
  assert.ok(sink.lastCoverage()?.gaps.includes("unattributed-record"));
  assert.equal(sink.lastCoverage()?.partial, true);
});

test("enforces the depth cap and marks the tree truncated", async () => {
  const server = new FakeSessionServer();
  server.add({ id: "ses_root", directory: DIR });
  server.add({ id: "ses_a", parentID: "ses_root", directory: DIR });
  server.add({ id: "ses_b", parentID: "ses_a", directory: DIR });
  server.add({ id: "ses_c", parentID: "ses_b", directory: DIR });
  const sink = new RecordingSink();
  const observer = observerFor(server, sink, { depthLimit: 2 });
  observer.attachRoot("ses_root");
  await observer.observeOnce();

  assert.deepEqual(sink.ids().sort(), ["ses_a", "ses_b", "ses_root"]);
  assert.ok(sink.lastCoverage()?.gaps.includes("depth-cap"));
  assert.equal(sink.lastCoverage()?.truncated, true);
  assert.equal(sink.lastCoverage()?.partial, true);
});

test("enforces the node cap and marks the tree truncated", async () => {
  const server = new FakeSessionServer();
  server.add({ id: "ses_root", directory: DIR });
  for (const id of ["ses_a", "ses_b", "ses_c", "ses_d"]) {
    server.add({ id, parentID: "ses_root", directory: DIR });
  }
  const sink = new RecordingSink();
  const observer = observerFor(server, sink, { nodeLimit: 3 });
  observer.attachRoot("ses_root");
  await observer.observeOnce();

  assert.equal(sink.ids().length, 3);
  assert.ok(sink.lastCoverage()?.gaps.includes("node-cap"));
  assert.equal(sink.lastCoverage()?.truncated, true);
});

test("enforces the page cap", async () => {
  const server = new FakeSessionServer();
  server.add({ id: "ses_root", directory: DIR });
  server.add({ id: "ses_a", parentID: "ses_root", directory: DIR });
  server.pageCapCursors = true;
  const sink = new RecordingSink();
  const observer = observerFor(server, sink, { pageLimit: 2 });
  observer.attachRoot("ses_root");
  await observer.observeOnce();

  assert.ok(sink.lastCoverage()?.gaps.includes("page-cap"));
  assert.equal(sink.lastCoverage()?.partial, true);
});

test("detects a repeated id (cycle) and does not attach it twice", async () => {
  const server = new FakeSessionServer();
  server.add({ id: "ses_root", directory: DIR });
  server.add({ id: "ses_a", parentID: "ses_root", directory: DIR });
  // A self-referential child: listing ses_a returns ses_a itself.
  server.add({ id: "ses_a_loop", parentID: "ses_a", directory: DIR });
  server.recordOverrides.set("/api/session/ses_a_loop", {
    id: "ses_a",
    parentID: "ses_a",
    location: { directory: DIR },
  });
  // The listing filter is by parentID, so make the duplicate appear under
  // ses_a legitimately (same id as the already-discovered child).
  server.sessions.set("ses_a_loop", { id: "ses_a", parentID: "ses_a", directory: DIR });

  const sink = new RecordingSink();
  const observer = observerFor(server, sink);
  observer.attachRoot("ses_root");
  await observer.observeOnce();

  assert.deepEqual(sink.ids().sort(), ["ses_a", "ses_root"]);
  assert.ok(sink.lastCoverage()?.gaps.includes("cycle"));
});

test("individually refreshes a known record before classifying", async () => {
  const server = new FakeSessionServer();
  server.add({ id: "ses_root", directory: DIR });
  server.add({ id: "ses_child", parentID: "ses_root", directory: DIR, outcome: "succeeded" });
  // The stale listing says succeeded; the individual refresh still shows an
  // active, nonterminal session.
  server.recordOverrides.set("/api/session/ses_child", {
    id: "ses_child",
    parentID: "ses_root",
    location: { directory: DIR },
  });
  server.active.add("ses_child");
  const sink = new RecordingSink();
  const observer = observerFor(server, sink);
  observer.attachRoot("ses_root");
  await observer.observeOnce();

  assert.equal(sink.latest("ses_child")?.state, "running");
  assert.ok(server.recordCallsFor("ses_child") >= 1);
});

test("a terminal outcome still listed active is unknown (contradiction)", async () => {
  const server = new FakeSessionServer();
  server.add({ id: "ses_root", directory: DIR });
  server.add({ id: "ses_child", parentID: "ses_root", directory: DIR, outcome: "succeeded" });
  server.active.add("ses_child");
  const sink = new RecordingSink();
  const observer = observerFor(server, sink);
  observer.attachRoot("ses_root");
  await observer.observeOnce();

  assert.equal(sink.latest("ses_child")?.state, "unknown");
});

test("an unreadable active map leaves a terminal outcome unconfirmed", async () => {
  const server = new FakeSessionServer();
  server.add({ id: "ses_root", directory: DIR });
  server.add({ id: "ses_child", parentID: "ses_root", directory: DIR, outcome: "succeeded" });
  server.activeFail = true;
  const sink = new RecordingSink();
  const observer = observerFor(server, sink);
  observer.attachRoot("ses_root");
  await observer.observeOnce();

  assert.equal(sink.latest("ses_child")?.state, "unknown");
  assert.ok(sink.lastCoverage()?.gaps.includes("active-unavailable"));
});

test("retains last-known evidence for a node lost from a later round", async () => {
  const server = new FakeSessionServer();
  server.add({ id: "ses_root", directory: DIR });
  server.add({ id: "ses_child", parentID: "ses_root", directory: DIR });
  const sink = new RecordingSink();
  const observer = observerFor(server, sink);
  observer.attachRoot("ses_root");
  await observer.observeOnce();
  assert.equal(sink.latest("ses_child")?.state, "idle");

  server.sessions.delete("ses_child");
  await observer.observeOnce();
  assert.equal(sink.latest("ses_child")?.state, "unknown");
  assert.ok(sink.lastCoverage()?.gaps.includes("node-lost"));
});

/* ------------------------------------------------------------------ *
 * 3.3 Coalescing, bounds, cancellation
 * ------------------------------------------------------------------ */

test("requested cancellation is independent of the observed outcome", async () => {
  const server = new FakeSessionServer();
  server.add({ id: "ses_root", directory: DIR });
  server.add({ id: "ses_child", parentID: "ses_root", directory: DIR });
  server.active.add("ses_child");
  const sink = new RecordingSink();
  const observer = observerFor(server, sink);
  observer.attachRoot("ses_root");
  observer.requestCancellation();
  await observer.observeOnce();

  const running = sink.latest("ses_child");
  assert.equal(running?.state, "running");
  assert.equal(running?.cancellationRequested, true);

  server.active.delete("ses_child");
  server.sessions.set("ses_child", {
    id: "ses_child",
    parentID: "ses_root",
    directory: DIR,
    outcome: "interrupted",
  });
  await observer.observeOnce();
  const interrupted = sink.latest("ses_child");
  assert.equal(interrupted?.state, "interrupted");
  assert.equal(interrupted?.cancellationRequested, true);
});

test("a timed-out call does not free its global slot (no fake free slot)", async () => {
  const server = new FakeSessionServer();
  server.add({ id: "ses_root", directory: DIR });
  server.recordDelayMs.set("/api/session/ses_root", 45);
  const sink = new RecordingSink();
  const observer = observerFor(server, sink, {
    perCallTimeoutMs: 5,
    globalConcurrencyLimit: 1,
  });
  observer.attachRoot("ses_root");

  const first = observer.observeOnce();
  await new Promise<void>((done) => setTimeout(done, 8));
  const second = observer.observeOnce();
  await Promise.all([first, second]);

  assert.ok(sink.lastCoverage()?.gaps.includes("call-timeout"));
  assert.equal(server.maxInFlight, 1, "a timed-out call must still hold its slot");
});

test("bounds concurrent reads with the shared limiter", async () => {
  const server = new FakeSessionServer();
  server.add({ id: "ses_root", directory: DIR });
  server.add({ id: "ses_a", parentID: "ses_root", directory: DIR });
  server.add({ id: "ses_b", parentID: "ses_root", directory: DIR });
  server.recordDelayMs.set("/api/session/ses_root", 3);
  const sink = new RecordingSink();
  const limiter = new DelegationConcurrencyLimiter(1);
  const observer = observerFor(server, sink, { limiter });
  observer.attachRoot("ses_root");
  await observer.observeOnce();
  assert.ok(server.maxInFlight <= 1);
});

test("coalesced polling runs at most one round at a time", async () => {
  const server = new FakeSessionServer();
  server.add({ id: "ses_root", directory: DIR });
  server.recordDelayMs.set("/api/session/ses_root", 10);
  const sink = new RecordingSink();
  const observer = observerFor(server, sink, { pollIntervalMs: 2 });
  observer.start();
  observer.attachRoot("ses_root");
  await new Promise<void>((done) => setTimeout(done, 60));
  observer.dispose();
  assert.ok(server.maxInFlight <= DELEGATION_OBSERVER_GLOBAL_CONCURRENCY);
});

test("dispose stops scheduling promptly", async () => {
  const server = new FakeSessionServer();
  server.add({ id: "ses_root", directory: DIR });
  const sink = new RecordingSink();
  const observer = observerFor(server, sink, { pollIntervalMs: 2 });
  observer.start();
  observer.attachRoot("ses_root");
  await new Promise<void>((done) => setTimeout(done, 30));
  observer.dispose();
  const afterDispose = server.calls.length;
  await new Promise<void>((done) => setTimeout(done, 30));
  assert.equal(server.calls.length, afterDispose, "no reads may occur after dispose");
  await observer.observeOnce();
  assert.equal(server.calls.length, afterDispose, "observeOnce after dispose is a no-op");
});

/* ------------------------------------------------------------------ *
 * 3.4 Finalization and failure isolation
 * ------------------------------------------------------------------ */

test("final reconcile updates terminal evidence and ends the invocation", async () => {
  const server = new FakeSessionServer();
  server.add({ id: "ses_root", directory: DIR });
  server.add({ id: "ses_child", parentID: "ses_root", directory: DIR });
  server.active.add("ses_child");
  const sink = new RecordingSink();
  const observer = observerFor(server, sink);
  observer.attachRoot("ses_root");
  await observer.observeOnce();
  assert.equal(sink.latest("ses_child")?.state, "running");

  server.active.delete("ses_child");
  server.sessions.set("ses_child", {
    id: "ses_child",
    parentID: "ses_root",
    directory: DIR,
    outcome: "succeeded",
  });
  await observer.finalize();

  assert.equal(sink.latest("ses_child")?.state, "succeeded");
  assert.equal(sink.ends.length, 1);
  assert.equal(sink.ends[0]?.attemptId, 7);
  assert.equal(sink.ends[0]?.ordinal, 1);
});

test("a throwing sink never propagates or stops observation", async () => {
  const server = new FakeSessionServer();
  server.add({ id: "ses_root", directory: DIR });
  const sink = new RecordingSink();
  sink.throwOn = new Set(["begin", "upsert", "coverage", "end"]);
  const observer = observerFor(server, sink);
  observer.start();
  observer.attachRoot("ses_root");

  await assert.doesNotReject(() => observer.observeOnce());
  await assert.doesNotReject(() => observer.finalize());
  observer.dispose();
  assert.ok(server.calls.length > 0, "observation must continue despite a broken sink");
});

test("a transport that always throws is isolated and recorded", async () => {
  const server = new FakeSessionServer();
  server.recordFail.add("ses_root");
  const sink = new RecordingSink();
  const observer = observerFor(server, sink, { perCallTimeoutMs: 50 });
  observer.attachRoot("ses_root");

  await assert.doesNotReject(() => observer.observeOnce());
  assert.ok(sink.lastCoverage()?.gaps.includes("transport-error"));
});

test("runScheduledRound is safe before start and after stop", async () => {
  const server = new FakeSessionServer();
  server.add({ id: "ses_root", directory: DIR });
  const sink = new RecordingSink();
  const observer = observerFor(server, sink, { pollIntervalMs: 5 });
  // Attaching before start must not schedule anything.
  observer.attachRoot("ses_root");
  await new Promise<void>((done) => setTimeout(done, 15));
  assert.equal(server.calls.length, 0);
  assert.equal(sink.begins.length, 0);
  await observer.finalize();
  assert.deepEqual(sink.ids(), ["ses_root"]);
});

/* ------------------------------------------------------------------ *
 * Review corrections
 * ------------------------------------------------------------------ */

test("verifiedRootSessionId is set only after verification and revoked on loss", async () => {
  const server = new FakeSessionServer();
  server.add({ id: "ses_root", directory: DIR });
  const sink = new RecordingSink();
  const observer = observerFor(server, sink);
  observer.attachRoot("ses_root");
  assert.equal(observer.verifiedRootSessionId, undefined, "not verified before a round");

  await observer.observeOnce();
  assert.equal(observer.verifiedRootSessionId, "ses_root");

  server.sessions.delete("ses_root");
  await observer.observeOnce();
  assert.equal(observer.verifiedRootSessionId, undefined, "revoked on root loss");

  const wrong = new FakeSessionServer();
  wrong.add({ id: "ses_root", directory: "/somewhere/else" });
  const other = observerFor(wrong, new RecordingSink());
  other.attachRoot("ses_root");
  await other.observeOnce();
  assert.equal(other.verifiedRootSessionId, undefined, "an unverifiable root is never exposed");
});

test("a mismatched record is never attributed; current evidence is revoked", async () => {
  const server = new FakeSessionServer();
  server.add({ id: "ses_root", directory: DIR });
  server.add({ id: "ses_child", parentID: "ses_root", directory: DIR });
  // The endpoint returns a DIFFERENT session's record for the requested id.
  server.recordOverrides.set("/api/session/ses_child", {
    id: "ses_sibling",
    parentID: "ses_root",
    location: { directory: DIR },
    agent: "other-agent",
  });
  const sink = new RecordingSink();
  const observer = observerFor(server, sink);
  observer.attachRoot("ses_root");
  await observer.observeOnce();

  const node = sink.latest("ses_child");
  assert.equal(node?.presence, "missing", "the unmatched record must not be attributed");
  assert.equal(node?.state, "unknown");
  assert.equal(node?.identity.agentId, undefined, "no sibling identity may be attached");
  assert.ok(sink.lastCoverage()?.gaps.includes("unattributed-record"));
});

test("uses the dedicated parser's safe identity and timestamp contract", async () => {
  const server = new FakeSessionServer();
  server.add({
    id: "ses_root",
    directory: DIR,
    agent: "reviewer",
    model: { providerID: "anthropic", id: "claude", variant: "xhigh" },
    time: { created: 1_700_000_000_000, updated: 1_700_000_005_000 },
  });
  const sink = new RecordingSink();
  const observer = observerFor(server, sink);
  observer.attachRoot("ses_root");
  await observer.observeOnce();

  const node = sink.latest("ses_root");
  assert.equal(node?.identity.agentId, "reviewer");
  assert.equal(node?.identity.model, "anthropic/claude#xhigh");
  assert.equal(node?.sourceCreatedAt, 1_700_000_000_000);
  assert.equal(node?.sourceUpdatedAt, 1_700_000_005_000);
  assert.equal(node?.presence, "observed");
});

test("a failed child refresh is persisted as missing current evidence", async () => {
  const server = new FakeSessionServer();
  server.add({ id: "ses_root", directory: DIR });
  server.add({ id: "ses_child", parentID: "ses_root", directory: DIR, outcome: "succeeded" });
  server.recordFail.add("ses_child");
  const sink = new RecordingSink();
  const observer = observerFor(server, sink);
  observer.attachRoot("ses_root");
  await observer.observeOnce();

  const node = sink.latest("ses_child");
  assert.equal(node?.presence, "missing");
  assert.equal(node?.state, "unknown");
  assert.equal(node?.active, undefined, "missing evidence must not assert active presence");
  assert.ok(sink.lastCoverage()?.gaps.includes("transport-error"));
});

test("a lost node is persisted as missing current evidence", async () => {
  const server = new FakeSessionServer();
  server.add({ id: "ses_root", directory: DIR });
  server.add({ id: "ses_child", parentID: "ses_root", directory: DIR });
  const sink = new RecordingSink();
  const observer = observerFor(server, sink);
  observer.attachRoot("ses_root");
  await observer.observeOnce();
  assert.equal(sink.latest("ses_child")?.presence, "observed");

  server.sessions.delete("ses_child");
  await observer.observeOnce();
  const node = sink.latest("ses_child");
  assert.equal(node?.presence, "missing");
  assert.equal(node?.state, "unknown");
  assert.equal(node?.active, undefined);
});

test("the limiter bounds and cancels queued waiters", async () => {
  const limiter = new DelegationConcurrencyLimiter(1);
  assert.equal(await limiter.acquire(), true);
  assert.equal(await limiter.acquire({ timeoutMs: 10 }), false);
  limiter.release();
  assert.equal(limiter.inFlight, 0);

  const acquired = await limiter.acquire();
  assert.equal(acquired, true);
  const controller = new AbortController();
  const pending = limiter.acquire({ signal: controller.signal });
  controller.abort();
  assert.equal(await pending, false);
  assert.equal(limiter.queued, 0);
  limiter.release();
});

test("a saturated limiter cannot hang an observer or finalization", async () => {
  const limiter = new DelegationConcurrencyLimiter(1);
  const holderServer = new FakeSessionServer();
  holderServer.add({ id: "ses_root", directory: DIR });
  holderServer.hangAll = true;
  const holder = observerFor(holderServer, new RecordingSink(), {
    limiter,
    perCallTimeoutMs: 20,
    roundBudgetMs: 20,
  });
  holder.attachRoot("ses_root");
  await holder.observeOnce(); // holds the only slot with a never-settling call

  const server = new FakeSessionServer();
  server.add({ id: "ses_root", directory: DIR });
  const sink = new RecordingSink();
  const observer = observerFor(server, sink, {
    limiter,
    perCallTimeoutMs: 20,
    roundBudgetMs: 20,
  });
  observer.attachRoot("ses_root");

  const started = Date.now();
  await observer.observeOnce();
  assert.ok(Date.now() - started < 500, "a saturated acquire must time out quickly");
  assert.ok(sink.lastCoverage()?.gaps.includes("call-timeout"));

  const finalStarted = Date.now();
  await observer.finalize();
  assert.ok(Date.now() - finalStarted < 500, "finalization must be bounded");
  observer.dispose();
  holder.dispose();
});

test("a never-settling sink cannot hang observation or finalization", async () => {
  const server = new FakeSessionServer();
  server.add({ id: "ses_root", directory: DIR });
  const observer = observerFor(server, new HangingSink(), {
    perCallTimeoutMs: 20,
    roundBudgetMs: 20,
  });
  observer.start();
  observer.attachRoot("ses_root");

  const started = Date.now();
  await observer.observeOnce();
  await observer.finalize();
  observer.dispose();
  assert.ok(Date.now() - started < 1_000, "a hung sink must be bounded");
});

test("a throwing warn seam never escapes and carries no error payload", async () => {
  const server = new FakeSessionServer();
  server.recordFail.add("ses_root");
  const seen: Array<Record<string, unknown> | undefined> = [];
  const observer = observerFor(server, new RecordingSink(), {
    perCallTimeoutMs: 20,
    warn: (_event, fields) => {
      seen.push(fields);
      throw new Error("diagnostic blew up");
    },
  });
  observer.attachRoot("ses_root");

  await assert.doesNotReject(() => observer.observeOnce());
  await assert.doesNotReject(() => observer.finalize());
  observer.dispose();
  for (const fields of seen) {
    assert.equal(Object.prototype.hasOwnProperty.call(fields ?? {}, "message"), false);
  }
});

test("caps known nodes across the whole invocation, not just one walk", async () => {
  const server = new FakeSessionServer();
  server.add({ id: "ses_root", directory: DIR });
  server.add({ id: "ses_a", parentID: "ses_root", directory: DIR });
  const sink = new RecordingSink();
  const observer = observerFor(server, sink, { nodeLimit: 3 });
  observer.attachRoot("ses_root");
  await observer.observeOnce(); // knownNodes: root, ses_a (2 of 3)

  // The tree churns session ids between rounds: ses_a vanishes and two NEW
  // children appear. A per-walk cap would let the walk hold root+ses_b+ses_c
  // and accumulate a fourth distinct node overall; the invocation-wide cap must
  // reject the extra new node and disclose it.
  server.sessions.delete("ses_a");
  server.add({ id: "ses_b", parentID: "ses_root", directory: DIR });
  server.add({ id: "ses_c", parentID: "ses_root", directory: DIR });
  await observer.observeOnce();

  const distinct = sink.ids();
  assert.equal(distinct.length, 3, `distinct known nodes ${distinct.length} must obey the cap`);
  assert.equal(distinct.includes("ses_c"), false, "a node past the invocation cap is not attached");
  assert.ok(sink.lastCoverage()?.gaps.includes("node-cap"));
  assert.equal(sink.lastCoverage()?.truncated, true);
  assert.equal(sink.lastCoverage()?.partial, true);
});

test("a round deadline cannot let a second round overlap the late one", async () => {
  const server = new FakeSessionServer();
  server.add({ id: "ses_root", directory: DIR });
  // The in-flight root read outlives the round budget, so an over-eager
  // scheduler would start a second round while this one is still running.
  server.recordDelayMs.set("/api/session/ses_root", 40);
  const sink = new RecordingSink();
  const observer = observerFor(server, sink, {
    perCallTimeoutMs: 500,
    roundBudgetMs: 5,
    pollIntervalMs: 10_000,
  });
  observer.attachRoot("ses_root");

  const first = observer.observeOnce();
  const second = observer.observeOnce();
  await Promise.all([first, second]);

  assert.equal(server.maxInFlight, 1, "a late round body must not overlap a new one");
  assert.equal(server.recordCallsFor("ses_root"), 1, "the shared round reads the root once");
  assert.ok(sink.lastCoverage()?.gaps.includes("call-timeout"));
});

test("a failed verified child refresh revokes prior evidence but keeps history", async () => {
  const server = new FakeSessionServer();
  server.add({ id: "ses_root", directory: DIR });
  server.add({ id: "ses_child", parentID: "ses_root", directory: DIR, agent: "reviewer" });
  server.active.add("ses_child");
  const sink = new RecordingSink();
  const observer = observerFor(server, sink);
  observer.attachRoot("ses_root");
  await observer.observeOnce();
  assert.equal(sink.latest("ses_child")?.state, "running");
  assert.equal(sink.latest("ses_child")?.identity.agentId, "reviewer");

  // The individual refresh now returns a DIFFERENT session's record (a
  // sibling). The prior `running` evidence must be revoked, not left asserted,
  // and the mismatched record must never supply identity.
  server.recordOverrides.set("/api/session/ses_child", {
    id: "ses_sibling",
    parentID: "ses_root",
    location: { directory: DIR },
    agent: "other-agent",
  });
  await observer.observeOnce();

  const revoked = sink.latest("ses_child");
  assert.equal(revoked?.presence, "missing");
  assert.equal(revoked?.state, "unknown");
  assert.equal(revoked?.active, undefined, "a failed refresh must not keep asserting active");
  assert.equal(revoked?.identity.agentId, "reviewer", "the prior identity history survives");
  assert.notEqual(revoked?.identity.agentId, "other-agent", "the mismatched record is not used");
  assert.ok(sink.lastCoverage()?.gaps.includes("unattributed-record"));
});

test("finalize emits end last and no round output follows it", async () => {
  const server = new FakeSessionServer();
  server.add({ id: "ses_root", directory: DIR });
  server.add({ id: "ses_child", parentID: "ses_root", directory: DIR });
  server.recordDelayMs.set("/api/session/ses_child", 40);
  const sink = new RecordingSink();
  const observer = observerFor(server, sink, {
    perCallTimeoutMs: 100,
    roundBudgetMs: 5,
    pollIntervalMs: 5,
  });
  observer.start();
  observer.attachRoot("ses_root");
  // Let a scheduled round begin and then overrun its round budget while the
  // slow child read is still in flight.
  await new Promise<void>((done) => setTimeout(done, 12));

  const started = Date.now();
  await observer.finalize();
  assert.ok(Date.now() - started < 1_000, "finalization must stay bounded");
  // Give any late round body a chance to emit, then confirm `end` is terminal.
  await new Promise<void>((done) => setTimeout(done, 60));
  observer.dispose();

  assert.ok(sink.order.includes("end"), "the invocation end record is emitted");
  assert.equal(sink.order[sink.order.length - 1], "end", "nothing may be emitted after end");
});
