## Context

See proposal.md — Why for the defect and its evidence.

The constraint that shapes every option below: `resolveWindowsShim` is not an
optimization. On Windows the resolution prompt routinely exceeds cmd.exe's
8191-character command line, so *some* route that avoids cmd.exe is mandatory for any
agent installed behind a `.cmd` shim. "Do nothing and spawn the configured binary" is
therefore not a fallback — it is a different failure.

The helper returns `{ binary, prefix }`, which `defaultRunner` splices in front of the
argument vector. That shape is already general enough to express "run this program
directly" (`prefix: []`); nothing at the call site needs to change.

## Goals / Non-Goals

**Goals:**

- Launch a natively-packaged agent CLI correctly, with the long prompt intact.
- Leave the Cline path byte-for-byte identical in behavior.
- Keep the helper conservative: anything it does not positively recognize falls back.

**Non-Goals:**

- Generalizing or relocating the helper out of the Cline-named module. The OpenCode
  change has cause to do that; doing it here would make a small fix hard to review.
- Handling shim formats other than the npm-generated `.cmd` (PowerShell `.ps1`, Yarn,
  pnpm). The current anchor regex already targets one format and falls back otherwise.
- Any non-Windows behavior.

## Decisions

**Classify the extracted entry by extension, then choose a launch route.**

Three outcomes instead of today's two:

| Entry | Launch as | Rationale |
| --- | --- | --- |
| `.js` / `.mjs` / `.cjs` | `process.execPath <entry>` | Reproduces what the shim does; today's Cline behavior |
| anything else, and it exists | `<entry>` directly, `prefix: []` | Native executable; cmd.exe never enters the picture |
| unrecognized / missing / unreadable | `undefined` | Existing conservative fallback |

Alternative considered — **return `undefined` for non-script entries**. Rejected, and
this is the crux of the change: the caller would then spawn the `.cmd`, Node would
route it through cmd.exe, and the invocation would die on the 8191-character limit the
helper exists to defeat. It would convert a loud, immediately diagnosable
`SyntaxError` into an intermittent failure that only appears once a review thread grows
long enough. Spawning the executable directly instead gets the `CreateProcess` limit of
32767.

Alternative considered — **probe the file's magic bytes (`MZ`) rather than its
extension**. Rejected as more precision than the problem needs: the entry path comes
from a shim the package manager generated, extensions are reliable there, and reading
every candidate file adds I/O to every spawn. The fallback already covers the
unrecognized case.

Alternative considered — **write the prompt to a temp file and pass a path**. Rejected:
it changes the agent contract for all platforms and both CLIs to work around a
Windows-only launcher detail, and neither CLI's non-interactive mode is specified to
read a prompt from a file.

**Assert the classification in tests rather than only at the integration boundary.**
The defect is invisible to the existing suite because every test injects a fake
`ProcessRunner`, so nothing exercises the real one. The regression that matters is
"which program did we decide to launch", which is checkable without spawning anything —
fixture shims on disk, assert the resolved `{ binary, prefix }`.

## Risks / Trade-offs

- **Extension-based classification misreads an extensionless Unix-style entry** → Such
  an entry falls into the "spawn directly" branch, which is the correct handling for a
  native program anyway; a script without an extension would fail, and lands in the
  same place the current code already fails for it.
- **`prefix: []` makes `binary` an absolute path, so PATH resolution no longer applies**
  → Intended. The path came from the shim the package manager wrote, which is more
  specific than a PATH lookup, and the entry's existence is checked before it is
  returned.
- **The fix is Windows-only and CI may not run Windows** → The unit tests drive
  `resolveWindowsShim` with fixture files and can assert the classification
  platform-independently, but the end-to-end confirmation is a manual Windows run. The
  tasks call that out as an explicit step rather than assuming CI covers it.
