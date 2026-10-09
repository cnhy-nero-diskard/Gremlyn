## MODIFIED Requirements

### Requirement: Executor-specific primary agent selection

The executor invocation contract SHALL allow an OpenCode attempt to carry its captured primary source, native ID or managed profile without changing how another executor receives its existing options. The OpenCode executor SHALL explicitly select the validated captured native or generated managed primary in its non-interactive run, and SHALL omit explicit primary selection for default source. If the selected agent or generated configuration cannot be applied, the attempt SHALL fail with a distinct configuration reason and SHALL NOT fall back silently to another agent. Native selection validation SHALL NOT weaken generated runtime-ID or managed permission checks.

#### Scenario: OpenCode selects the captured primary

- **WHEN** a job with a dashboard-managed OpenCode profile starts
- **THEN** the OpenCode invocation uses that job's captured primary agent and effective definitions

#### Scenario: Another executor retains its contract

- **WHEN** a Cline repository runs
- **THEN** it receives its existing model, effort, prompt, environment, and cancellation behavior without OpenCode-specific arguments or configuration

#### Scenario: Native ID uses explicit primary selection

- **WHEN** a job captures an eligible native agent ID
- **THEN** the non-interactive invocation explicitly selects that ID after workspace-context validation

#### Scenario: Default source omits explicit primary selection

- **WHEN** a job captures OpenCode default
- **THEN** OpenCode resolves its normal effective default without Gremlyn substituting a named primary or generated profile

### Requirement: Delegated work is quiescent before independent validation

An OpenCode attempt SHALL include its foreground and background child sessions within the attempt's timeout and cancellation boundary, whether its primary source is managed, native, or default. The system SHALL prove termination of every launched parent and its attributed descendant tree before another parent invocation, workspace reuse, validation, commit, push, or success reporting. A terminal outcome and fresh inactive evidence SHALL agree before a session is considered stopped; missing, unreadable, misattributed or contradictory evidence SHALL NOT authorize continuation. If termination cannot be confirmed, the attempt SHALL fail without publication, preserve diagnostic ownership/session evidence, and quarantine the workspace. Startup recovery SHALL enforce this boundary for native/default trees as well as managed trees. These checks SHALL NOT broaden managed delegation permissions or treat observer telemetry as termination proof.

#### Scenario: Background child is still running

- **WHEN** the primary session finishes while one of its child sessions remains active
- **THEN** validation waits until the child finishes or is cancelled within the attempt boundary

#### Scenario: Child remains active after cancellation

- **WHEN** Gremlyn cannot confirm that a cancelled child has stopped
- **THEN** the attempt fails, no validation or publication occurs, and the unresolved child is recorded in diagnostics

#### Scenario: Timeout applies to delegated work

- **WHEN** the configured agent timeout expires while a child session is running
- **THEN** the child is cancelled with the attempt and no workspace changes are published

#### Scenario: Native primary leaves a background or nested child

- **WHEN** an externally configured native/default primary returns while an attributed descendant remains active
- **THEN** Gremlyn does not retry the parent or validate the workspace until the complete tree is proven stopped

#### Scenario: Session API is unavailable after execution

- **WHEN** fresh parent/descendant termination proof cannot be obtained within the settlement bound
- **THEN** the attempt fails closed and preserves its workspace and recovery evidence rather than continuing on the parent's exit code alone

#### Scenario: Restart does not prove service-owned termination

- **WHEN** a native/default attempt is marked interrupted at startup
- **THEN** its workspace stays unavailable for reuse until recovery proves the owned session tree quiescent
