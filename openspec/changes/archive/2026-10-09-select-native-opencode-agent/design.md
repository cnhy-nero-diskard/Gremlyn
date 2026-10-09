## Context

See `proposal.md` for motivation and `specs/` for the contracts. The executor currently accepts only generated managed `primaryAgentId` values. `managed-preflight.ts` already reads the pinned V2 effective inventory but drops name, description and hidden state. Jobs snapshot managed profiles; repository model/provider settings and executor aliases have different storage/runtime ownership. Child settlement and startup recovery are currently enabled by the managed-profile manifest rather than by OpenCode execution itself.

This design is required because selection crosses configuration, SQLite migrations, execution, recovery and authenticated console UI. No new OpenCode release, standalone server, SDK dependency or executor migration is assumed.

## Goals / Non-Goals

**Goals:** A single authoritative primary-source choice; coherent creation-time capture; exact execution-context validation; native/default delegation safety independent of UI telemetry; additive migration preserving existing profiles.

**Non-Goals:** Freezing external instruction definitions; copying developer-local agent files into worktrees; changing native permissions; widening managed permissions; snapshotting unrelated repository settings as a general refactor; implementing #15's live tree or the pending console redesign.

## Decisions

### D1. Use a discriminated selection rather than competing nullable overrides

Represent execution intent as `default`, `native { agentId }`, or `managed { profile, profileRevision }`. Add a repository-scoped selection row with source, native ID and optimistic revision, alongside the existing profile store. The source alone determines whether a profile is active; retained inactive native IDs/profiles are not competing overrides. Reject unknown fields, invalid combinations and stale revisions.

Save/edit a dormant profile without activating it. Activate a managed team only through an explicit source change that checks the profile revision in the same transaction. Existing active profile saves continue to revise that team's definitions for new jobs. Clearing an active profile deliberately returns the source to default atomically; removing a dormant profile leaves its current non-managed source alone.

Alternative: let any saved profile silently override a native ID. Rejected because operators could neither tell which control wins nor switch without losing definitions.

### D2. Capture policy at job creation, evidence per invocation

Add nullable source/native-ID/selection-revision capture fields to jobs; retain the existing managed snapshot columns. Read source and active profile inside the existing command-claim transaction. Retries read the job capture, not current repository choices. Legacy jobs with a captured profile resolve managed mode; other legacy OpenCode jobs resolve default, regardless of later repository changes. Non-OpenCode jobs do not consume this payload.

Default captures an omitted-flag policy, not an ID resolved in the developer checkout. Native captures the selected ID, not private external definitions. Managed captures its existing immutable profile. Store each invocation's requested source, parent session ID and actual initial primary/model when exposed separately from the capture. Known contradictory startup identity is an execution-configuration failure followed by safe settlement, never a reason to rewrite the job selection.

Alternative: copy all effective OpenCode configuration into the job snapshot. Rejected because it could copy secrets/private instructions, alter plugin behavior, and silently change project/global semantics.

### D3. Share exact binary, workspace and sanitized environment across probes and runs

Create one resolved worker descriptor from the configured executor alias: binary, pinned version, cwd and the allowlisted environment plus executor-provided roots. Use it for inventory, execution, session reads, interruption and recovery. Do not substitute the default `opencode` binary when an alias supplies another installation.

Expose inventory through a small shared adapter extracted from managed preflight. Its internal records preserve permissions for managed checks; a separate public allowlist projects ID, name, bounded/redacted description, mode, hidden/eligible state and evidenced origin only. Visible `primary` and `all` modes are eligible; subagent-only, hidden, malformed and Gremlyn-generated attempt IDs are not native picker choices. Validate native IDs as bounded non-empty identifiers without control characters or argument-like prefixes, then require exact inventory membership; keep the existing generated-ID syntax guard.

The authenticated discovery route derives repository paths on the server, never from a browser-provided cwd. Source-context discovery is advisory for the picker. Actual attempt preflight uses its prepared workspace and the same worker as execution, with bounded cold-location retries (initial budget 10 seconds), per-call timeout and abort support. Discovery never copies untracked source-local configuration. Cache only safe source-context metadata briefly (initial TTL 15 seconds), keyed by repository, binary/version, directory and environment-root fingerprint; refresh/save and attempt preflight bypass the cache. Empty successful inventory, cold pending inventory and transport failure remain distinct.

Alternative: read Markdown/frontmatter directly or reuse a global cached list. Rejected because neither proves the effective configuration used by this repository's invocation.

### D4. Make ownership and settlement OpenCode-wide, not profile-dependent

Journal a generic OpenCode attempt ownership record outside the workspace before launch, then capture and persist the parent session as soon as an attributable run-stream identifier is available. Record invocation ordinal, attempt/workspace, configured executor/binary context and requested source without prompts or credentials. Keep a missing-parent marker if launch occurred but ownership could not be established. Managed file manifests remain a separate record used only for generated-file cleanup.

Generalize the settlement reader to recurse through filtered parent listings. Each edge requires an echoed parent ID and the exact resolved workspace, and each root requires matching ID, root parentage and workspace. Track already-seen children so disappearance cannot prove completion. A successful round must freshly read complete listings and active state and prove every known parent/descendant terminal and inactive; a still-running ancestor could otherwise spawn after a leaf check. Bound pagination, cycles, depth and node count (initial safety caps: 50 pages per listing, 16 levels, 1024 nodes); exceeding a bound fails closed rather than truncating proof.

Settle after every parent exit, including failed invocations, before judging retry eligibility. Preserve managed single-invocation behavior. Native/default invocation retries retain the job selection and get distinct ownership entries only after the prior tree settles. Use the remaining configured timeout, retaining the existing 60-second post-parent settlement fallback when no outer timeout is configured. Interruption has bounded confirmation (existing 5-second grace); unknown attribution or API state preserves evidence and quarantines, without interrupting guessed sessions.

Extend startup recovery, quarantine admission, artifact retention and legacy attempt cleanup to recognize generic ownership markers. For an interrupted owner, prove all journaled invocation trees stopped within bounded recovery, then clean only manifest-owned managed files if applicable. Never delete native project/global definitions. Legacy unmanaged attempts with recorded parent/workspace evidence can be checked; unverifiable legacy OpenCode ownership must be quarantined rather than swept as Cline. A failed durable quarantine write remains a fatal safety failure.

Alternative: simply pass native `--agent` and leave the existing unmanaged retry path alone. Rejected because service-owned background/nested work could overlap retries or publication.

### D5. Add a narrow authenticated editor compatible with future staged settings

Add discovery and revisioned source-update routes under each repository. Model/provider mutations remain independent; source/profile activation commits together, audits safe identifiers, and sends one runtime-settings notification. The current repository card gains a native select/source control, local Apply/Cancel, descriptions, refresh/error state and explicit managed-team edit/switch actions. If configuration has moved to its dedicated route when implemented, mount the same component there and keep the dashboard read-only summary; no redesign dependency is introduced.

Preserve keyed drafts/focus/expanded profile editors across SSE changes. Track saved revision versus draft revision and reject a stale apply instead of replacing either side. Repository summaries label executor and primary source separately; job detail reads captured source and per-invocation actual evidence, never current repository selection. Keep full profile bodies confined to their existing authenticated edit route and redact diagnostics against active captured private instructions.

Alternative: a free-text agent field with immediate autosave. Rejected because it cannot communicate discovery eligibility, managed-source precedence, or deliberate activation.

## Risks / Trade-offs

- Native/default safety checks reject previously accepted runs when session proof is unavailable → Document the intentional compatibility change, retain actionable session/binary/context diagnostics, and never disable the gate to recover UX.
- Source and worktree configurations differ → Revalidate at the actual workspace and explain missing choices without copying private files.
- External definitions drift between queued work and retry → Retain ID/policy capture, report actual evidence, and document that only managed definitions are immutable.
- Nested/background sessions or listing races undermine proof → Recursive fresh-round checks, attribution tests, conservative bounds and quarantine protect publication.
- Live-discovery subprocesses add latency → Bound/coalesce source probes, cache only safe advisory metadata, and bypass cache for execution authorization.
- Other pending changes touch the same UI/SQLite schema → Use the next available migration IDs and reusable keyed editor/projection seams rather than rewriting their artifacts.

## Migration Plan

1. Add selection/capture/invocation storage with constraints and migration tests. Seed existing OpenCode repositories from their current non-null profiles; do not mutate profiles or infer selections for legacy jobs from repository state.
2. Wire effective discovery and source activation, then snapshot-to-executor execution and generic ownership/settlement/recovery before enabling native selection in the UI.
3. Add repository/job/audit projections and editor integration. Exercise fake/seam integration and existing managed/workspace/publication regression tests; real native identity acceptance is opt-in, uses temporary repositories and no GitHub publication.
4. Keep this additive migration and its evidence on rollback. Reverting to an older daemon is unsafe while new native trees or quarantines exist; stop work and prove quiescence first. To restore legacy behavior without downgrade, deliberately select default for future jobs; do not modify captured jobs or remove quarantine records.
