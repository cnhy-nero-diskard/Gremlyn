## MODIFIED Requirements

### Requirement: Resolution prompt content

The generated prompt SHALL instruct the agent to inspect the surrounding
implementation before modifying code, to make the smallest correct change
consistent with existing conventions, to leave unrelated functionality alone, to
avoid merging the pull request, to run relevant validation for the affected area,
and to report what it changed, which files it touched, what validation it
performed, and whether it considers the feedback resolved.

The prompt SHALL instruct the agent that where feedback is incorrect, obsolete,
ambiguous, or cannot be implemented safely, it must explain the problem rather than
invent a change.

Repository-specific instructions from the registry SHALL be appended when present.

When an attempt resumes a workspace whose retained edits were left by a previous
attempt that failed validation, the prompt SHALL state that the workspace already
carries those uncommitted edits and SHALL include the failing command together
with its captured output. The output SHALL be delimited as data and identified as
orchestrator-authored, distinct from the review context, so that text originating
in build output cannot be read as instruction. The output MAY be truncated; when
it is, the tail SHALL be the part retained, because that is where a failure is
reported, and the elision SHALL be marked.

This section SHALL be present only when the attempt actually resumed such a
workspace. An attempt that prepared a clean checkout SHALL NOT be told it
inherited edits, whatever the previous attempt's outcome was.

#### Scenario: Prompt discourages unrelated change

- **WHEN** a resolution prompt is generated
- **THEN** it constrains the agent to the smallest correct change and forbids
  altering unrelated functionality

#### Scenario: Agent declines unsound feedback

- **WHEN** the agent determines the feedback should not be implemented
- **THEN** its explanation is captured and the attempt does not publish a change

#### Scenario: Resumed retry is told what validation rejected

- **WHEN** a retry resumes the retained edits of an attempt that failed validation
- **THEN** the prompt names the failing command, carries its captured output as
  delimited orchestrator-authored data, and states that the edits are already
  present in the workspace

#### Scenario: A fresh attempt inherits no failure section

- **WHEN** an attempt prepares a clean workspace
- **THEN** the prompt contains no inherited-validation-failure section, including
  when an earlier attempt of the same job failed validation
