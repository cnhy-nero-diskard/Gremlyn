## 1. Pin the defect with a failing test

- [x] 1.1 Export `resolveWindowsShim` from `src/agent/cline.ts` (currently module-private) so it can be driven directly, and verify `npm run build` and `npm run lint` still pass
- [x] 1.2 Add a fixture helper to `tests/helpers` that writes a temporary npm-style `.cmd` shim plus its entry file, parameterized by entry filename, so a test can build both a script-entry and native-entry shim; verify by asserting the generated shim's final line matches the anchor regex the helper depends on
- [x] 1.3 Add a Windows-gated test to `tests/cline-contract.test.ts` asserting a shim whose entry is `.exe` resolves to `{ binary: <entry>, prefix: [] }`; verify it FAILS against current code with the entry handed to `process.execPath`
- [x] 1.4 Add a Windows-gated test asserting a shim whose entry is `.js` still resolves to `{ binary: process.execPath, prefix: [<entry>] }`; verify it PASSES against current code, locking in the Cline path before it is touched

## 2. Fix the launch route

- [x] 2.1 In `resolveWindowsShim`, classify the extracted entry by extension and take the `process.execPath` branch only for `.js`, `.mjs`, `.cjs`; verify task 1.4's test still passes
- [x] 2.2 Return `{ binary: <entry>, prefix: [] }` for a non-script entry that exists on disk; verify task 1.3's test now passes
- [x] 2.3 Confirm the unrecognized cases (no shim on PATH, unreadable shim, no regex match, entry missing) still return `undefined`; verify with a test per case asserting the caller falls back to the configured binary name
- [x] 2.4 Update the helper's doc comment to state the three outcomes and why a non-script entry is spawned directly rather than returning `undefined` (the cmd.exe 8191 limit); verify the comment names the limit and no longer claims the entry is always a Node script

## 3. Verify against the real CLIs on Windows

- [x] 3.1 Run `defaultRunner("opencode", ["--version"])` through a scratch script and verify it exits 0 with `1.18.27`, not the `MZx SyntaxError` recorded in proposal.md
- [x] 3.2 Extend the existing "an argv past cmd.exe's limit still reaches the agent" test in `tests/cline-contract.test.ts` to cover a natively-packaged CLI, gated on that CLI being present; verify a 20,000-character argument produces no "command line is too long" error
- [ ] 3.3 Run `npm run probe:agent` against cline and verify the Cline path is unchanged end to end — same resolved argv, same exit status as before the change
  - Deferred: this spends real provider credits and needs a configured provider/model/credential_source that aren't set up in this environment (per user decision, live-agent runs are left for manual verification). `defaultRunner("cline", ["--version"])` and `resolveWindowsShim("cline")` were verified directly against the real installed shim as a lower-cost substitute — see task 3.1/3.2 verification notes in the apply session.

## 4. Close out

- [x] 4.1 Run `npm test`, `npm run build`, and `npm run lint` and verify all pass (213 tests: 211 pass, 1 skipped, 1 pre-existing failure unrelated to this change — confirmed present on the unmodified tree too)
- [x] 4.2 Run `openspec validate fix-windows-shim-native-binary` and verify it reports valid
