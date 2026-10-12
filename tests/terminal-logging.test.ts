import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import Database from "better-sqlite3";
import { Store } from "../src/store/db.js";
import {
  Logger,
  formatJsonRecord,
  createJsonStderrSink,
  type LogRecord,
} from "../src/log/logger.js";
import { REDACTED } from "../src/log/redact.js";
import {
  createPlainSink,
  formatPlainRecord,
  isPlainVisible,
  MAX_PLAIN_LINE,
  sanitizePlainText,
} from "../src/log/presentation.js";
import {
  followLogRecords,
  LOGS_HELP,
  MAX_TAIL,
  openReadOnlyLogDatabase,
  parseTailArgs,
  readRecordsAfter,
  readTailRecords,
  runTail,
  DEFAULT_DATA_DIR,
} from "../src/log/tail.js";

const SECRET = "ghp_super_secret_value";
const iso = (offsetMs: number): string => new Date(1_700_000_000_000 + offsetMs).toISOString();

function memoryStore(): Store {
  return new Store({ dataDir: ":memory:", file: ":memory:" });
}

type Level = LogRecord["level"];

function seededDataDir(records: Array<[Level, string, Record<string, unknown>]>): string {
  const dir = mkdtempSync(join(tmpdir(), `gremlyn-logs-${randomUUID()}`));
  const store = new Store({ dataDir: dir });
  const logger = new Logger({
    level: "debug",
    secrets: [SECRET],
    db: store.db,
    sink: () => undefined,
  });
  for (const [level, event, fields] of records) {
    logger[level](event, fields);
  }
  store.close();
  return dir;
}

function captureIo() {
  const out: string[] = [];
  const err: string[] = [];
  return {
    out: (chunk: string): void => {
      out.push(chunk);
    },
    err: (chunk: string): void => {
      err.push(chunk);
    },
    lines: () => out.join(""),
    errText: () => err.join(""),
  };
}

interface FakeErrorStream {
  handlers: Array<(error: Error) => void>;
  removed: number;
  stream: {
    on(event: string, handler: (error: Error) => void): void;
    removeListener(): void;
  };
  emitError(): void;
}

function fakeErrorStream(): FakeErrorStream {
  const handlers: Array<(error: Error) => void> = [];
  let removedCount = 0;
  return {
    handlers,
    get removed() {
      return removedCount;
    },
    stream: {
      on: (_event: string, handler: (error: Error) => void): void => {
        handlers.push(handler);
      },
      removeListener: (): void => {
        removedCount += 1;
      },
    },
    emitError: (): void => {
      for (const handler of handlers) handler(new Error("EPIPE"));
    },
  };
}

// --- Task 2.1: injectable sinks around the single redacted record -----------

test("a sink receives exactly one redacted record independent of the persisted row", () => {
  const store = memoryStore();
  const records: LogRecord[] = [];
  const logger = new Logger({
    level: "debug",
    secrets: [SECRET],
    db: store.db,
    sink: (record) => records.push(record),
  });
  logger.warn("status reaction failed", {
    jobId: 7,
    attemptId: 3,
    detail: `token was ${SECRET} ok`,
  });

  assert.equal(records.length, 1);
  const record = records[0];
  assert.equal(record.event, "status reaction failed");
  assert.equal(record.jobId, 7);
  assert.equal(record.attemptId, 3);
  assert.equal(record.fields.detail, `token was ${REDACTED} ok`);
  assert.ok(!JSON.stringify(record).includes(SECRET));

  const row = store.db
    .prepare("SELECT event, job_id, attempt_id, fields FROM log_entries")
    .get() as { event: string; job_id: number; attempt_id: number; fields: string };
  assert.equal(row.event, "status reaction failed");
  assert.equal(row.job_id, 7);
  assert.equal(row.attempt_id, 3);
  assert.equal((JSON.parse(row.fields) as { detail: string }).detail, `token was ${REDACTED} ok`);
  store.close();
});

test("a malicious sink cannot mutate the persisted record", () => {
  const store = memoryStore();
  const logger = new Logger({
    level: "info",
    secrets: [SECRET],
    db: store.db,
    sink: (record) => {
      record.event = "spoofed event";
      record.fields.detail = "hacked";
      (record.fields as Record<string, unknown>).extra = 999;
      (record as { jobId?: number }).jobId = 12345;
    },
  });
  assert.doesNotThrow(() =>
    logger.info("agent launched", { jobId: 1, detail: `token was ${SECRET}` }),
  );
  const row = store.db.prepare("SELECT event, job_id, fields FROM log_entries").get() as {
    event: string;
    job_id: number;
    fields: string;
  };
  assert.equal(row.event, "agent launched");
  assert.equal(row.job_id, 1);
  const fields = JSON.parse(row.fields) as { detail: string; extra?: unknown };
  assert.equal(fields.detail, `token was ${REDACTED}`);
  assert.equal(fields.extra, undefined);
  store.close();
});

test("log level filters records reaching both sink and store together", () => {
  const store = memoryStore();
  const records: LogRecord[] = [];
  const logger = new Logger({
    level: "warn",
    secrets: [],
    db: store.db,
    sink: (record) => records.push(record),
  });
  logger.info("not emitted");
  logger.warn("emitted");

  assert.deepEqual(
    records.map((r) => r.event),
    ["emitted"],
  );
  const rows = store.db.prepare("SELECT event FROM log_entries").all() as { event: string }[];
  assert.deepEqual(
    rows.map((r) => r.event),
    ["emitted"],
  );
  store.close();
});

test("a throwing sink never prevents persistence or throws from the log call", () => {
  const store = memoryStore();
  const logger = new Logger({
    level: "info",
    secrets: [],
    db: store.db,
    sink: () => {
      throw new Error("presentation broken");
    },
  });
  assert.doesNotThrow(() => logger.info("persisted anyway", { jobId: 9 }));
  const rows = store.db.prepare("SELECT event FROM log_entries").all() as { event: string }[];
  assert.deepEqual(
    rows.map((r) => r.event),
    ["persisted anyway"],
  );
  store.close();
});

test("the default sink writes the legacy JSON shape to stderr", () => {
  const store = memoryStore();
  const written: string[] = [];
  const original = process.stderr.write.bind(process.stderr);
  (process.stderr as unknown as { write: (...args: unknown[]) => boolean }).write = (
    chunk: unknown,
  ): boolean => {
    written.push(String(chunk));
    return true;
  };
  try {
    const logger = new Logger({ level: "info", secrets: [], db: store.db });
    logger.info("job queued", { jobId: 5 });
  } finally {
    (process.stderr as unknown as { write: unknown }).write = original;
    store.close();
  }

  assert.equal(written.length, 1);
  const parsed = JSON.parse(written[0]?.trim() ?? "") as {
    at: string;
    level: string;
    event: string;
    jobId: number;
  };
  assert.equal(parsed.level, "info");
  assert.equal(parsed.event, "job queued");
  assert.equal(parsed.jobId, 5);
  assert.ok(typeof parsed.at === "string");
});

test("formatJsonRecord and the stderr sink preserve the legacy shape", () => {
  const record: LogRecord = {
    at: iso(0),
    level: "error",
    event: "job failed",
    jobId: 4,
    attemptId: 1,
    fields: { repository: "owner/repo" },
  };
  assert.deepEqual(JSON.parse(formatJsonRecord(record)), {
    at: iso(0),
    level: "error",
    event: "job failed",
    jobId: 4,
    attemptId: 1,
    repository: "owner/repo",
  });
  const lines: string[] = [];
  createJsonStderrSink({ write: (chunk) => lines.push(chunk) })(record);
  assert.equal(lines.length, 1);
  assert.equal(lines[0], `${formatJsonRecord(record)}\n`);
});

// --- Task 2.2: bounded plain presentation through a single owner ------------

test("formatPlainRecord emits one sanitized, bounded line free of control characters", () => {
  const record: LogRecord = {
    at: iso(0),
    level: "error",
    event: `poll failed\u001b[31m\u202e`,
    jobId: 1,
    fields: {
      repository: "evil\nrepo\u0007",
      message: "\u001b]0;title\u0007",
      nested: { secret: REDACTED },
    },
  };
  const line = formatPlainRecord(record);
  assert.ok(!line.includes("\u001b"), "ESC must be stripped");
  assert.ok(!line.includes("\u0007"), "BEL must be stripped");
  assert.ok(!line.includes("\u202e"), "bidi must be stripped");
  assert.ok(!line.includes("\n") && !line.includes("\r"), "single line output");
  assert.match(line, /ERROR poll failed/);
  assert.match(line, /job=1/);
  assert.ok(!line.includes(SECRET));
  assert.ok(line.includes(REDACTED), "already-redacted values survive plain formatting");
});

test("formatPlainRecord caps the event, keys, timestamp and the whole line", () => {
  const hugeKey = "k".repeat(200);
  const record: LogRecord = {
    at: iso(0),
    level: "error",
    event: "E".repeat(10_000),
    fields: { [hugeKey]: "v".repeat(10_000) },
  };
  const line = formatPlainRecord(record);
  assert.ok(line.length <= MAX_PLAIN_LINE, `whole line must be bounded (got ${line.length})`);
  assert.ok(!line.includes("E".repeat(200)), "event is truncated");
  assert.ok(!line.includes("k".repeat(100)), "field keys are truncated");
  assert.ok(!line.includes("v".repeat(600)), "field values are truncated");
});

test("sanitizePlainText neutralizes control and bidirectional characters", () => {
  assert.equal(sanitizePlainText("a\u001b[31mb\u0007c\nd\r"), "a [31mb c d ");
  assert.equal(
    sanitizePlainText("\u202esudo rm -rf\u202c other\u2066\u2069"),
    " sudo rm -rf  other  ",
  );
  assert.ok(!sanitizePlainText("\u061c\u200f\u202a\u2066x\u2069\u202c").includes("\u202a"));
});

test("plain sink shows warnings, errors and start transitions but suppresses recurring ingest/poll noise", () => {
  const lines: string[] = [];
  const sink = createPlainSink((line) => lines.push(line));
  sink({ at: iso(0), level: "info", event: "orchestrator started", fields: { repositories: 2 } });
  sink({ at: iso(10), level: "info", event: "event observed", fields: { pr: 12 } });
  sink({ at: iso(20), level: "info", event: "command parsed", fields: { command: "run" } });
  sink({
    at: iso(30),
    level: "info",
    event: "workspace reclamation sweep",
    fields: { candidates: 0 },
  });
  sink({
    at: iso(40),
    level: "info",
    event: "artifact retention sweep",
    fields: { removedBytes: 0 },
  });
  sink({ at: iso(50), level: "warn", event: "status reaction failed", fields: {} });
  sink({ at: iso(60), level: "error", event: "job failed", fields: { jobId: 1 } });

  assert.equal(lines.length, 3);
  assert.match(lines[0], /INFO orchestrator started/);
  assert.match(lines[1], /WARN status reaction failed/);
  assert.match(lines[2], /ERROR job failed/);
  for (const line of lines) {
    assert.ok(!line.includes("\u001b") && !line.includes("\u0007"));
  }
});

test("plain sink keeps warnings/errors visible when repeated and bounds informational duplicates", () => {
  const lines: string[] = [];
  const sink = createPlainSink((line) => lines.push(line));
  // Warnings and errors are always visible, even when identically repeated.
  sink({ at: iso(0), level: "warn", event: "activity snapshot failed", fields: { jobId: 1 } });
  sink({ at: iso(10), level: "warn", event: "activity snapshot failed", fields: { jobId: 1 } });
  assert.equal(lines.length, 2);

  // Identical informational transitions are deduplicated by a bounded cache.
  sink({ at: iso(20), level: "info", event: "job queued", fields: { jobId: 5 } });
  sink({ at: iso(30), level: "info", event: "job queued", fields: { jobId: 5 } });
  sink({ at: iso(40), level: "info", event: "job queued", fields: { jobId: 5 } });
  assert.equal(lines.length, 3);

  // A changed signature is visible again.
  sink({ at: iso(50), level: "info", event: "job queued", fields: { jobId: 6 } });
  assert.equal(lines.length, 4);

  // The cache is bounded: after 17 distinct infos the oldest is evicted.
  for (let i = 0; i < 17; i++)
    sink({ at: iso(60 + i), level: "info", event: `start ${i}`, fields: {} });
  assert.equal(lines.length, 4 + 17);
  sink({ at: iso(200), level: "info", event: "start 0", fields: {} });
  assert.equal(lines.length, 4 + 17 + 1);
});

test("plain visibility keeps debug chatter out and warnings in", () => {
  assert.equal(isPlainVisible({ at: iso(0), level: "debug", event: "trace", fields: {} }), false);
  assert.equal(
    isPlainVisible({
      at: iso(0),
      level: "warn",
      event: "workspace reclamation sweep failed",
      fields: {},
    }),
    true,
  );
  assert.equal(
    isPlainVisible({ at: iso(0), level: "info", event: "job queued", fields: {} }),
    true,
  );
});

// --- Task 2.3: read-only tail entrypoint ------------------------------------

test("tail argument parsing applies defaults and rejects unknown options", () => {
  const parsed = parseTailArgs([]);
  assert.equal(parsed.ok, true);
  if (parsed.ok) {
    assert.equal(parsed.options.dataDir, DEFAULT_DATA_DIR);
    assert.equal(parsed.options.dataDir, ".gremlyn");
    assert.equal(parsed.options.tail, 100);
    assert.equal(parsed.options.format, "plain");
    assert.equal(parsed.options.follow, false);
  }

  assert.equal(parseTailArgs(["--bogus"]).ok, false);
  const badFormat = parseTailArgs(["--format", "xml"]);
  assert.equal(badFormat.ok, false);
  assert.equal(parseTailArgs(["--tail", "zero"]).ok, false);
  assert.equal(parseTailArgs(["--tail", "0"]).ok, false);

  const capped = parseTailArgs(["--tail", "999999"]);
  assert.equal(capped.ok, true);
  if (capped.ok) assert.equal(capped.options.tail, MAX_TAIL);

  const explicit = parseTailArgs([
    "--data-dir",
    "custom",
    "--tail",
    "5",
    "--format",
    "json",
    "--follow",
  ]);
  assert.equal(explicit.ok, true);
  if (explicit.ok) {
    assert.equal(explicit.options.dataDir, "custom");
    assert.equal(explicit.options.tail, 5);
    assert.equal(explicit.options.format, "json");
    assert.equal(explicit.options.follow, true);
  }
});

test("CLI errors sanitize control/bidi characters and stay bounded", () => {
  const evil = `\u001b[31mx\u202e\u0007${"A".repeat(500)}`;
  const badFormat = parseTailArgs(["--format", evil]);
  assert.equal(badFormat.ok, false);
  if (!badFormat.ok) {
    assert.ok(!badFormat.message.includes("\u001b"), "ESC must be stripped from CLI errors");
    assert.ok(!badFormat.message.includes("\u0007"), "BEL must be stripped from CLI errors");
    assert.ok(!badFormat.message.includes("\u202e"), "bidi must be stripped from CLI errors");
    assert.ok(
      badFormat.message.length < 400,
      `CLI error must stay bounded (${badFormat.message.length})`,
    );
  }
  const badTail = parseTailArgs(["--tail", `0\u001b`]);
  assert.equal(badTail.ok, false);
  if (!badTail.ok) assert.ok(!badTail.message.includes("\u001b"));
});

test("help documents the read-only guarantee and the default data directory", async () => {
  const io = captureIo();
  const code = await runTail(["--help"], io);
  assert.equal(code, 0);
  assert.ok(io.lines().includes(".gremlyn"), "help must document the default data directory");
  assert.ok(io.lines().includes("read-only"), "help must document the read-only guarantee");
  assert.ok(LOGS_HELP.includes(".gremlyn"));
});

test("tail on a missing store fails safely and never creates a database", async () => {
  const dir = mkdtempSync(join(tmpdir(), `gremlyn-empty-${randomUUID()}`));
  const io = captureIo();
  const code = await runTail(["--data-dir", dir, "--tail", "10"], io);
  assert.equal(code, 1);
  assert.match(io.errText(), /cannot (open|read)/);
  assert.equal(
    existsSync(join(dir, "gremlyn.db")),
    false,
    "read-only tail must not create the store",
  );
  assert.equal(existsSync(join(dir, ".gremlyn.lock")), false, "tail must not touch ownership");
});

test("tail on a busy store reports a bounded safe error without creating a database", async () => {
  const dir = mkdtempSync(join(tmpdir(), `gremlyn-busy-${randomUUID()}`));
  const file = join(dir, "gremlyn.db");
  const writer = new Database(file);
  writer.exec("PRAGMA journal_mode = DELETE");
  writer.exec(
    "CREATE TABLE log_entries (id INTEGER PRIMARY KEY, at TEXT, level TEXT, event TEXT, job_id INTEGER, attempt_id INTEGER, fields TEXT)",
  );
  writer.exec("BEGIN EXCLUSIVE");
  try {
    const io = captureIo();
    const code = await runTail(["--data-dir", dir, "--tail", "5"], io);
    assert.equal(code, 1);
    assert.match(io.errText(), /busy/);
  } finally {
    writer.exec("ROLLBACK");
    writer.close();
  }
});

test("tail prints the newest bounded records in ascending order for both formats", async () => {
  const dir = seededDataDir([
    ["info", "orchestrator started", {}],
    ["warn", "status reaction failed", { jobId: 1 }],
    ["error", "job failed", { jobId: 2, attemptId: 1 }],
  ]);

  const json = captureIo();
  const jsonCode = await runTail(["--data-dir", dir, "--tail", "2", "--format", "json"], json);
  assert.equal(jsonCode, 0);
  const parsedJson = json
    .lines()
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line) as { level: string; event: string });
  assert.equal(parsedJson.length, 2);
  assert.deepEqual(
    parsedJson.map((p) => p.event),
    ["status reaction failed", "job failed"],
  );

  const plain = captureIo();
  const plainCode = await runTail(["--data-dir", dir, "--tail", "2", "--format", "plain"], plain);
  assert.equal(plainCode, 0);
  const plainLines = plain.lines().trim().split("\n");
  assert.equal(plainLines.length, 2);
  assert.match(plainLines[1] ?? "", /ERROR job failed/);
  assert.ok(!plainLines.join("").includes("\u001b"));
});

test("tail reads only redacted persisted records (secrets are not re-emitted)", async () => {
  const dir = seededDataDir([["info", "orchestrator started", { detail: `token ${SECRET}` }]]);
  const io = captureIo();
  const code = await runTail(["--data-dir", dir, "--format", "json"], io);
  assert.equal(code, 0);
  assert.ok(!io.lines().includes(SECRET), "persisted records must stay redacted");
  assert.ok(io.lines().includes(REDACTED), "redaction placeholder must survive persistence");
  assert.ok(io.lines().includes("orchestrator started"));
});

test("tail bound reads and forward batches respect their limits", async () => {
  const dir = seededDataDir(
    Array.from({ length: 6 }, (_, index) => ["info", `event ${index + 1}`, {}] as const),
  );
  const db = openReadOnlyLogDatabase(dir);
  try {
    assert.equal(readTailRecords(db, 2).length, 2);
    assert.equal(readTailRecords(db, 10_000).length, 6);
    assert.deepEqual(
      readRecordsAfter(db, 3, 2).records.map((r) => r.event),
      ["event 4", "event 5"],
    );
    assert.equal(readRecordsAfter(db, 3, 2).lastId, 5);
    assert.equal(readTailRecords(db, 1, 3).length, 1);
    assert.equal(readTailRecords(db, 1, 3)[0]?.event, "event 3");
  } finally {
    db.close();
  }
});

test("read functions clamp negative and non-finite limits to hard finite bounds", async () => {
  const dir = seededDataDir(
    Array.from({ length: 3 }, (_, index) => ["info", `event ${index + 1}`, {}] as const),
  );
  const db = openReadOnlyLogDatabase(dir);
  try {
    assert.equal(readTailRecords(db, -5).length, 0, "negative tail must not become unlimited");
    assert.equal(readTailRecords(db, Number.NaN).length, 3);
    assert.equal(readTailRecords(db, Number.POSITIVE_INFINITY).length, 3);
    assert.deepEqual(readRecordsAfter(db, 3, -1), { records: [], lastId: 3 });
    assert.equal(readRecordsAfter(db, 0, Number.NaN).records.length, 3);
    assert.equal(readRecordsAfter(db, -10, 2).records.length, 2);
  } finally {
    db.close();
  }
});

test("follow mode starts from a baseline, reads new records, and disposes idempotently", () => {
  const dir = seededDataDir([
    ["info", "orchestrator started", {}],
    ["info", "job queued", { jobId: 1 }],
  ]);
  const db = openReadOnlyLogDatabase(dir);
  const out: string[] = [];
  let cancelCalls = 0;
  const handle = Symbol("follow-timer");

  const session = followLogRecords(db, "plain", (line) => out.push(line), {
    schedule: (_fn) => {
      return handle;
    },
    cancelSchedule: () => {
      cancelCalls += 1;
    },
  });

  assert.equal(out.length, 0, "existing history is never replayed");
  session.poll();
  assert.equal(out.length, 0, "no new rows yet");

  const writer = new Database(join(dir, "gremlyn.db"));
  writer
    .prepare("INSERT INTO log_entries (at, level, event, job_id) VALUES (?, ?, ?, ?)")
    .run(iso(0), "info", "job completed", 3);
  writer.close();

  session.poll();
  assert.equal(out.length, 1);
  assert.match(out[0] ?? "", /INFO job completed/);

  session.dispose();
  session.dispose();
  assert.equal(cancelCalls, 1, "disposal must be idempotent");
  db.close();
});

test("follow reports read failures with bounded rate-limited feedback, not silence", () => {
  const dir = seededDataDir([
    ["info", "orchestrator started", {}],
    ["info", "job queued", { jobId: 1 }],
  ]);
  const db = openReadOnlyLogDatabase(dir);
  const errors: string[] = [];
  const session = followLogRecords(db, "plain", () => undefined, {
    schedule: (_fn) => {
      return Symbol("follow-timer");
    },
    cancelSchedule: () => {},
    onError: (message) => errors.push(message),
    batchLimit: 5,
  });
  db.close(); // subsequent reads fail
  session.poll();
  session.poll(); // identical message inside the rate-limit window is suppressed
  session.dispose();
  assert.equal(errors.length, 1, "repeated identical failures are rate-limited");
  assert.match(errors[0] ?? "", /follow read failed/);
});

test("runTail follows the snapshot baseline so a record appended during tail output is shown exactly once", async () => {
  const dir = seededDataDir([
    ["info", "orchestrator started", {}],
    ["info", "job queued", { jobId: 1 }],
  ]);
  const out: string[] = [];
  let tick: (() => void) | undefined;
  let resolveStop!: () => void;
  const stop = new Promise<void>((resolve) => {
    resolveStop = resolve;
  });
  let appended = false;
  const io = {
    err: () => {},
    waitForStop: () => stop,
    followSchedule: (fn: () => void) => {
      tick = fn;
      return Symbol("follow-timer");
    },
    followCancelSchedule: () => {},
    out: (chunk: string): void => {
      out.push(chunk);
      if (!appended) {
        appended = true;
        const writer = new Database(join(dir, "gremlyn.db"));
        writer
          .prepare("INSERT INTO log_entries (at, level, event, job_id) VALUES (?, ?, ?, ?)")
          .run(iso(0), "info", "job completed", 3);
        writer.close();
      }
    },
  };

  const codePromise = runTail(
    ["--data-dir", dir, "--tail", "5", "--follow", "--format", "plain"],
    io,
  );
  assert.equal(out.filter((line) => line.includes("orchestrator started")).length, 1);
  assert.equal(out.filter((line) => line.includes("job queued")).length, 1);
  assert.equal(out.filter((line) => line.includes("job completed")).length, 0);

  tick?.();
  assert.equal(
    out.filter((line) => line.includes("job completed")).length,
    1,
    "appended row shown once",
  );
  tick?.();
  assert.equal(out.filter((line) => line.includes("job completed")).length, 1, "never replayed");
  resolveStop();
  const code = await codePromise;
  assert.equal(code, 0);
});

test("runTail disposes, reports and exits nonzero when the output stream errors (EPIPE)", async () => {
  const signalCounts = ["SIGINT", "SIGTERM", "SIGHUP", "SIGBREAK"].map((signal) =>
    process.listenerCount(signal),
  );
  const dir = seededDataDir([
    ["info", "orchestrator started", {}],
    ["info", "job queued", { jobId: 1 }],
  ]);
  const fakeStream = fakeErrorStream();
  const errText: string[] = [];
  let tick: (() => void) | undefined;
  const io = {
    err: (chunk: string): void => {
      errText.push(chunk);
    },
    outputStream: fakeStream.stream,
    followSchedule: (fn: () => void) => {
      tick = fn;
      return Symbol("follow-timer");
    },
    followCancelSchedule: () => {},
    out: (_chunk: string): void => {
      // First write simulates the broken destination erroring asynchronously.
      fakeStream.emitError();
      tick?.();
    },
  };

  // Follow mode: no caller-supplied wait; only the output error should let it
  // stop (no hanging), dispose listeners/store, and exit nonzero.
  const code = await runTail(["--data-dir", dir, "--tail", "5", "--follow"], io);
  assert.equal(code, 1, "broken output must exit nonzero");
  assert.ok(
    errText.some((chunk) => chunk.includes("output failed")),
    "failure must be reported",
  );
  assert.equal(fakeStream.removed, 1, "error listener must be disposed exactly once");
  assert.deepEqual(
    ["SIGINT", "SIGTERM", "SIGHUP", "SIGBREAK"].map((signal) => process.listenerCount(signal)),
    signalCounts,
    "output-error races must remove the losing signal listeners",
  );
});

test("one-shot tail keeps its error listener through the final buffered output flush", async () => {
  const dir = seededDataDir([["info", "job completed", {}]]);
  const fakeStream = fakeErrorStream();
  const code = await runTail(["--data-dir", dir], {
    out: () => undefined,
    err: () => undefined,
    outputStream: fakeStream.stream,
    flush: async () => {
      fakeStream.emitError();
    },
  });
  assert.equal(code, 1);
  assert.equal(fakeStream.removed, 1);
});

test("known credentials with JSON escapes redact in nested fields without damaging record syntax", () => {
  const db = new Store({ dataDir: ".", file: ":memory:" }).db;
  const records: LogRecord[] = [];
  const secret = 'fixture-only-"quoted\\token\nvalue';
  const logger = new Logger({
    level: "info",
    secrets: [secret],
    db,
    sink: (record) => {
      records.push(record);
    },
  });
  try {
    logger.info("credential fixture", { nested: [secret, { [secret]: secret }] });
    assert.deepEqual(records[0]!.fields, {
      nested: ["[redacted]", { "[redacted]": "[redacted]" }],
    });
    const row = db.prepare("SELECT fields FROM log_entries").get() as { fields: string };
    assert.deepEqual(JSON.parse(row.fields), records[0]!.fields);
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    assert.doesNotThrow(() => logger.warn("unserializable fixture", circular));
    assert.deepEqual(records[1]!.fields, { diagnostic: "log fields unavailable" });
  } finally {
    db.close();
  }
});
