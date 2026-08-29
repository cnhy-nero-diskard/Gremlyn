import { test } from "node:test";
import assert from "node:assert/strict";
import {
  bundledProviderCatalog,
  catalogFromFeaturedFeed,
  ProviderCatalog,
} from "../src/agent/provider-catalog.js";

test("bundled provider catalog exposes current Cline and Codex choices", () => {
  const catalog = bundledProviderCatalog();
  const cline = catalog.providers.find((provider) => provider.id === "cline");
  const pass = catalog.providers.find((provider) => provider.id === "cline-pass");
  const codex = catalog.providers.find((provider) => provider.id === "openai-codex");
  assert.ok(cline);
  assert.ok(pass);
  assert.ok(codex);
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
