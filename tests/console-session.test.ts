import { test } from "node:test";
import assert from "node:assert/strict";
import { ConsoleSessionStore, CONSOLE_SESSION_TTL_MS } from "../src/console/session.js";
import { buildConsoleServer, type ConsoleOptions } from "../src/console/server.js";
import { OperatorActionStore } from "../src/store/actions.js";
import { Store } from "../src/store/db.js";

test("console sessions are opaque, absolute, revocable, lazily pruned, and process-local", () => {
  let now = 10_000;
  let random = 0;
  const store = new ConsoleSessionStore({
    now: () => now,
    randomBytes: (size) => new Uint8Array(size).fill(random++),
  });

  const first = store.create();
  assert.equal(first.expiresAt, now + CONSOLE_SESSION_TTL_MS);
  assert.notEqual(first.handle, "console-token");
  assert.equal(store.snapshot().length, 1);
  assert.equal(store.snapshot()[0]?.digest.includes("console-token"), false);
  assert.equal(store.validate(first.handle), true);

  assert.equal(store.revoke(first.handle), true);
  assert.equal(store.validate(first.handle), false);

  const second = store.create();
  now += CONSOLE_SESSION_TTL_MS;
  assert.equal(store.lookup(second.handle), "expired");
  assert.equal(store.size, 0);

  const third = store.create();
  store.clear();
  assert.equal(store.validate(third.handle), false);
});

function authOptions(now: () => number, sessionStore?: ConsoleSessionStore): ConsoleOptions {
  const store = new Store({ dataDir: ".", file: ":memory:" });
  return {
    db: store.db,
    token: "console-token",
    secrets: [],
    operatorActions: new OperatorActionStore(store.db),
    now,
    sessionStore,
  };
}

test("browser auth uses an opaque cookie, form POST, status probing, and sign-out", async () => {
  const now = 100;
  const sessionStore = new ConsoleSessionStore({
    now: () => now,
    randomBytes: (size) => new Uint8Array(size).fill(7),
  });
  const options = authOptions(() => now, sessionStore);
  const app = buildConsoleServer(options);

  const signedIn = await app.inject({
    method: "POST",
    url: "/auth",
    headers: { "content-type": "application/x-www-form-urlencoded", accept: "text/html" },
    payload: "token=console-token",
  });
  assert.equal(signedIn.statusCode, 303);
  assert.equal(signedIn.headers.location, "/");
  const cookie = String(signedIn.headers["set-cookie"]);
  assert.match(cookie, /^gremlyn_console_session=/u);
  assert.match(cookie, /HttpOnly/u);
  assert.match(cookie, /SameSite=Strict/u);
  assert.match(cookie, /Path=\//u);
  assert.match(cookie, /Max-Age=28800/u);
  assert.equal(cookie.includes("console-token"), false);

  const handleCookie = cookie.split(";", 1)[0];
  const page = await app.inject({
    method: "GET",
    url: "/",
    headers: { cookie: handleCookie, accept: "text/html" },
  });
  assert.equal(page.statusCode, 200);
  assert.equal(page.body.includes("console-token"), false);

  const bearer = await app.inject({
    method: "GET",
    url: "/",
    headers: { authorization: "Bearer console-token" },
  });
  assert.equal(bearer.statusCode, 200);
  assert.equal(bearer.headers["set-cookie"], undefined);

  const status = await app.inject({
    method: "GET",
    url: "/session-status",
    headers: { cookie: handleCookie },
  });
  assert.deepEqual(status.json(), { status: "active" });

  const signedOut = await app.inject({
    method: "POST",
    url: "/auth/sign-out",
    headers: { cookie: handleCookie, accept: "text/html" },
  });
  assert.equal(signedOut.statusCode, 303);
  assert.equal(signedOut.headers.location, "/auth?reason=signed-out");
  assert.match(String(signedOut.headers["set-cookie"]), /Max-Age=0/u);

  const refused = await app.inject({ method: "GET", url: "/", headers: { cookie: handleCookie } });
  assert.equal(refused.statusCode, 303);
  assert.equal(refused.headers.location, "/auth?reason=expired");

  await app.close();
  const store = options.db;
  store.close();
});

test("expired sessions are bounded to non-secret status and secure cookies follow HTTPS", async () => {
  let now = 0;
  const options = authOptions(() => now);
  const app = buildConsoleServer({
    ...options,
    randomBytes: (size) => new Uint8Array(size).fill(3),
  });
  const signedIn = await app.inject({
    method: "POST",
    url: "/auth",
    headers: {
      "content-type": "application/json",
      "x-forwarded-proto": "https",
    },
    payload: { token: "console-token" },
  });
  assert.equal(signedIn.statusCode, 200);
  const cookie = String(signedIn.headers["set-cookie"]).split(";", 1)[0];
  assert.match(String(signedIn.headers["set-cookie"]), /Secure/u);

  now = CONSOLE_SESSION_TTL_MS;
  const status = await app.inject({ method: "GET", url: "/session-status", headers: { cookie } });
  assert.deepEqual(status.json(), { status: "expired" });
  assert.equal(status.body.includes("console-token"), false);
  assert.equal(status.body.includes(cookie.split("=", 2)[1] ?? "never"), false);

  await app.close();
  options.db.close();
});
