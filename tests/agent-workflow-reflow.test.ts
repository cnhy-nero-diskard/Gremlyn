import { test } from "node:test";
import assert from "node:assert/strict";
import { stylesheet } from "../src/console/assets.js";
import { repositoryCards } from "../src/console/views/dashboard.js";

test("workflow controls shrink at narrow layout zoom and preserve conditional hidden states", () => {
  assert.match(
    stylesheet,
    /\.opencode-selection-controls select \{ min-width: 0; width: 100%; max-width: 100%; \}/u,
  );
  assert.match(
    stylesheet,
    /\.opencode-selection-controls label \{ display: grid; min-width: 0; width: min\(14rem, 100%\)/u,
  );
  assert.match(
    stylesheet,
    /\.repo-opencode-workflow \[hidden\], \.agent-editor \[hidden\] \{ display: none; \}/u,
  );
  const narrow = stylesheet.slice(stylesheet.indexOf("@media (max-width: 420px)"));
  assert.match(narrow, /\.repo-opencode-workflow \.workflow-actions \{ grid-row: 3; \}/u);
  assert.match(narrow, /\.repo-card, \.lane, \.job-row \{ padding-inline: var\(--space-2\); \}/u);
  assert.match(narrow, /#repositories \{ padding: var\(--space-2\); \}/u);
  assert.match(
    narrow,
    /\.repo-card\[data-presentation="quiet"\] \{ padding-inline: var\(--space-2\); \}/u,
  );
  assert.match(narrow, /\.agent-review-row \{ grid-template-columns: minmax\(0, 1fr\); \}/u);
});

test("workflow edit and change actions keep stable identities across persisted state changes", () => {
  const repo = { id: 7, owner: "fixture", name: "workflow", enabled: 1, agent: "opencode" };
  const ordinary = repositoryCards([repo]);
  const unavailable = repositoryCards([
    {
      ...repo,
      opencodeSelection: {
        source: "managed",
        revision: 1,
        explicit: true,
        nativeAgentId: null,
        profileRevision: null,
      },
    },
  ]);
  for (const html of [ordinary, unavailable]) {
    assert.match(html, /id="repo-workflow-edit-7"/u);
    assert.match(html, /id="repo-workflow-change-7"/u);
  }
});
