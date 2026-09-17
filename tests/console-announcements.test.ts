import { test } from "node:test";
import assert from "node:assert/strict";
import { AnnouncementDeduper } from "../src/console/announcements.js";

test("console announcements deduplicate repeated semantic events but allow transitions", () => {
  const deduper = new AnnouncementDeduper();
  const connected = deduper.next("connection", "connected", "Live updates connected.");
  assert.ok(connected);
  assert.equal(deduper.next("connection", "connected", "Live updates connected."), undefined);
  assert.deepEqual(deduper.next("connection", "reconnecting", "Live updates reconnecting."), {
    channel: "connection",
    eventKey: "reconnecting",
    message: "Live updates reconnecting.",
    priority: "polite",
  });
  assert.deepEqual(deduper.next("action", "reset:failed", "Action failed.", "assertive"), {
    channel: "action",
    eventKey: "reset:failed",
    message: "Action failed.",
    priority: "assertive",
  });
  assert.equal(deduper.next("action", "reset:failed", "Action failed.", "assertive"), undefined);
});

test("announcement deduplication stays bounded", () => {
  const deduper = new AnnouncementDeduper(2);
  assert.ok(deduper.next("operational", "one", "One"));
  assert.ok(deduper.next("operational", "two", "Two"));
  assert.ok(deduper.next("operational", "three", "Three"));
  assert.ok(deduper.next("operational", "one", "One"));
});
