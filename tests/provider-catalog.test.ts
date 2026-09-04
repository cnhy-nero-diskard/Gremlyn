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
  assert.ok(cline);
  assert.ok(pass);
  assert.ok(codex);
  assert.ok(opencode);
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
