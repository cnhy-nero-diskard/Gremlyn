## Context

See proposal.md — Why. The relevant current state:

- `resolution.ts` already passes an `onLine` callback into `executor.run()` for
  every line the agent writes, feeding `ActivityRecorder` and a throttled
  snapshot writer. This is a per-line signal the orchestrator already receives
  and currently uses only for display.
- The queue owns an `AbortController` per running item (`queue.ts`), whose
  `signal` is already threaded down to the executor and into execa's
  `cancelSignal`. There is already a way to stop a run; nothing decides to use
  it on a stall.
- `defaultRunner` in `launcher.ts` maps a configured duration onto execa's
  `timeout`. Both `timeout` and `cancelSignal` signal the direct child only.
- The observed hang produced no output for 53 minutes while the process stayed
  resident at 0% CPU. Killing it by hand left three detached Gradle/java
  processes running.

## Goals / Non-Goals

**Goals:**

- A bound that holds without configuration, and that a hung agent cannot evade
  by staying resident.
- Terminating an attempt leaves nothing behind, including processes the agent
  detached from its own tree.
- Distinguish "stopped responding" from "took too long" everywhere an outcome is
  recorded or displayed.

**Non-Goals:**

- Diagnosing *why* an agent stalled, or recovering from it in place. The failsafe
  ends the attempt; the existing retry path decides what happens next.
- Replacing the optional maximum duration. The two bounds are complementary and
  both remain.
- Detecting a *looping* agent that keeps emitting output while making no
  progress. That is a different problem, and no bound proposed here would catch
  it.

## Decisions

### Watch the output stream, not the clock

**Chosen:** reset a timer on every `onLine`; fire when it elapses.

A wall-clock maximum is the wrong instrument. It cannot distinguish a healthy
two-hour run from a dead one, so any value low enough to catch the hang promptly
is also low enough to kill legitimate work — which is presumably why this
deployment set `timeout_seconds: 0` and disabled bounding altogether. Inactivity
separates the two directly: the failure mode is silence, so measure silence.

*Alternatives considered:*

- **CPU sampling.** Would have caught this case (0% CPU), but not a stall that
  spins, and it means platform-specific process introspection on a timer for
  every attempt. The output stream is already in hand.
- **`ActivityRecorder.updatedAt`, or the activity snapshot file's mtime.**
  Derived from the same `onLine` signal but one layer further out, and throttled
  by `ACTIVITY_FLUSH_MS` — it would inherit the flush cadence and the recorder's
  parsing. Watch the raw line instead: any line counts, including one the
  recorder cannot parse.

### Put the watchdog in the orchestrator, not the launcher

**Chosen:** `resolution.ts`, wrapping the existing `onLine`, aborting through the
signal already threaded to the executor.

The orchestrator is where `onLine` and the `AbortController` already meet, so the
watchdog needs no new plumbing and works for every executor that streams. Putting
it in `defaultRunner` would tie it to one runner and to execa, and would have to
re-derive an abort path that already exists a layer up.

The orchestrator must record *why* it aborted, so a stall is not later
misreported as a plain cancellation: an abort reason is set before the signal
fires, and the attempt's outcome is resolved from it.

### Reap by process tree, at the one place termination happens

**Chosen:** extend `defaultRunner` so that whenever it terminates a subprocess it
also terminates that subprocess's descendants — `taskkill /T /F` on Windows, a
process-group kill on POSIX.

This is the one place all three termination paths converge, so cancel, duration
timeout, and the new stall bound all inherit it without three separate call
sites. It stays in the launcher — the opposite of the previous decision —
because it is genuinely runner-level: it is about how *this* runner spawns and
signals OS processes, and a different runner would do it differently.

Reaping is best-effort by nature: a descendant can exit between enumeration and
kill, or refuse to die. A survivor is recorded against the attempt rather than
swallowed, so the silent-orphan failure this change exists to fix cannot recur in
a quieter form.

*Alternative considered:* spawn the agent inside a Windows Job Object or a POSIX
session so the OS reaps descendants automatically. Stronger, but a larger change
to how every agent is spawned, and Job Objects would need care not to capture
processes the agent legitimately hands off. Worth revisiting if best-effort
reaping proves leaky.

### Configuration: a floor, a non-zero default, no "off"

**Chosen:** a new `agent_defaults` setting with a per-repository override,
mirroring how `timeout_seconds` already works, but validated so it cannot be
zero, absent, or below a floor.

Reusing the existing shape means the console's repository settings and the config
loader both extend rather than grow a parallel mechanism. The difference that
matters is validation: `timeout_seconds` treats 0 as "no limit", and this setting
must reject it — that asymmetry is deliberate, and it is exactly the hole being
closed, so it is worth the inconsistency.

**Default: 15 minutes; floor: 1 minute.** The default is set against the observed
incident (53 minutes of silence) and the longest legitimate quiet stretch seen in
practice — a validation build running inside a single agent tool call. The floor
exists because a value of a few seconds would make the failsafe itself the most
likely cause of failed attempts.

## Risks / Trade-offs

- **A legitimately quiet agent is killed.** An agent running one very long tool
  call — a full build, a large test suite — emits nothing while it waits. →
  Generous default, per-repository override, and a floor that prevents a
  pathologically low setting. This repo's own agent instructions already require
  `--no-daemon` for exactly this class of long in-agent Gradle run, so the quiet
  stretch is bounded and known.
- **An executor that does not stream output** would trip the bound immediately
  and permanently. → Both current executors stream (`cline --json`,
  `opencode --format json`). An executor that cannot must declare it, and the
  bound must not be applied blindly to one that emits nothing by design.
- **Reaping kills something shared.** A daemon the agent started but does not
  own — a Gradle daemon serving other work — is a descendant and would be
  reaped. → Scope strictly to descendants of the invocation, and rely on the
  existing `--no-daemon` guidance rather than trying to classify processes.
- **Tightening a bound changes existing behaviour.** An installation running with
  `timeout_seconds: 0` today is unbounded and becomes bounded. → That is the
  point of the change, but it is a behaviour change on upgrade and belongs in
  release notes, not only in the spec.

## Migration Plan

1. Ship the setting with its default applied when absent, so existing
   `gremlyn.yaml` files gain the bound without being edited. `timeout_seconds: 0`
   stays valid and keeps meaning "no maximum duration".
2. If the per-repository override is persisted, add a store migration alongside
   `repositories.timeout_seconds`, defaulting existing rows to inherit.
3. Reaping needs no migration; it changes only what happens at termination.

Rollback is per-mechanism: the reaping change is self-contained and can be
reverted alone, and raising the configured bound disables the watchdog in
practice without a code change.

## Open Questions

- Should a stalled attempt be eligible for automatic retry, or does it always
  wait for an operator? The retry allowance exists for transient failures, and a
  stall may or may not be one. This changes neither the specs nor the task
  breakdown — the stall reason is recorded either way — so it can be settled when
  the retry path is next touched.
