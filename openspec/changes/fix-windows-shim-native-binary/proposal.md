## Why

`resolveWindowsShim` in `src/agent/cline.ts` exists to dodge the cmd.exe 8191-character
command-line limit: the resolution prompt carries a review thread and repository
instructions, so it clears 8191 easily, and routing an npm `.cmd` shim through cmd.exe
kills the spawn before the agent runs. The helper reads the shim, extracts the entry it
invokes, and runs that entry with `process.execPath`.

That rewrite silently assumes the shim wraps a **Node script**. It does not check. An
agent CLI distributed as a **native executable** produces a shim with the identical
final line, matches the same regex, and gets handed to Node — which then parses a PE
header as JavaScript.

Verified against `opencode` 1.18.27 through the real `defaultRunner`, invoking only
`--version`:

| Invocation | Result |
| --- | --- |
| `defaultRunner("opencode", ["--version"])` | exit 1, `opencode.exe:1  MZx  SyntaxError: Invalid or unexpected token` |
| `opencode.exe --version` spawned directly | exit 0, `1.18.27` |

`opencode.cmd`'s last line is `"%dp0%\node_modules\opencode-ai\bin\opencode.exe"   %*`
— structurally indistinguishable from a Node shim's `"%dp0%\<entry>" %*`, which is what
the anchor regex matches.

This is a live defect in a shared helper on the Cline execution path, not a gap in
planned work. It is separated from the OpenCode agent change so the fix can land and be
reviewed on its own.

## What Changes

- Classify the entry `resolveWindowsShim` extracts before deciding how to launch it.
- Rewrite to `process.execPath <entry>` **only** when the entry is a Node script
  (`.js`, `.mjs`, `.cjs`), preserving today's behavior for Cline exactly.
- When the entry is a native executable, spawn **that entry directly** rather than the
  configured binary name. Returning `undefined` here would not be sufficient: the caller
  would then spawn the `.cmd`, Node would route it through cmd.exe, and the long prompt
  would hit the same 8191-character limit the helper exists to avoid. Spawning the
  executable directly bypasses cmd.exe entirely and gets the `CreateProcess` limit of
  32767.
- Keep the existing conservative fallback: anything unrecognized (no shim found,
  unreadable, no regex match, missing entry) still returns `undefined` and the caller
  spawns the binary as configured.

Not changing: the helper stays a no-op on non-Windows platforms; the anchor regex and
its reason for being anchored are unchanged; `defaultRunner`'s `stdin: "ignore"`,
buffering, and line observation are untouched.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `agent-execution`: the "Structured process invocation" requirement mandates argument-vector
  launching and an intact prompt, but says nothing about how an agent CLI is packaged on the
  host. It gains the requirement that launching succeeds, with the prompt intact and no
  host command-line length limit imposed, regardless of whether the installed CLI is a
  script or a native executable.

## Impact

- **Code**: `src/agent/cline.ts` (`resolveWindowsShim` only). No call-site changes —
  `defaultRunner` already consumes the `{ binary, prefix }` shape this returns.
- **Behavior on the Cline path**: unchanged. Cline's shim resolves to a `.js` entry and
  continues to take the `process.execPath` branch.
- **Platforms**: Windows only. The helper already returns `undefined` elsewhere.
- **Unblocks**: the OpenCode agent change, which cannot spawn its CLI at all until this
  lands.
- **Naming**: the helper and its `EXPECTED_CLINE_VERSION` neighbours live in a
  Cline-named module while being agent-agnostic. Relocating them is deliberately left to
  the OpenCode change, which has cause to generalize that module.
