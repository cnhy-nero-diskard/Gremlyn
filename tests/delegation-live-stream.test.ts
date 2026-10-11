import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer, type ServerResponse } from "node:http";
import { watchJobFragments } from "./helpers/delegation-live-stream.js";

test(
  "live acceptance reader receives running then terminal fragments without a second connection",
  { timeout: 5_000 },
  async () => {
    let connections = 0;
    let response: ServerResponse | undefined;
    const frame = (state: string): string =>
      `event: job-update\ndata: ${JSON.stringify({
        kind: "change",
        fragments: { "job-detail-region": `<span>${state}</span>` },
      })}\n\n`;
    const server = createServer((req, res) => {
      connections += 1;
      assert.equal(req.url, "/jobs/42/stream");
      assert.equal(req.headers.authorization, "Bearer fixture-console-token");
      res.writeHead(200, { "content-type": "text/event-stream" });
      response = res;
      res.write(frame("running"));
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    assert.ok(address !== null && typeof address !== "string");
    const fragments: string[] = [];
    let terminalSeen!: () => void;
    const terminal = new Promise<void>((resolve) => {
      terminalSeen = resolve;
    });
    const watcher = watchJobFragments({
      port: address.port,
      jobId: 42,
      token: "fixture-console-token",
      onFragment: (html) => {
        fragments.push(html);
        if (html.includes("succeeded")) terminalSeen();
      },
    });
    try {
      await watcher.ready;
      assert.ok(response);
      const update = frame("succeeded");
      response.write(": keepalive\n\n");
      response.write(update.slice(0, 10));
      response.write(update.slice(10));
      await terminal;
      assert.deepEqual(fragments, ["<span>running</span>", "<span>succeeded</span>"]);
      assert.equal(connections, 1);
      assert.deepEqual(watcher.errors, []);
    } finally {
      watcher.close();
      response?.destroy();
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    }
  },
);
