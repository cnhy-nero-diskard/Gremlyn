# Delegation telemetry contract — pinned OpenCode 2.0.16 (tasks 1.1-1.3)

Scope: record the pinned runtime facts that live parent/child delegation
observation depends on, decide the collection transport, and define the safe
observation parser/projector. This artifact covers tasks 1.1-1.3 of
`observe-live-agent-delegation` only; it adds no observer loop, store or console
surface (tasks 2+).

The investigation was **read-only**:

- no OpenCode upgrade (`opencode --version` reported the already-installed
  pinned `v2.0.16`);
- **no model invocation** — no `opencode run`, no delegation, no paid call;
- no secret-file reads; the configured service was only queried through the
  installed CLI (`opencode api`), never a guessed URL;
- no raw prompts, transcripts or events were persisted — the probe printed only
  response key names, counts and booleans, never field values or content.

Authoritative sources:

- installed CLI: `opencode v2.0.16` on `PATH`;
- official V2 OpenAPI document (`https://opencode.ai/v2/openapi.json`) as
  guidance, not proof of this installation;
- existing live harness: `tests/opencode-managed-live.test.ts` and
  `tests/managed-sessions.test.ts` (opt-in / injected surfaces).

## Pinned release

| Item                   | Value                                                                   |
| ---------------------- | ----------------------------------------------------------------------- |
| Pinned version         | `2.0.16` (`EXPECTED_OPENCODE_VERSION` in `src/agent/opencode.ts`)       |
| Local binary           | `opencode v2.0.16` on `PATH`                                            |
| Session transport      | `opencode api <METHOD> <path>` under the attempt cwd/env                |
| Early parent handle    | top-level `sessionID` of the first `step_start` run-stream line         |
| Record route           | `GET /api/session/{sessionID}` → `{data: Session.Info}`                 |
| Listing route          | `GET /api/session` → `{data: Session.Info[], cursor}`                   |
| Active route           | `GET /api/session/active` → `{data: {ses…: {type:"running"}}}`          |
| Initial identity route | `GET /api/session/{sessionID}/message?type=assistant&order=asc&limit=1` |
| Event route            | `GET /api/event` (SSE, experimental)                                    |

## Read-only probe log

Every command below ran against the already-installed pinned CLI. Output was
reduced to key names, counts and booleans; identifiers and content were not
retained.

| Command                                                  | Result                                                                                                                                 |
| -------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| `opencode --version`                                     | `opencode v2.0.16`                                                                                                                     |
| `opencode api GET /api/info`                             | 200 JSON; keys `paths,pid,urls,version`                                                                                                |
| `opencode api GET /api/session/active`                   | 200; `{data}` map keyed by `ses…` with `{type:"running"}` (7 drains observed)                                                          |
| `opencode api GET /api/session`                          | 200; `{data:[Session.Info],cursor}`; item keys `agent,cost,id,location,model,projectID,time,title,tokens`                              |
| `opencode api GET /api/session/<active>`                 | 200; `model` keys `id,providerID,variant`; `time` keys `created,updated`; `location` key `directory`; `outcome` absent while unsettled |
| `opencode api GET /api/session/<active>/message?limit=1` | 200; `{data:[Message],cursor}`; `message[0]` keys `agent,content,cost,finish,id,model,providerState,snapshot,time,tokens,type`         |
| `opencode api GET /api/event`                            | Killed after an 8s bound; **0 bytes** stdout; no SSE fields; not a safely bounded consumer                                             |

## Coverage matrix

Each fact is tagged by evidence class so existing live-harness proof is never
mistaken for a fresh read-only probe. `read-only-probe` = observed through the
installed CLI during this task; `openapi-documented` = official V2 schema;
`existing-live-harness` = the opt-in/injected tests already in the repo;
`existing-fixture` = a captured shape already locked by unit tests.

| Fact                    | Evidence                                                   | Status         | Limitation                                                                                                                                                                                                                                        |
| ----------------------- | ---------------------------------------------------------- | -------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Early parent id         | existing-live-harness, existing-fixture                    | verified       | Parser reads only the top-level `sessionID`; nested `part.sessionID` is rejected. Proven by fixtures, not a fresh live run here.                                                                                                                  |
| Session record identity | read-only-probe, openapi-documented                        | verified       | `agent` is mutable current state; the **started** identity requires the first-assistant read.                                                                                                                                                     |
| Session record time     | read-only-probe, openapi-documented                        | verified       | `time.idle` was absent on the probed record; its semantics are unverified and never treated as a heartbeat.                                                                                                                                       |
| Filtered listing        | read-only-probe, openapi-documented, existing-live-harness | verified       | `--param` drops query params on 2.0.16; filters must be path-encoded, and attribution must still echo `parentID` + directory.                                                                                                                     |
| Active map              | read-only-probe, openapi-documented, existing-live-harness | verified       | Documented scope is process-owned _foreground drains_; absence is inactive for those drains. Whether a model-backed `background:true` child appears in the map is **unproven**; absence is never a demonstrated stop, completion or safety proof. |
| Terminal outcome        | read-only-probe, openapi-documented, existing-live-harness | verified       | A terminal outcome still needs a fresh active-map absence before the view asserts completion.                                                                                                                                                     |
| Initial identity        | read-only-probe, openapi-documented, existing-live-harness | verified       | Live proof is opt-in; the bounded read returns unknown identity when unavailable.                                                                                                                                                                 |
| Message identity        | openapi-documented, existing-live-harness                  | verified       | `type` filter applies before pagination; only `limit=1` was re-probed live.                                                                                                                                                                       |
| Foreground/background   | existing-live-harness                                      | **partial**    | Background attribution is proven only by injected settlement tests and the opt-in live harness; this probe observed only the live foreground active map and did not spawn a model-backed child.                                                   |
| Nested parentage        | existing-live-harness, openapi-documented                  | verified       | Depth (16) / node (1024) caps are Gremlyn bounds, not runtime facts; nested spawning is proven by settlement fixtures, not a new live run here.                                                                                                   |
| Event stream            | openapi-documented, read-only-probe                        | **unverified** | See below. No safely bounded subscription and no verified event→node mapping.                                                                                                                                                                     |

The machine-readable copy of this matrix lives at
`tests/fixtures/delegation-observation/coverage-matrix.json`; a test asserts
that every non-verified fact carries a precise limitation and that the evidence
classes stay separated.

## Task 1.2 — event transport decision: polling-only

`GET /api/event` exists and is documented as an SSE stream of native and plugin
events. It is **not usable as a bounded delegation source on the configured
runtime**:

- **No safely bounded CLI consumer.** `opencode api GET /api/event` produced no
  usable output within an 8-second bound and had to be killed (0 bytes stdout,
  no SSE `event`/`data` fields). The `opencode api` request tool waits for a
  complete body, which a streaming endpoint never provides.
- **Volatile by contract.** The OpenAPI description states a slow consumer
  **overflows and fails the stream**, and events during **disconnection are
  missed**. A stream is therefore not a complete history.
- **No verified event→delegation mapping.** The stream's `data` is an opaque
  `V2EventEncoded` JSON string with no documented per-event delegation
  discriminator; mapping an event to an attributed session node is unverified.
- **No guessed service URL.** The event endpoint was only attempted through the
  configured CLI, never a separately guessed or unauthenticated URL.

Decision: **polling-only fallback** (design D1). Reconciliation uses the
supported session/active routes already pinned by `managed-sessions.ts`, with
one in-flight round per root, bounded per-call timeouts and a global concurrency
limit. A future event adapter may only be added after a subsequent contract
probe proves a bounded consumer and a documented event shape; it would be an
accelerator that schedules/coalesces reconciliation, never a replacement.

Disconnect/overflow/unsupported handling is explicit: misses are recorded as
coverage gaps, absence from a stale source never asserts completion, and
reconnection recovers current/available terminal evidence without claiming
continuous coverage.

## Task 1.3 — safe observation parser/projector contract

Module: `src/agent/delegation-observation.ts`.

### Whitelisted fields only

The parser reads only: `id`, `parentID`, `agent`, `model`
(`providerID`/`id`/`variant`), `outcome`, `location.directory`, and `time`
(`created`/`updated`/`idle`). `title`, `metadata`, `projectID`, `permissions`,
`revert`, `tokens`, `cost`, `fork`, `content`, tool/prompt state and every
unknown field are **never copied** — so prompts, instructions, tool arguments
and credentials cannot ride along. Tests assert this with records whose private
fields contain fake secrets and instructions.

### API surface (designed here; observer/store not yet built)

| Export                                                         | Purpose                                                                                                                                  |
| -------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| `parseDelegationSessionRecord(body)`                           | `{data: Session.Info}` or bare record → `DelegationSessionRecord` (whitelisted); `undefined` only when no trustable `ses…` id exists.    |
| `parseDelegationSessionListing(body)`                          | `{data, cursor}` → items + `nextCursor` + `skipped` + `coverage`; malformed _rows_ degrade to `partial`, malformed _pages_ are rejected. |
| `parseDelegationActiveSessions(body)`                          | Active map → `ReadonlySet<string>`; unusable map (`undefined`) so absence is never trusted.                                              |
| `parseDelegationIdentity(value)`                               | Actual `agentId`/`model` from a record, dropping credential-shaped/malformed values.                                                     |
| `assessDelegationFreshness({lastObservedAt, now, intervalMs})` | Fresh until two missed intervals (design D4).                                                                                            |
| `projectDelegationObservation(input)`                          | Presentation state only (matrix below); **never a safety verdict**.                                                                      |
| `sanitizeDelegationDescription(value)`                         | Optional non-identity text: strip controls, mask credentials, cap length.                                                                |

### Validated timestamps

`time.created`/`updated`/`idle` are accepted only as finite, non-negative,
integer epoch-ms values within `DELEGATION_MAX_EPOCH_MS` (year 9999). Anything
else is omitted and the observation reports no time rather than inventing one.
Elapsed time may use supported source bounds; a terminal end instant is never
invented.

### Identity

The session record's `agent`/`model` is **current** identity and may reflect a
mid-session switch. The started identity remains
`readOpenCodeInitialIdentity` (bounded, root-verified first assistant message).
When neither is available the view shows **unknown identity** — never a
configured/requested label.

Identity is parsed as **supported identifier syntax only**, not as free text:
`/`-separated segments of `[A-Za-z0-9][A-Za-z0-9._-]*` (for example `build`,
`native-reviewer`, `attempt-42/reviewer`, or a nested native `dir/name`), at
most 8 segments and 256 characters. Empty/`.`/`..` segments, leading dashes,
control/Cf characters, whitespace/prose, quotes, URL/userinfo punctuation
(`:`/`@`) and credential-shaped values are rejected. A model is
`provider/id[#variant]`, each part validated the same way, and the **combined**
spelling must also fit 256 characters or the whole model is dropped. This is why
a prompt, instruction string or `https://user:pass@host` value can never become
persisted identity. Directories remain paths (bounded, control-free,
credential-free) and are not subjected to identifier syntax.

### State matrix (fresh supported evidence; not safety)

| Record      | Active  | Fresh | Projected state                    |
| ----------- | ------- | ----- | ---------------------------------- |
| any         | any     | no    | `unknown` (stale source)           |
| none        | any     | yes   | `unknown` (no record)              |
| nonterminal | yes     | yes   | `running`                          |
| nonterminal | no      | yes   | `idle` (not finished)              |
| nonterminal | unknown | yes   | `invoked`                          |
| terminal    | no      | yes   | `succeeded`/`failed`/`interrupted` |
| terminal    | yes     | yes   | `unknown` (contradiction)          |
| terminal    | unknown | yes   | `unknown` (absence unconfirmed)    |

A cancellation request is carried **independently**; only the runtime's own
`interrupted` outcome confirms interruption. This projector deliberately does
not reuse `classifyChildSession` (whose safety meaning treats any nonterminal
session as unsettled); nothing here may authorize validation, quiescence,
workspace reuse or publication, and absence from the active map is never
terminal completion.

The `active = no` row maps to `idle` exactly as design D4 prescribes, but it is
scoped to the documented **process-owned foreground drains** (`Session` drains
"currently owned by this OpenCode process"). `idle` therefore means "no fresh
process-owned drain observed; not finished" and is **not** a demonstrated stop.
Whether a model-backed `background:true` session always appears in that map is
unproven (see below), so an `idle` projection must carry that scope and a
coverage limitation, and active absence is never a safety proof.

### Bounds and redaction

Listing-page parsing retains at most 256 rows and marks additional rows as
partial coverage; a shared active map above 4,096 entries is unavailable rather
than treating a truncated map as proof of absence. Cursors are capped at 4,096
characters. These parser bounds never relax independent safety enumeration.

Identifiers are capped at 256 chars, directories at 4096, optional
descriptions at 512. The parser ignores oversized unknown fields entirely, so a
1 MB `metadata`/`title`/`content` payload yields a sub-2 KB snapshot with no
payload text; an oversized session id rejects the record. Credential-shaped
literals (`sk-…`, `ghp_…`, `Bearer …`, `api_key: …`, …) are dropped from
identities and masked in optional text.

## Foreground/background evidence — documented vs unproven

The `GET /api/session/active` description is specific: it returns **foreground
Session drains currently owned by this OpenCode process**, and sessions absent
from that result are inactive. That is the documented, process-owned scope. It
is **not** a documented statement about model-backed `background:true` sessions.

- **Documented (process-owned drains):** the live service returned a foreground
  active map; absence from it is inactive _for those drains_.
- **Existing live-harness evidence:** the pinned probe recorded a
  `background:true` child still running after its parent `run` returned (and
  writing to the workspace afterwards); the settlement tests track a
  late-spawned background child through echoed `parentID`/directory. Gremlyn
  never settles a nonterminal child on active-map absence alone — a terminal
  `outcome` is required — so the safety path does not depend on background
  presence in the map.
- **Unproven:** whether every model-backed `background:true` child appears in
  the process-owned active map. A background tool may still drive a foreground
  drain in the child session, but nothing here proves that. We therefore do
  **not** assert that background sessions are absent from the map, and we do
  **not** assert that map absence proves a background session stopped.
- **Not proven here (partial):** a model-backed background child was not
  spawned in this read-only task (no model call), so live observation of a
  background child while it runs remains covered only by the opt-in harness.

Reconciliation with the projector: `active = no` + nonterminal projects `idle`
(the D4 matrix), scoped to the process-owned map (`DELEGATION_ACTIVE_MAP_SCOPE`)
and explicitly nonterminal. It is a display label, not a claim that a background
session stopped, and not a safety verdict. `unknown` remains reserved for a
missing record, a stale source, a terminal/active contradiction, or an
unconfirmed active absence after a terminal outcome.

**Is this a blocking design contradiction?** No — not on the evidence
available, so no guessed safety downgrade is applied. There is no proof that
model-backed background sessions are absent from the process-owned map, which
makes D4's active-absence→`idle` row an **unverified-coverage caveat**, not a
demonstrated contradiction; and the safety classifier already requires a
terminal outcome, so no label here authorizes or suppresses anything. If a
future live probe establishes that a running `background:true` child is
genuinely absent from the active map, then D4's row (and any `idle`
presentation built on it) becomes a real contradiction to escalate before
console work — not to patch silently here.

## Tests and fixtures

- `tests/delegation-observation.test.ts` — focused tests: whitelist/privacy,
  identity-syntax and timestamp hardening (prose, URL/userinfo, credential,
  traversal, oversized combined model), malformed/unknown fields,
  credential/instruction redaction, oversized payloads, listing/active
  degradation, the full state matrix, freshness, cancellation separation, the
  active-map scope, and coverage-matrix provenance separation.
- `tests/fixtures/delegation-observation/` — redacted, synthetic but
  shape-accurate records, listing, active map, early-parent lines and the
  coverage matrix. No real prompts or events are stored.
- `tests/opencode-managed-live.test.ts` — explicit opt-in real-runtime acceptance;
  its model-backed proof is separate from this read-only investigation.

## Remaining limits

- No live parent→child observation was performed in this task (that requires a
  real, opt-in model run); the design's live acceptance remains task 5.2.
- Event transport is polling-only; a bounded event consumer and event→node
  mapping are unverified.
- Background-child observation is partial; whether a running
  `background:true` child appears in the process-owned active map is unproven,
  so an `idle` projection is scoped and never a demonstrated stop. If a live
  probe later proves background absence-while-running, D4's active-absence→
  `idle` row must be escalated as a real contradiction before console work.
- The observer loop, durable store and migrations (tasks 2+) are intentionally
  out of scope here; only the safe parser/projector contract and fixtures exist.
