# Choosing an OpenCode primary agent

An OpenCode repository has one **Run with agent** source, independent of its
executor alias, provider, model, effort, timeout, and enablement:

- **OpenCode default** omits `--agent`. OpenCode resolves its effective project
  and global default for each invocation. This captures a policy, not a fixed
  agent ID or instruction definition.
- **Existing OpenCode agent** selects an eligible, visible primary-capable agent
  from the effective inventory. A job captures the agent's exact ID, not a copy
  of its project/global instructions, permissions, or other external settings.
  Changes to those external definitions can affect queued work and retries.
- **Gremlyn-managed team** uses the job's immutable captured profile and revision,
  including the existing generated-primary, model-inheritance, and delegation
  permission checks. Native selection cannot override this source.

Explore a choice locally, then **Apply** to save it or **Cancel** to discard the
draft. **Refresh** refreshes advisory discovery; it does not save or replace a
choice. A stale selection/profile revision must be reloaded and reconciled before
applying. Source changes affect new jobs only. Queued jobs, internal invocation
retries, explicit attempt retries, and retries after restart retain their original
job capture. Old jobs with their own captured profile use managed mode; other old
OpenCode jobs use default policy, never a later repository setting.

## Discovery and worktree-local definitions

Discovery uses the repository's configured executor alias, pinned OpenCode binary,
working directory, and sanitized execution environment. It is read-only and
bounded. The picker contains actual discovered IDs, not a hardcoded roster.
Visible `primary` and `all` agents are eligible; hidden, subagent-only, malformed,
and Gremlyn-generated attempt agents cannot be selected as native primaries.
Origin is unknown when the runtime supplies no trustworthy origin evidence.

Source-checkout discovery is advisory. Before each explicit primary invocation,
Gremlyn revalidates the captured choice in the actual isolated attempt workspace,
using the same worker context as execution. A private or untracked source-local
agent definition may be missing there. Discovery failure, a wrong-directory
inventory, or an unavailable/ineligible captured ID fails configuration before
agent work. Gremlyn does **not** copy private configuration to the worktree or
silently substitute `build`, another native primary, or a managed team.

If a saved ID disappears, it remains the saved choice and is shown as unavailable.
Refresh/check the effective workspace configuration, or deliberately apply a new
source for future jobs. An existing job still retains its original capture.

## Managed activation and dormancy

Switching to native or default preserves the saved managed profile as **dormant**.
Editing that dormant profile does not activate it. Deliberately switching back to
managed checks the profile and selection revisions together. Clearing the active
profile returns the source to default atomically; clearing a dormant profile does
not change a native/default choice. Synchronizing file configuration does not
overwrite the saved source or profile. Cline repositories have no OpenCode picker
and reject OpenCode source mutations; their invocation options are unchanged.

## Requested versus effective identity

Repository summaries describe the configured executor and primary source. Job
detail describes the captured source/native ID or managed revision separately
from each invocation's observed initial primary/model and parent session.
Unobservable effective identity is **unknown**, not inferred from the selected
label. Known contradictory startup identity is an execution-configuration
failure; Gremlyn safely settles the launched tree instead of rewriting the
capture. Public discovery, summaries, and source-change audits do not contain raw
inventory, private instructions, or credentials.

## Safety compatibility change

**Native and default OpenCode runs now fail closed on missing delegation proof.**
Previously unchecked native/default runs must satisfy the same service-owned
session safety boundary as managed runs. A parent CLI exiting, even successfully,
does not prove its background or nested descendants stopped.

Before another parent invocation, workspace reuse, validation, commit, push, or
success reporting, Gremlyn requires a fresh, complete, attributed session tree:
the root and every descendant must have a terminal outcome and be absent from a
fresh active map. Wrong parentage/workspace, vanished records, contradictory state,
unavailable APIs, or exceeded discovery bounds never authorize continuation.
Timeout and cancellation cover the full attributed tree, with bounded interruption
confirmation. With no configured outer timeout, parent execution remains
unbounded but post-parent settlement has its existing 60-second fallback bound.

Ownership is journaled outside the workspace before launch, with separate evidence
for every invocation. Missing parent IDs or unconfirmed termination preserve
diagnostics and quarantine the workspace. Startup recovery must prove all owned
trees stopped before reuse. Recovery cleans only manifest-owned generated managed
files; it never deletes native project/global definitions or unrelated files.
Retention and workspace reclamation must preserve unresolved ownership evidence.
Failure to durably record quarantine is fatal, not a reason to admit the workspace.

## Upgrade and rollback

The additive migration seeds existing OpenCode repositories with non-null managed
profiles as managed, and repositories without a profile as default. Existing profile
bytes and revisions are preserved. Review newly failed native/default runs for
session-proof diagnostics rather than disabling the safety gate.

Keep the additive selection, job-capture, invocation, ownership, and quarantine
records on rollback. **Do not run an older daemon while native session trees or
quarantined workspaces remain unresolved.** Stop new work and prove quiescence
first. Never drop ownership tables, erase journals/quarantine records, bypass
admission, force workspace cleanup, or delete native definitions to make a
downgrade appear safe. Selecting default deliberately changes only future jobs;
it does not disable session safety or rewrite captured jobs.

Normal automated verification uses fixtures and temporary repositories. Real
model acceptance requires explicit opt-in and uses fixture GitHub/local publication
only; it is not part of an ordinary test run.

To run the native acceptance case explicitly in PowerShell:

```powershell
$env:GREMLYN_LIVE_NATIVE_OPENCODE_MODEL = "provider/model"
# Optional: choose a discovered eligible primary rather than the first eligible ID.
$env:GREMLYN_LIVE_OPENCODE_AGENT = "your-existing-agent-id"
node --import tsx --test --test-name-pattern="gated live native" tests/opencode-managed-live.test.ts
```

Use an authenticated model you intend to call; provider charges may apply. The
harness requires the pinned OpenCode release, discovers the native primary in a
temporary repository, and checks its actual first-assistant identity, settlement,
and local-only publication. It provisions no native instructions or agents. Without
`GREMLYN_LIVE_NATIVE_OPENCODE_MODEL`, this case skips before any CLI/model call.
