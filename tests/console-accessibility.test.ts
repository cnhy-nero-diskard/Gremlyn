import { test } from "node:test";
import assert from "node:assert/strict";
import { stylesheet } from "../src/console/assets.js";
import { authLayout, layout } from "../src/console/views/layout.js";
import { responsiveTable, statusPill } from "../src/console/views/components.js";

function tokenBlock(css: string, dark: boolean): Map<string, string> {
  const match = dark
    ? css.match(/@media \(prefers-color-scheme: dark\)[\s\S]*?:root\s*\{([^}]*)\}/u)
    : css.match(/:root\s*\{([^}]*)\}/u);
  assert.ok(match, `${dark ? "dark" : "light"} theme token block is present`);
  return new Map(
    [...(match[1] ?? "").matchAll(/--([\w-]+)\s*:\s*(#[0-9a-f]{3,8})/giu)].map((entry) => [
      entry[1] ?? "",
      entry[2] ?? "",
    ]),
  );
}

function luminance(hex: string): number {
  let value = hex.slice(1);
  if (value.length === 3) value = [...value].map((part) => part + part).join("");
  const channels = [0, 2, 4].map(
    (offset) => Number.parseInt(value.slice(offset, offset + 2), 16) / 255,
  );
  const linear = channels.map((channel) =>
    channel <= 0.03928 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4,
  );
  return 0.2126 * (linear[0] ?? 0) + 0.7152 * (linear[1] ?? 0) + 0.0722 * (linear[2] ?? 0);
}

function contrast(foreground: string, background: string): number {
  const foregroundLuminance = luminance(foreground);
  const backgroundLuminance = luminance(background);
  return (
    (Math.max(foregroundLuminance, backgroundLuminance) + 0.05) /
    (Math.min(foregroundLuminance, backgroundLuminance) + 0.05)
  );
}

function assertTokenContrast(
  tokens: Map<string, string>,
  foreground: string,
  background: string,
  minimum: number,
): void {
  const foregroundValue = tokens.get(foreground);
  const backgroundValue = tokens.get(background);
  assert.ok(foregroundValue, `missing ${foreground} token`);
  assert.ok(backgroundValue, `missing ${background} token`);
  assert.ok(
    contrast(foregroundValue, backgroundValue) >= minimum,
    `${foreground}/${background} should meet ${minimum}:1 contrast`,
  );
}

test("console shells expose accessible names, scoped live channels, and current navigation", () => {
  const page = layout("Audit", "<section><h1>Audit</h1></section>", {
    stream: "/audit/stream",
    section: "audit",
  });
  assert.equal((page.match(/aria-current="page"/gu) ?? []).length, 1);
  assert.match(page, /<a href="\/audit" aria-current="page">Audit<\/a>/u);
  assert.match(page, /<nav aria-label="Primary">/u);
  assert.match(page, /data-connection-status[^>]*role="status"[^>]*aria-live="polite"/u);
  assert.match(page, /data-operation-announcer[^>]*role="status"[^>]*aria-live="polite"/u);
  assert.doesNotMatch(page, /data-live-status/gu);
  assert.match(page, /method="post" action="\/auth\/sign-out"/u);

  const signIn = authLayout("invalid");
  assert.match(signIn, /<label for="token">Console token<\/label>/u);
  assert.match(signIn, /id="token" name="token" type="password"[^>]*autofocus/u);
  assert.match(signIn, /aria-describedby="auth-error" aria-invalid="true"/u);
  assert.match(signIn, /id="auth-error"[^>]*role="alert"/u);
  assert.doesNotMatch(signIn, /Dashboard|Commands|Audit|Sign out/gu);
  assert.doesNotMatch(signIn, /data-connection-status|data-operation-announcer/gu);
});

test("responsive console tables retain semantic headers, labels, keys, and status text", () => {
  const table = responsiveTable({
    caption: "Example records",
    columns: [{ label: "Name" }, { label: "Outcome" }],
    rows: [{ key: "record-1", cells: ["<strong>one</strong>", statusPill("failed")] }],
    emptyMessage: "No records.",
  });
  assert.match(table, /role="region" aria-label="Example records" tabindex="-1"/u);
  assert.match(table, /<caption>Example records<\/caption>/u);
  assert.equal((table.match(/scope="col"/gu) ?? []).length, 2);
  assert.match(table, /data-live-key="record-1"/u);
  assert.match(table, /data-label="Name"/u);
  assert.match(table, /data-label="Outcome"/u);
  assert.match(table, /data-status-value="failed"/u);
});

test("light and dark console tokens meet normal-text, status, and focus contrast targets", () => {
  for (const dark of [false, true]) {
    const tokens = tokenBlock(stylesheet, dark);
    assertTokenContrast(tokens, "text", "bg", 4.5);
    assertTokenContrast(tokens, "muted", "surface", 4.5);
    assertTokenContrast(tokens, "accent", "surface", 4.5);
    assertTokenContrast(tokens, "accent-contrast", "accent", 4.5);
    assertTokenContrast(tokens, "focus", "surface", 3);
    assertTokenContrast(tokens, "focus", "bg", 3);
    for (const status of ["success", "failure", "cancelled", "interrupted"]) {
      assertTokenContrast(tokens, status, `${status}-bg`, 3);
    }
  }
});

test("console CSS provides visible focus and reduced-motion overrides", () => {
  assert.match(stylesheet, /:focus-visible[^{}]*\{[^}]*outline:\s*3px\s+solid\s+var\(--focus\)/su);
  assert.match(stylesheet, /\.responsive-table-wrap:focus-visible/gu);
  assert.match(stylesheet, /@media\s*\(prefers-reduced-motion:\s*reduce\)/gu);
  assert.match(stylesheet, /animation-duration:\s*\.01ms\s*!important/su);
  assert.match(stylesheet, /scroll-behavior:\s*auto\s*!important/su);
});
