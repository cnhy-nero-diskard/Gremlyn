## 1. Configuration document editing

- [x] 1.1 Add `src/setup/document.ts` exposing load/append/emit over the `yaml`
      Document API; verify a unit test parses a comment-heavy fixture, appends a
      repository entry, and finds every original comment and key order intact
- [x] 1.2 Add a round-trip stability test asserting that parsing and re-emitting
      `config.example.yaml` with no edits reproduces the file byte-for-byte, so
      any `yaml` normalization surfaces at build time
- [x] 1.3 Implement the validated atomic write (emit → `loadConfig` against a
      temp copy with synthetic placeholder token env → temp file → rename);
      verify a test where the loader rejects the candidate leaves the original
      file byte-for-byte unchanged and returns the loader's problem list

## 2. Inference from a checkout

- [x] 2.1 Add `src/setup/infer.ts` with origin-URL parsing for the SSH, HTTPS,
      and `ssh://` GitHub forms; verify unit tests cover each form, `.git`
      trimming, a non-GitHub host, and a missing `origin`, each returning no
      derivation rather than a guess
- [x] 2.2 Implement the workspace-root proposal as a sibling of the source path;
      verify a test asserts the proposal resolves outside the source path and
      outside every other configured source path
- [x] 2.3 Implement validation-command candidates from `package.json` scripts
      (`test` → `[npm, test]`; `build`/`typecheck`/`lint` → `[npm, run, <name>]`);
      verify tests cover a Node repo, a repo with no recognized scripts, and a
      repo with no `package.json`, the latter two yielding no candidates
- [x] 2.4 Implement inheritance of agent/provider/model/effort from an existing
      entry, falling back to the configured agent's highest supported tier;
      verify a test covers both paths and that each proposal carries its
      provenance label

## 3. Verification engine

- [x] 3.1 Add `src/setup/verify.ts` with the injected environment interface
      (`pathExists`, `isGitWorkTree`, `originUrl`) and the resolved-path
      containment helper; verify a test covers the Windows case-normalized
      sibling case where `<name>-workspaces` must not count as inside `<name>`
- [x] 3.2 Implement every check from the spec — source path exists and is a git
      work tree, origin matches owner/name, workspace root outside source and
      outside other sources, workspace-root collision, duplicate owner/name,
      unknown agent, model outside a non-empty allowed list — each returning a
      result carrying id, pass/fail, observed value, and remedy; verify one
      failing unit test per check
- [x] 3.3 Add the real environment implementation over `node:fs` and the existing
      `git()` helper; verify an integration test against a temporary real git
      repository created by the existing test helpers passes every check

## 4. Input resolution

- [x] 4.1 Add `src/setup/input.ts` resolving each field as explicit flag →
      interactive confirmation → `--yes` acceptance → failure; verify unit tests
      cover a fully flagged run, a `--yes` run, and a run that must fail
- [x] 4.2 Verify a test asserts that with no TTY, no flag, and no `--yes`, the
      resolver exits non-zero naming the missing input instead of waiting on
      input that cannot arrive or substituting a value

## 5. Registration flow

- [x] 5.1 Add the `add-repo <path>` flow wiring inference → confirmation →
      verification → validated write; verify an end-to-end test against a
      temporary real repository writes an entry whose every required field is
      explicit and which `loadConfig` accepts
- [x] 5.2 Verify a test asserts that each failing check aborts before writing and
      leaves the configuration file byte-for-byte unchanged
- [x] 5.3 Verify a test registering a second repository leaves the first entry
      and all comments intact

## 6. Onboarding flow

- [x] 6.1 Implement configuration-file bootstrap from `config.example.yaml` when
      absent, and treat an existing file as authoritative; verify tests cover
      both, asserting the existing file is not rewritten
- [x] 6.2 Implement prerequisite reporting by calling `verifyCredentialSource`,
      `getAuthenticatedLogin`, and `checkVersion`, rendering their errors as
      unmet prerequisites; verify tests cover an unset token variable, a login
      mismatch, and a missing credential source, each naming the remedy and
      leaving overall status unmet
- [x] 6.3 Implement console-token generation that prints the value and the export
      line without persisting it; verify a test asserts the value appears in no
      written file and that token values are redacted from output
- [x] 6.4 Wire the optional agent probe step and the hand-off into registration
      when no repository is configured; verify a non-interactive test reaches the
      registration step without running the probe

## 7. Verification flow

- [x] 7.1 Add the `verify` flow applying the same checks to every configured
      entry, reporting per entry and exiting non-zero if any failed; verify tests
      cover an all-pass configuration and one with a bad source path where the
      remaining entries are still reported
- [x] 7.2 Verify a test asserts the flow writes nothing — configuration file,
      workspaces, and data directory all unchanged after a run

## 8. CLI and packaging

- [x] 8.1 Add `src/setup/cli.ts` dispatching the three subcommands with
      `node:util parseArgs`, matching `probe.ts`'s conventions; verify `--help`
      lists every subcommand and every flag
- [x] 8.2 Add `setup`, `add-repo`, and `verify:config` scripts to `package.json`;
      verify each runs from a clean checkout and that `npm run build` and
      `npm run lint` pass with the new module

## 9. Documentation and full verification

- [x] 9.1 Rewrite the README Install/Configure sections around the CLI, keeping
      the manual YAML path documented as the explicit alternative and stating
      that startup behavior is unchanged; verify the documented commands and
      flags match the implemented ones
- [x] 9.2 Add troubleshooting entries for the new failure messages; verify each
      message quoted in the README is produced by a test
- [x] 9.3 Run `npm run build`, `npm run lint`, `npm run format:check`, and
      `npm test`; verify all pass and that no existing test changed behavior,
      confirming startup and runtime are untouched
