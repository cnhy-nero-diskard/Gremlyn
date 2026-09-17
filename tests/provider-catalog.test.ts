import { test } from "node:test";
import assert from "node:assert/strict";
import {
  bundledProviderCatalog,
  catalogFromFeaturedFeed,
  OPENCODE_ROSTER_VERSION,
  ProviderCatalog,
} from "../src/agent/provider-catalog.js";
import { EXPECTED_OPENCODE_VERSION } from "../src/agent/opencode.js";

test("bundled provider catalog exposes current Cline, Codex, and OpenCode choices", () => {
  const catalog = bundledProviderCatalog();
  const cline = catalog.providers.find((provider) => provider.id === "cline");
  const pass = catalog.providers.find((provider) => provider.id === "cline-pass");
  const codex = catalog.providers.find((provider) => provider.id === "openai-codex");
  const opencode = catalog.providers.find((provider) => provider.id === "opencode");
  const opencodeGo = catalog.providers.find((provider) => provider.id === "opencode-go");
  const openai = catalog.providers.find((provider) => provider.id === "openai");
  assert.ok(cline);
  assert.ok(pass);
  assert.ok(codex);
  assert.ok(opencode);
  assert.ok(opencodeGo);
  assert.ok(openai);
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
  assert.equal(opencode.models.length, 70);
  assert.equal(new Set(opencode.models.map((model) => model.id)).size, 70);
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
  assert.equal(opencodeGo.models.length, 28);
  assert.equal(new Set(opencodeGo.models.map((model) => model.id)).size, 28);
  // Go's roster is not Zen's: models reachable only through the subscription
  // are exactly what the Zen-only catalog left unselectable. (glm-5.3 used to
  // be Go-only; since the 1.18.29 roster Zen serves it too, so it is no longer
  // in this list.)
  const zenIds = new Set(opencode.models.map((model) => model.id.split("/").at(-1)));
  for (const goOnly of ["longcat-2.0", "hy3", "qwen3.7-max", "qwen3.8-max"]) {
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
  // OpenCode logs into the operator's own OpenAI account as a third namespace
  // on the same executor and the same seeded auth.json, so it shares the kind
  // for the same reason Go does.
  assert.deepEqual(openai.kinds, ["opencode"]);
  assert.equal(openai.defaultModelId, "openai/gpt-5.6-sol");
  assert.ok(openai.models.every((model) => model.id.startsWith("openai/")));
  assert.equal(openai.models.length, 15);
  assert.equal(new Set(openai.models.map((model) => model.id)).size, 15);
  // One namespace serves both ChatGPT-subscription and API-key installations,
  // so no tier may be asserted for either: Go's uniform "subscribed" badge
  // would misdescribe a key, and Zen's `-free` rule has nothing to match.
  assert.ok(openai.models.every((model) => model.tier === undefined));
  // Cline's Codex entry is a different route to OpenAI, driven by a different
  // binary against a credential this one cannot use. They must stay distinct
  // entries on distinct kinds, or the picker would offer each to the wrong
  // repository.
  assert.notEqual(openai.id, codex.id);
  assert.deepEqual(codex.kinds, ["cline"]);
});

test("OpenCode namespaces survive a live Cline feed refresh", async () => {
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
  assert.equal(go.models.length, 28);
  const openai = snapshot.providers.find((provider) => provider.id === "openai");
  assert.ok(openai);
  assert.equal(openai.models.length, 15);
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

test("OpenAI model names humanize the same way, including the -fast variants", () => {
  const openai = bundledProviderCatalog().providers.find((provider) => provider.id === "openai");
  assert.ok(openai);
  const nameOf = (id: string) => openai.models.find((model) => model.id === id)?.name;
  assert.equal(nameOf("openai/gpt-5.6-sol"), "GPT 5.6 Sol");
  assert.equal(nameOf("openai/gpt-5.6-sol-fast"), "GPT 5.6 Sol Fast");
  assert.equal(nameOf("openai/gpt-5.4-mini-fast"), "GPT 5.4 Mini Fast");
  assert.equal(nameOf("openai/gpt-6-astra"), "GPT 6 Astra");
  assert.equal(nameOf("openai/gpt-5.3-codex-spark"), "GPT 5.3 Codex Spark");
});

/**
 * `pin:sync` bumps EXPECTED_OPENCODE_VERSION on its own across the patch
 * releases OpenCode ships weekly, but the rosters below it are hand-pasted and
 * it cannot refresh those. That is not hypothetical: the 1.18.30 bump left
 * `opencode-go/deepseek-flash` out of the picker, and nothing noticed, because
 * every layer beneath the catalog passes `-m` through verbatim — the model was
 * simply unreachable except by typing it into the custom path.
 *
 * So the marker is human-owned and this test is the gate: a pin bump goes red
 * until someone re-pastes `opencode models` and re-dates the roster. It is
 * deliberately not a diff against the live command, which would fail on
 * OpenCode's release schedule rather than on a change to this repository —
 * these rosters are served dynamically, and `opencode-go/omen-alpha` was
 * withdrawn upstream within an hour of the current paste.
 */
test("the OpenCode rosters were pasted for the pinned release", () => {
  assert.equal(
    OPENCODE_ROSTER_VERSION,
    EXPECTED_OPENCODE_VERSION,
    `the OpenCode rosters were pasted for ${OPENCODE_ROSTER_VERSION} but the pin is now ` +
      `${EXPECTED_OPENCODE_VERSION}: re-run \`opencode models\`, re-paste the OPENCODE_* id ` +
      `lists in src/agent/provider-catalog.ts, and set OPENCODE_ROSTER_VERSION to match`,
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
