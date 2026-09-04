import { test } from "node:test";
import assert from "node:assert/strict";
import {
  bundledProviderCatalog,
  catalogFromFeaturedFeed,
  ProviderCatalog,
} from "../src/agent/provider-catalog.js";

test("bundled provider catalog exposes current Cline, Codex, and OpenCode choices", () => {
  const catalog = bundledProviderCatalog();
  const cline = catalog.providers.find((provider) => provider.id === "cline");
  const pass = catalog.providers.find((provider) => provider.id === "cline-pass");
  const codex = catalog.providers.find((provider) => provider.id === "openai-codex");
  const opencode = catalog.providers.find((provider) => provider.id === "opencode");
  const opencodeGo = catalog.providers.find((provider) => provider.id === "opencode-go");
  assert.ok(cline);
  assert.ok(pass);
  assert.ok(codex);
  assert.ok(opencode);
  assert.ok(opencodeGo);
  assert.ok(cline.models.some((model) => model.id === "moonshotai/kimi-k3"));
  assert.ok(pass.models.some((model) => model.id === "cline-pass/kimi-k3"));
  assert.deepEqual(
    codex.models.map((model) => model.id),
    [
      "gpt-5.6-sol",
      "gpt-5.6-terra",
      "gpt-5.6-luna",
      "gpt-5.6",
      "gpt-5.5",
      "gpt-5.4",
      "gpt-5.4-mini",
    ],
  );
  assert.equal(opencode.defaultModelId, "opencode/claude-sonnet-5");
  assert.ok(opencode.models.every((model) => model.id.startsWith("opencode/")));
  assert.ok(opencode.models.some((model) => model.id === "opencode/claude-sonnet-5"));
  // The whole `opencode models opencode` surface, not a shortlist: a repo can
  // be pointed at any Zen model without falling back to "Custom provider".
  assert.equal(opencode.models.length, 64);
  assert.equal(new Set(opencode.models.map((model) => model.id)).size, 64);
  // Zen's `-free` suffix is the one badge derived from the id.
  assert.ok(
    opencode.models
      .filter((model) => model.id.endsWith("-free"))
      .every((model) => model.tier === "free"),
  );
  // Each entry names the executor kinds it serves, so the console can filter
  // the picker by a repository's agent kind.
  assert.deepEqual(cline.kinds, ["cline"]);
  assert.deepEqual(pass.kinds, ["cline"]);
  assert.deepEqual(codex.kinds, ["cline"]);
  assert.deepEqual(opencode.kinds, ["opencode"]);
  // OpenCode Go is a second namespace on the same executor, so it must share
  // the kind: the picker filters by kind, and a Go-only entry that claimed
  // some other kind would be invisible to every OpenCode repository.
  assert.deepEqual(opencodeGo.kinds, ["opencode"]);
  // The whole `opencode models` Go surface, on the pinned release.
  assert.equal(opencodeGo.defaultModelId, "opencode-go/kimi-k3");
  assert.ok(opencodeGo.models.every((model) => model.id.startsWith("opencode-go/")));
  assert.equal(opencodeGo.models.length, 27);
  assert.equal(new Set(opencodeGo.models.map((model) => model.id)).size, 27);
  // Go's roster is not Zen's: models reachable only through the subscription
  // are exactly what the Zen-only catalog left unselectable.
  const zenIds = new Set(opencode.models.map((model) => model.id.split("/").at(-1)));
  for (const goOnly of ["glm-5.3", "longcat-2.0", "hy3", "qwen3.7-max", "qwen3.8-max"]) {
    assert.ok(
      opencodeGo.models.some((model) => model.id === `opencode-go/${goOnly}`),
      `expected Go to serve ${goOnly}`,
    );
    assert.ok(!zenIds.has(goOnly), `${goOnly} is Go-only; Zen must not list it`);
  }
  // Every Go model comes with the subscription, so the badge is uniform
  // rather than derived from Zen's `-free` suffix (which Go never uses).
  assert.ok(opencodeGo.models.every((model) => model.tier === "subscribed"));
  assert.ok(!opencodeGo.models.some((model) => model.id.endsWith("-free")));
});

test("OpenCode Go survives a live Cline feed refresh", async () => {
  // The Cline feed rebuilds the whole snapshot, so a namespace that exists
  // only in the bundled fallback would vanish the moment the console
  // refreshed — leaving the Go models selectable offline and nowhere else.
  const catalog = new ProviderCatalog({
    fetcher: async () =>
      new Response(JSON.stringify({ recommended: [{ id: "example/new-model" }] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    now: () => 1,
  });
  const snapshot = await catalog.refreshIfStale(true);
  assert.equal(snapshot.source, "cline-api");
  const go = snapshot.providers.find((provider) => provider.id === "opencode-go");
  assert.ok(go);
  assert.equal(go.models.length, 27);
});

test("model names humanize dashed version suffixes and known initialisms", () => {
  const opencode = bundledProviderCatalog().providers.find(
    (provider) => provider.id === "opencode",
  );
  assert.ok(opencode);
  const nameOf = (id: string) => opencode.models.find((model) => model.id === id)?.name;
  // Anthropic ids dash their decimals; without the fix these read "Haiku 4 5".
  assert.equal(nameOf("opencode/claude-haiku-4-5"), "Claude Haiku 4.5");
  assert.equal(nameOf("opencode/claude-opus-4-8"), "Claude Opus 4.8");
  assert.equal(nameOf("opencode/glm-5.2"), "GLM 5.2");
  assert.equal(nameOf("opencode/gpt-5.6-sol"), "GPT 5.6 Sol");
  // A hyphen between a digit and a letter is still a word break.
  assert.equal(nameOf("opencode/gpt-5-codex"), "GPT 5 Codex");
});

test("OpenCode Go model names humanize the same way", () => {
  const go = bundledProviderCatalog().providers.find((provider) => provider.id === "opencode-go");
  assert.ok(go);
  const nameOf = (id: string) => go.models.find((model) => model.id === id)?.name;
  assert.equal(nameOf("opencode-go/glm-5.3-flash"), "GLM 5.3 Flash");
  assert.equal(nameOf("opencode-go/kimi-k3"), "Kimi K3");
  assert.equal(nameOf("opencode-go/qwen3.8-max"), "Qwen3.8 Max");
  assert.equal(nameOf("opencode-go/hy4-preview"), "Hy4 Preview");
});

test("provider catalog refreshes from the Cline featured-model feed", async () => {
  const catalog = new ProviderCatalog({
    fetcher: async () =>
      new Response(
        JSON.stringify({
          recommended: [{ id: "example/new-model", name: "New Model" }],
          free: [],
          clinePass: [],
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    now: () => 1,
  });
  const snapshot = await catalog.refreshIfStale(true);
  assert.equal(snapshot.source, "cline-api");
  assert.equal(snapshot.updatedAt, "1970-01-01T00:00:00.001Z");
  assert.ok(
    snapshot.providers
      .find((provider) => provider.id === "cline")
      ?.models.some((model) => model.id === "example/new-model"),
  );
  assert.equal(catalogFromFeaturedFeed({ nope: true }), undefined);
});
