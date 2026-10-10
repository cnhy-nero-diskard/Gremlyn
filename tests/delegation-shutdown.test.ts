import { test } from "node:test";
import assert from "node:assert/strict";
import { createShutdownHandler } from "../src/index.js";

test("daemon shutdown stops observation before streams and storage without cancelling work", async () => {
  const calls: string[] = [];
  const stop = createShutdownHandler({
    clearTimer: () => {
      calls.push("timer");
    },
    stopObservation: () => {
      calls.push("observer");
    },
    endStreams: () => {
      calls.push("streams");
    },
    closeConsole: async () => {
      calls.push("console");
    },
    closeStore: () => {
      calls.push("store");
    },
    release: () => {
      calls.push("release");
    },
  });
  await stop();
  assert.deepEqual(calls, ["timer", "observer", "streams", "console", "store"]);
});

test("observer disposal failure cannot suppress daemon shutdown", async () => {
  const calls: string[] = [];
  const stop = createShutdownHandler({
    clearTimer: () => {
      calls.push("timer");
    },
    stopObservation: () => {
      throw new Error("telemetry helper failure");
    },
    endStreams: () => {
      calls.push("streams");
    },
    closeConsole: async () => {
      calls.push("console");
    },
    closeStore: () => {
      calls.push("store");
    },
    release: () => {
      calls.push("release");
    },
  });
  await stop();
  assert.deepEqual(calls, ["timer", "streams", "console", "store"]);
});
