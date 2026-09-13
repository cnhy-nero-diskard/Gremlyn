## Why

An agent that stops making progress currently runs forever. `agent-execution`'s
**Bounded execution** requirement makes a maximum duration optional and states
that "an unset or zero duration SHALL leave the agent running until it exits or
is cancelled" — and this deployment's `gremlyn.yaml` sets `timeout_seconds: 0`.
The unbounded case is not an oversight; it is specified behaviour, so nothing in
the system is obliged to notice a hang.

It happened. Job 78 / attempt 108 sat in `running` for 1h40m: the agent process
was alive at 0% CPU, blocked on a tool call whose Gradle child was spinning on
an infinite test. No output was produced for the last 53 minutes. Nothing reaped
it, no operator was watching, and the pull request simply never got a reply. The
attempt only ended because a human noticed and cancelled it by hand.

Cancelling then exposed a second gap: the orchestrator killed the agent process
but left three orphaned Gradle/java processes still burning CPU, because the
agent had detached them and only the direct child was signalled.

## What Changes

- **An inactivity failsafe that cannot be disabled.** A watchdog over the
  agent's own output stream: if no line arrives within a bounded window, the
  attempt is terminated and fails. Unlike the optional maximum duration, this
  bound is always in force and has a non-zero default, so a fresh install is
  protected without configuration.
- **A distinct stall outcome.** A stalled attempt is reported separately from a
  duration timeout, so operators can tell "took too long" apart from "stopped
  responding". Like a timeout, workspace contents are preserved for inspection
  and nothing is committed or pushed.
- **Termination reaps the whole process tree.** Every termination path —
  operator cancel, maximum duration, and the new inactivity failsafe — SHALL
  leave no descendant of the agent process running, including processes the
  agent deliberately detached.
- The optional maximum duration is unchanged and may still be set to no limit;
  it now sits alongside a bound that cannot be switched off.

Not a breaking change: existing configurations keep working, and the new bound
is generous enough that a healthy agent never reaches it.

## Capabilities

### New Capabilities

None. This tightens bounds on execution that `agent-execution` already owns.

### Modified Capabilities

- `agent-execution`: **Bounded execution** is amended so that an always-present
  inactivity bound applies regardless of whether a maximum duration is
  configured, and the unbounded case is removed. A new requirement obliges every
  termination path to reap the agent's whole process tree.
- `job-orchestration`: abnormal termination — which releases the pull-request
  lock — now includes a stalled attempt alongside crash, timeout, and
  cancellation.
- `operator-console`: operator actions cover configuring the inactivity bound,
  which — unlike the agent timeout — cannot be set to "no limit"; a stalled
  attempt is distinguishable from a timed-out one in the console.

## Impact

- `src/orchestrator/resolution.ts` — watchdog wiring around the existing
  `onLine` callback passed to `executor.run()`, and the stall outcome recorded
  on the attempt.
- `src/agent/launcher.ts` — `defaultRunner` termination: execa's `timeout` and
  `cancelSignal` signal only the direct child, so tree reaping is added here.
- `src/config/loader.ts` — a new `agent_defaults` setting with a non-zero
  default, plus validation and a per-repository override.
- `src/console/*` — surfacing and configuring the new bound, and rendering the
  stall outcome.
- `src/store/*` — the attempt failure reason for a stall; a migration if the
  per-repository override is persisted alongside `timeout_seconds`.

### Assumptions

- Default inactivity window: **15 minutes**, clamped to a floor so it cannot be
  configured down to a value a healthy agent would trip. This is a tunable
  default chosen against the observed incident (53 minutes of silence) and the
  longest legitimate quiet stretch seen in practice — a validation build running
  inside an agent tool call. Adjustable in review.
- The watchdog observes agent output, not CPU or the activity snapshot file, so
  it works identically for every executor that streams lines.
