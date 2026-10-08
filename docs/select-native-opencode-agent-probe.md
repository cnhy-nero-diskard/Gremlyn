# Select-native OpenCode agent — bounded probe artifact (task 1.1)

Scope: record the pinned OpenCode V2 surfaces that native-agent selection
depends on, so tasks 1.2-1.4 and the later executor/console work build on
observed behavior rather than assumptions.

This probe was **read-only and bounded**: CLI `--help` output, one
`opencode debug agents` shape-only read (no streaming of the operator's private
inventory values), and the official V2 documentation. It made **no model
calls**. Real-runtime acceptance (an actual `opencode run --agent <id>`) stays
explicit opt-in and is out of scope here.

## Pinned release

| Item                        | Value                                                              |
| --------------------------- | ------------------------------------------------------------------ |
| Pinned version              | `2.0.16` (`EXPECTED_OPENCODE_VERSION` in `src/agent/opencode.ts`)  |
| Local binary                | `opencode v2.0.16` on `PATH`                                       |
| Authoritative inventory     | `opencode debug agents` (JSON)                                     |
| Server equivalent           | `GET /api/agent` envelope `{ location: { directory }, data: […] }` |
| Native selection flag       | `opencode run --agent <id>`                                        |
| Session handle / transcript | `opencode session export <session>`                                |

Evidence — `opencode --help` and `opencode debug --help` list `debug agents`
("List all agents"); `opencode run --help` lists `--agent string  Agent to use`;
`opencode session export --help` takes an optional `<session>` positional.

## Inventory surface (pinned V2)

`opencode debug agents` prints a JSON array of effective agent records. A
shape-only read against 2.0.16 (values deliberately not captured) observed:

| Observation                | Result                                 |
| -------------------------- | -------------------------------------- |
| Record count               | 9                                      |
| `mode` values present      | `primary`, `subagent` (not `all` here) |
| Hidden records             | 3 (`hidden: true`)                     |
| Records with `description` | 6                                      |

The union of record keys was
`description, hidden, id, mode, model, name, permissions, request, system`. No
record id contained `/` in this global-only project; nested ids occur when a
project defines `.opencode/agents/<dir>/<name>.md`.

The CLI bare-array shape and the server `{ location, data }` envelope are both
accepted by the shared parser; the envelope additionally carries the directory
the inventory was computed for (`location.directory`). An inventory whose
reported directory is not the expected worker cwd fails closed before it is
cached or returned.

### Private fields that must never be projected

`system` is the agent's private system prompt. `request` is a per-agent
header/body overlay. Neither is read into the shared record, and no projection
(id, name, description, mode, hidden/eligible, origin) can carry them. A
credential-shaped or otherwise unknown field is likewise dropped. This is the
privacy boundary the `opencode-agent-selection` capability requires.

The public projection additionally redacts obvious credential-like literals
(`sk-…`, `ghp_…`, `AKIA…`, `Bearer …`, `api_key: …`) from any name or
description, and suppresses a display field that exactly reproduces a
transient private value (the system prompt or a request leaf). The private
value is compared in memory only and is never persisted on the record.

The parser is strict: a present-but-malformed `name`, `description` or `hidden`
rejects the record rather than being silently treated as absent, a `hidden`
value that is not a boolean can never make an agent eligible, control/C1/Cf
characters in an id reject the record, and two records sharing one id make the
inventory ambiguous and are rejected.

## Mode and hidden semantics

Official V2 agents documentation
(<https://opencode.ai/v2/docs/agents/>):

| Mode       | Behavior                                           | Primary-capable |
| ---------- | -------------------------------------------------- | --------------- |
| `primary`  | Runs as the main agent for a session               | Yes             |
| `subagent` | Runs only in a child session via the subagent tool | No              |
| `all`      | Runs either as a primary or a subagent             | Yes             |

`hidden: true` removes an agent from normal listings, interactive discovery and
the subagent catalog. It controls visibility, not security. The selected
`default_agent` must exist, be visible, and support primary use, otherwise
OpenCode falls back to `build` and then the first visible primary-capable agent.

Eligibility for the native picker therefore is: **bounded id** ∧ **not hidden**
∧ **mode in {`primary`, `all`}** ∧ **not a Gremlyn-generated attempt id**
(`attempt-<n>/…`). Subagent-only, hidden, malformed and generated ids are not
offered and a submitted selection of one is rejected.

Origin (project vs global) is not present in the `debug agents` record, so it
projects as `unknown`; the code only reports an origin when the source actually
carries one. It is never inferred from the agent name.

## Native `--agent` selection

`opencode run --agent <id>` selects the session's primary agent. The selected
primary is loaded from the effective project/global configuration for the
process cwd, so a choice discovered in one directory is **not** valid in
another. The executor passes the captured id only after validating it against
the effective inventory of the actual prepared attempt workspace, using the
same binary, cwd and environment as execution. Default source omits `--agent`
entirely; an absent or ineligible id fails the attempt instead of falling back
to `build`.

## Initial runtime identity and early session id

- The non-interactive stream is `opencode run --format json`. On 2.0.16 every
  event carries a top-level `sessionID` (capital ID), and the **first**
  `step_start` event already carries it. `extractSessionId` matches
  `sessionID` (as well as Cline's `taskId` forms) and that id is a real export
  handle for `opencode session export <session>`.
- The stream did **not** expose a separate "effective primary agent id" field
  in the captured contract fixtures. Requested selection (`--agent <id>`)
  remains distinct from any observed runtime identity; where OpenCode exposes no
  attributable primary identity, diagnostics report the captured selection and
  `unknown` actual identity rather than fabricating a match. Verifying real
  effective identity is part of the opt-in acceptance run.

### Reading the initial effective identity (bounded, root-verified)

The stream's first `step_start` gives the session handle. The effective primary
identity for that session is read from the **first assistant message** over the
authenticated API, not from any mutable session field:

```text
GET /api/session/{sessionID}/message?type=assistant&order=asc&limit=1
```

The official V2 API lists `GET /api/session/{sessionID}/message` as
"Get session messages" (<https://opencode.ai/v2/docs/api/>); `order=asc` with
`limit=1` returns the earliest assistant message, which carries the identity the
session actually started with. The read is:

- performed through the same alias-aware worker as the run (binary, cwd,
  environment), never the default binary when an alias selects another;
- bounded by the per-call wrapper and abortable, so an unavailable service
  cannot stall settlement;
- cross-checked so the returned session belongs to the attempt's own session
  and workspace root before its identity is trusted;
- never read from the mutable `session.agent` field, which changes when an
  operator switches agents mid-session and would misreport the initial primary.

This read is observational and makes **no model calls**. When no attributable
identity is returned within the bound, diagnostics report the captured
selection and `unknown` actual identity.

## Bounded discovery contract

| Bound                                  | Default | Where                                  |
| -------------------------------------- | ------- | -------------------------------------- |
| Advisory source-context cache TTL      | 15 s    | `NATIVE_DISCOVERY_CACHE_TTL_MS`        |
| Advisory source-context overall budget | 10 s    | `NATIVE_DISCOVERY_BUDGET_MS`           |
| Attempt-workspace preflight budget     | 10 s    | `NATIVE_DISCOVERY_PREFLIGHT_BUDGET_MS` |
| Poll interval while cold               | 500 ms  | `NATIVE_DISCOVERY_POLL_INTERVAL_MS`    |
| Per-call `debug agents` timeout        | 5 s     | `NATIVE_DISCOVERY_CALL_TIMEOUT_MS`     |

The cache is keyed by repository plus worker context (executor alias, binary,
pinned version, resolved cwd and environment-root fingerprint), stores only
safe projected metadata, and is bypassed by explicit refresh and by every
attempt-workspace preflight. A successful empty inventory, a cold pending
inventory and a transport failure remain distinct outcomes. Each underlying
read is additionally raced against its own timeout and the caller's abort, so a
reader (or CLI runner) that ignores cancellation cannot consume the whole
budget; the per-call bound is shortened to the remaining overall budget and the
poll sleep never extends past the deadline.

## Read-only fixture verification

The behaviors above are locked by tests that inject a fake inventory reader and
runner, so no CLI or model call is needed in the normal suite:

- `tests/agent-inventory.test.ts` — parser, privacy, eligibility, projection,
  strict display shapes, duplicate-id rejection, identifier safety, credential
  redaction and the bounded read wrapper.
- `tests/opencode-worker.test.ts` — alias-aware binary/cwd/env isolation and
  exact `buildAgentEnvironment` preservation.
- `tests/native-discovery.test.ts` — cold convergence, cache TTL/keys, refresh,
  preflight, timeout, cancellation, wrong-directory (fresh and cached),
  source-vs-worktree and bounded hung-reader cases.

Real `--agent` execution and effective-runtime identity acceptance remain opt-in
(see `tests/opencode-managed-live.test.ts`, gated on
`GREMLYN_LIVE_OPENCODE_MODEL`).
