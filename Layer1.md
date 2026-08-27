# Local PR Resolution Orchestrator — Bootstrap / Architecture Prompt

You are the primary implementation agent for a new project whose purpose is to orchestrate AI-assisted resolution of GitHub pull-request feedback from a local machine.

You are operating **inside the repository**, so you are responsible for translating the high-level architecture below into a concrete, repository-aware implementation plan before writing substantial code.

This prompt represents **Layer 1 planning**: system intent, boundaries, requirements, safety constraints, and expected behavior.

Your first responsibility is to perform **Layer 2 planning** based on the actual repository contents, technology choices, existing conventions, dependencies, and runtime environment.

Do not blindly implement this prompt as a literal file-by-file specification.

---

# 1. Mission

Build a lightweight local orchestration application that connects GitHub PR review activity to a locally installed coding agent.

The primary workflow is:

```text
GitHub PR review feedback
        ↓
User replies with !RESOLVE
        ↓
Orchestrator detects command
        ↓
Resolve exact repository + PR + thread context
        ↓
Prepare isolated local worktree
        ↓
Invoke configured coding agent/model
        ↓
Agent attempts resolution
        ↓
Validate result
        ↓
Commit/push changes when appropriate
        ↓
Report result back to GitHub
        ↓
Record complete activity locally
```

The application must also expose a **lightweight local UI** for:

* monitoring jobs,
* inspecting logs,
* seeing active and historical resolution attempts,
* manually starting/retrying/cancelling jobs,
* reviewing failures,
* controlling configured repositories,
* inspecting agent output,
* and performing limited manual orchestration.

This is not intended to become a large project-management system.

Keep the UI focused on **observability and control of the automation**.

---

# 2. Core Concept

The GitHub PR becomes a remote command surface for a locally running coding agent.

The initial command is:

```text
!RESOLVE
```

The expected semantic meaning is:

> Take the PR review feedback associated with this command, reconstruct enough context to understand the requested change, prepare an isolated checkout of the PR branch, instruct the configured coding agent to attempt the smallest correct resolution, validate the result, push successful changes back to the PR branch, and report the outcome.

The system should eventually support additional commands, but only `!RESOLVE` is required initially.

Design the command architecture so new commands can later be added without restructuring the entire application.

Possible future commands include:

```text
!TEST
!INVESTIGATE
!RESOLVE-ALL
!RETRY
```

Do not implement all of these unless they naturally fall within the chosen architecture.

---

# 3. Layer 2 Planning Requirement

Before implementing substantial functionality:

1. Inspect the repository completely enough to understand:

   * project structure,
   * existing source code,
   * package/dependency management,
   * frontend/backend structure if already established,
   * persistence mechanisms,
   * configuration conventions,
   * testing setup,
   * linting/formatting,
   * development scripts,
   * deployment assumptions,
   * operating-system assumptions.

2. Determine whether this is:

   * an empty/new repository,
   * a scaffold,
   * or an existing partially implemented application.

3. Produce a concrete **Layer 2 implementation plan**.

The Layer 2 plan must translate this architecture into:

* components/modules,
* interfaces,
* data models,
* persistence strategy,
* event flow,
* job lifecycle,
* concurrency model,
* GitHub integration,
* agent execution strategy,
* UI architecture,
* configuration,
* security controls,
* testing strategy,
* implementation phases.

Do not over-plan trivial files.

The plan should be implementation-oriented rather than theoretical.

After establishing the Layer 2 plan, proceed with implementation unless a genuine blocker makes implementation unsafe or impossible.

---

# 4. Environment Assumptions

Primary host environment:

```text
Windows
PowerShell
Git
GitHub
locally installed coding-agent CLI
```

The coding agent will initially be **Cline CLI**, using an explicitly configured model such as Luna.

Do not tightly couple the entire application to Luna.

Model selection should be configuration.

Prefer an abstraction resembling:

```text
AgentExecutor
    ├── ClineExecutor
    └── future executors
```

rather than scattering direct CLI invocations throughout the codebase.

The same applies to GitHub interaction and persistence.

---

# 5. Repository Registry

The orchestrator must support one or more configured GitHub repositories.

For each managed repository, persist or configure information such as:

```text
GitHub owner
GitHub repository
local source repository path
agent workspace/worktree root
default agent
default model
enabled/disabled state
optional repository-specific instructions
```

Example conceptual configuration:

```text
Repository:
    GitHub: owner/project
    Local source: C:\dev\project
    Agent workspace: C:\agent-workspaces\project
    Agent: cline
    Model: <configured Luna model>
```

Do not assume all repositories share one local parent directory.

---

# 6. Event Ingestion

Design an event-ingestion layer capable of detecting GitHub activity relevant to configured repositories.

The preferred architecture may use:

* a GitHub Actions self-hosted runner,
* GitHub API polling,
* GitHub webhook delivery,
* or another justified mechanism.

Choose the mechanism based on repository/runtime constraints discovered during Layer 2 planning.

The rest of the application should not be tightly coupled to the transport mechanism.

Normalize incoming GitHub activity into internal events.

Example:

```text
PullRequestReviewCommentCreated
IssueCommentCreated
PullRequestUpdated
```

The first implementation must at minimum correctly recognize the event that contains an actionable `!RESOLVE` command.

---

# 7. Command Authorization

Never treat arbitrary GitHub text as permission to execute commands locally.

Before executing `!RESOLVE`, verify authorization.

At minimum the system should support an allowlist of GitHub usernames.

Initial deployment may assume a sole repository owner.

Conceptually:

```text
if comment.author not in authorized_users:
    ignore command
```

Also verify:

```text
repository is configured
repository is enabled
PR belongs to expected repository
command is valid
event has not already been processed
```

Treat all GitHub-supplied text as untrusted input.

Never interpolate comment contents directly into shell commands.

---

# 8. Review Context Reconstruction

`!RESOLVE` itself contains almost no useful context.

The orchestrator must reconstruct the actionable feedback.

When possible gather:

* repository,
* PR number,
* PR title,
* PR body,
* base branch,
* head branch,
* commit SHA,
* author,
* triggering comment,
* parent review comment,
* complete review thread,
* associated file,
* associated line or diff hunk,
* nearby changed code,
* current PR diff,
* unresolved/resolved state,
* relevant GitHub URLs or IDs.

Example context passed to the coding agent:

```text
Repository:
owner/project

Pull Request:
#123 — Fix search synchronization

Branch:
feature/search-sync

Review feedback:
"Previous asynchronous search tasks are not cancelled here,
so older requests may overwrite newer results."

File:
src/.../SearchViewModel.kt

Diff context:
<relevant diff>

Command:
!RESOLVE
```

Do not dump the entire GitHub repository metadata into every prompt.

Provide concise but sufficient context.

The coding agent can inspect the checked-out repository itself.

---

# 9. Worktree Isolation

The automation must **not operate directly on the developer's normal working directory**.

Use isolated Git worktrees or equivalent isolated checkouts.

Conceptual structure:

```text
C:\agent-workspaces\
    Backlogium\
        pr-83\
        pr-84\
        pr-91\
```

Each active PR should have a deterministic workspace.

Before agent execution:

1. locate configured source repository,
2. fetch current remote state,
3. determine PR head branch,
4. create or refresh appropriate worktree,
5. ensure the worktree points at the correct PR branch,
6. detect dirty/unexpected state,
7. refuse dangerous destructive operations when state cannot be safely reconciled.

Never run:

```text
git reset --hard
git clean -fd
```

against the user's primary development checkout.

Destructive operations inside managed disposable worktrees must still be deliberate and controlled.

---

# 10. Concurrency

Assume multiple commands may arrive.

The system needs a job queue.

At minimum:

* do not allow two mutation jobs to operate on the same PR simultaneously,
* do not allow two jobs to mutate the same worktree simultaneously,
* permit independent PRs to execute concurrently only if the architecture safely supports it,
* make concurrency configurable if useful.

Conceptual locking:

```text
repository + PR number → execution lock
```

If PR #90 is currently being resolved:

```text
second !RESOLVE for PR #90
```

should become queued, rejected as duplicate, or otherwise handled deterministically.

Do not silently launch competing agents against the same branch.

---

# 11. Idempotency

GitHub events may be delivered more than once.

The orchestrator must not repeatedly execute the same command.

Persist a stable identifier for processed commands/events.

Possible key:

```text
repository
PR number
GitHub comment ID
command
```

Repeated delivery of the same event should result in:

```text
already processed
```

rather than another agent invocation.

Retries initiated manually by the user must be represented as separate attempts under the same logical job.

---

# 12. Job Model

Model resolution attempts explicitly.

Suggested conceptual states:

```text
RECEIVED
AUTHORIZED
QUEUED
PREPARING_WORKSPACE
RUNNING_AGENT
VALIDATING
COMMITTING
PUSHING
REPORTING
SUCCEEDED
FAILED
CANCELLED
```

A simpler internal representation is acceptable if it preserves useful visibility.

Each job should retain information such as:

```text
job ID
repository
PR
triggering comment ID
command
status
creation timestamp
start timestamp
completion timestamp
agent
model
workspace
commit created
GitHub response
error information
attempt number
```

Job history should survive application restarts.

---

# 13. Agent Invocation

Implement the coding agent behind an execution abstraction.

Initial executor:

```text
Cline CLI
```

The executor should receive:

```text
working directory
model
prompt
execution options
environment
timeout/cancellation signal if supported
```

Do not hard-code the model.

Configuration example:

```text
agent: cline
model: <Luna model identifier>
```

Capture:

```text
stdout
stderr
exit code
structured output when available
start time
end time
```

Avoid shell-string construction when the runtime supports argument arrays.

---

# 14. Agent Resolution Prompt

Generate a purpose-built prompt for each resolution attempt.

The prompt should communicate roughly the following:

```text
You are resolving a specific piece of pull-request review feedback.

Inspect the repository and surrounding implementation before modifying code.

Address the review feedback using the smallest correct change consistent
with the existing architecture and conventions.

Do not alter unrelated functionality.

Do not merge the pull request.

Run the most relevant tests, build, static checks, or validation available
for the affected area.

If the feedback is incorrect, obsolete, ambiguous, or cannot be safely
implemented, do not invent a change merely to satisfy the comment.
Explain the problem instead.

At completion, report:
- what you changed,
- files affected,
- validation performed,
- validation results,
- whether you believe the feedback has been resolved.
```

Include the reconstructed review context before this instruction.

Repository-specific agent instructions may also be appended.

Avoid prompts that encourage uncontrolled refactoring.

---

# 15. Agent Trust Boundary

The coding agent is an executor, not the orchestrator.

The surrounding application must retain control of:

```text
workspace creation
repository selection
GitHub authentication
authorization
job state
locking
command parsing
commit/push policy
reporting
logging
cancellation
```

Do not give the agent responsibility for deciding which repository to operate on based purely on natural-language GitHub text.

Do not allow the agent to arbitrarily select filesystem paths.

---

# 16. Validation

Agent success is not equivalent to command success.

After agent execution, independently inspect the worktree.

Determine:

```text
were files modified?
is Git repository valid?
does expected branch remain checked out?
are there merge conflicts?
did relevant validation succeed?
did agent report failure?
```

Prefer running validation through project-defined commands where practical.

Examples:

```text
tests
build
lint
typecheck
static analysis
```

Do not invent universal commands.

Discover them from the target repository.

The target repository's own agent may run validation as part of its work, but the orchestrator should retain enough information to report what occurred.

---

# 17. Commit and Push Policy

Successful automated resolutions may commit and push to the existing PR branch.

Use deterministic, clearly attributable commit messages.

Example:

```text
fix: address PR review feedback
```

or:

```text
fix: resolve review comment <comment-id>
```

Do not force-push unless a future explicit feature requires it.

Do not merge PRs.

Do not push if:

```text
agent execution failed
validation indicates serious failure
workspace state is inconsistent
branch cannot be verified
authorization cannot be verified
```

Record the resulting commit SHA.

---

# 18. GitHub Result Reporting

After execution, reply to the relevant GitHub location.

A successful response should be concise.

Example:

```text
✅ Resolution attempt completed.

Commit: abc1234

Changes:
- Cancelled previous search job before launching a new request.
- Added coverage for stale-result replacement.

Validation:
- Unit tests passed.
```

Failure example:

```text
❌ Resolution attempt failed.

Stage: VALIDATING

Reason:
Relevant test suite failed after the attempted change.

No changes were pushed.
```

If the agent concludes the feedback should not be implemented:

```text
⚠️ No change pushed.

The agent determined that this feedback appears to conflict with
<reason>.

See local job <job-id> for the full execution log.
```

Do not flood PR threads with raw agent transcripts.

Detailed logs belong in the local UI.

---

# 19. Review Thread Resolution

Treat GitHub's formal review-thread resolution state separately from code changes.

Initial behavior should preferably be conservative:

```text
implement fix
push fix
reply with result
```

Do not automatically mark a review thread resolved unless the architecture explicitly supports and justifies it.

A later configuration option may allow:

```text
autoResolveReviewThread: true
```

after successful implementation and validation.

---

# 20. Local UI

Build a lightweight UI oriented around monitoring and operator control.

The dashboard should make the following immediately visible:

```text
orchestrator status
configured repositories
currently running jobs
queued jobs
recent successful jobs
recent failed jobs
```

A job detail page/view should expose:

```text
repository
PR
trigger command
review feedback
status timeline
agent
model
workspace
agent output
validation
commit
GitHub response
errors
timestamps
```

Avoid excessive visual complexity.

This is an engineering control panel, not a consumer SaaS product.

---

# 21. Manual Controls

The UI should eventually support useful operator actions.

Initial useful controls include:

```text
retry failed job
cancel queued/running job where technically possible
open PR
open triggering review comment
open local workspace
rerun resolution
disable/enable repository
```

Potential future actions:

```text
manually submit PR + review comment ID
change model for retry
run investigation-only mode
clear disposable worktree
```

Separate dangerous controls visually and logically.

Never make destructive actions one accidental click away.

---

# 22. Persistence

Use lightweight local persistence.

Persist at minimum:

```text
configured repositories
jobs
job attempts
processed GitHub event/comment IDs
execution results
basic logs/metadata
```

Choose the storage mechanism during Layer 2 planning based on the project's stack.

For a single-user local application, avoid unnecessary infrastructure.

A lightweight embedded database is preferable to introducing a remote database without justification.

Large raw log output may be stored separately from structured job records if appropriate.

---

# 23. Configuration

Separate configuration from code.

Configuration should include at minimum:

```text
GitHub credentials/token source
authorized GitHub users
repository registry
workspace root
agent executable
default model
agent options
concurrency
logging level
UI/backend ports
```

Secrets must not be committed.

Prefer:

```text
environment variables
OS secret store
local ignored configuration
```

as appropriate.

Provide an example configuration file without real credentials.

---

# 24. GitHub Credentials

Use the minimum privileges needed.

The application may need permission to:

```text
read repositories
read pull requests
read review comments
write comments
push to authorized branches
```

Do not request organization-wide or unrelated permissions by default.

Never expose tokens in:

```text
UI
logs
agent prompts
GitHub comments
exception traces
```

Redact secrets where necessary.

---

# 25. Security Requirements

This application can execute AI-driven code modifications on the host machine.

Treat security as a core feature.

Required principles:

### Explicit repository allowlist

Only configured repositories may trigger execution.

### Explicit user allowlist

Only configured GitHub users may invoke commands.

### No arbitrary shell execution

Never interpret GitHub comments as shell commands.

### No arbitrary filesystem selection

Repository/worktree paths must originate from trusted configuration.

### No arbitrary model arguments from untrusted comments

Future syntax such as:

```text
!RESOLVE --model=x
```

must validate `x` against configured allowable models.

### Secret isolation

Do not expose orchestrator secrets to the coding agent unless genuinely required.

### Safe process spawning

Use structured process execution rather than concatenated shell commands where possible.

### Auditability

Every command should be traceable to:

```text
GitHub user
repository
PR
comment
timestamp
job
agent invocation
commit/result
```

---

# 26. Logging

Implement useful structured logging.

Important events include:

```text
GitHub event received
command parsed
authorization result
job queued
workspace prepared
agent launched
agent exited
validation started
validation completed
commit created
push completed
GitHub response posted
job completed
job failed
```

Include stable job IDs in log entries.

Do not log credentials.

The UI should expose useful logs without requiring the user to inspect a terminal.

---

# 27. Failure Handling

Failures are expected and must be first-class.

Examples:

```text
GitHub unavailable
authentication expired
target branch deleted
PR closed
worktree corrupted
git conflict
agent CLI missing
model unavailable
agent process crash
agent timeout
validation failure
push rejected
comment posting failure
application restarted during job
```

A job failure must record:

```text
stage
error
whether files changed
whether a commit exists
whether anything was pushed
recommended next action where useful
```

Do not collapse all failures into:

```text
Something went wrong.
```

---

# 28. Recovery

Design restart behavior.

On application startup:

* detect jobs left in transient states,
* determine whether they were interrupted,
* mark them accordingly,
* preserve logs,
* avoid accidentally re-running them unless explicitly configured.

Example:

```text
RUNNING_AGENT during crash
        ↓
application restart
        ↓
INTERRUPTED
```

The user may then retry manually.

---

# 29. Observability Over Cleverness

Prefer explicit state and logs over hidden automation.

The user should be able to answer:

```text
What is the orchestrator doing?
Why did it start?
Which model is running?
Which PR is being modified?
Where is the worktree?
What did the agent change?
Did tests pass?
Was anything pushed?
What commit was created?
Why did it fail?
```

without reverse-engineering console output.

---

# 30. Architecture Principles

Prefer clear boundaries resembling:

```text
GitHub Integration
Command Parser
Authorization
Repository Registry
Job Queue
Job Orchestrator
Workspace Manager
Agent Executor
Validation
Git Operations
Persistence
Logging
API
UI
```

These do not necessarily need to become individual packages or classes.

Use the project's language/framework idiomatically.

Avoid creating abstraction layers that provide no real value.

---

# 31. Suggested Internal Flow

Conceptually:

```text
receive GitHub event

normalize event

determine repository

check repository allowlist

parse command

check user authorization

deduplicate event

create job

queue job

acquire repository/PR lock

prepare worktree

reconstruct review context

generate agent prompt

invoke configured agent

capture agent result

inspect worktree

run/collect validation

if acceptable:
    create commit
    push branch

report result to GitHub

persist completion state

release lock
```

Failures should transition through the same orchestrator rather than escaping as uncaught process errors.

---

# 32. MVP Scope

Keep the first usable version deliberately focused.

A reasonable MVP is:

### GitHub

* one or more configured repositories,
* detect `!RESOLVE`,
* authorize command author,
* fetch PR/review context,
* report completion/failure.

### Git

* isolated worktrees,
* correct PR branch handling,
* commit,
* push,
* no force push.

### Agent

* Cline CLI executor,
* explicit model configuration,
* Luna-compatible configuration,
* prompt generation,
* capture result.

### Orchestrator

* persistent jobs,
* locking,
* retries,
* idempotency,
* useful logs.

### UI

* dashboard,
* repository status,
* job list,
* job detail,
* logs,
* retry,
* basic manual controls.

Do not expand the MVP into a generic CI/CD platform.

---

# 33. Non-Goals for Initial Implementation

Unless repository context strongly justifies otherwise, do not initially build:

```text
multi-user SaaS authentication
cloud deployment
billing
organization management
generic workflow builder
full GitHub clone
arbitrary shell-command system
plugin marketplace
distributed workers
Kubernetes support
mobile app
complex RBAC
automatic PR merging
```

The intended deployment is initially:

```text
one developer
one local machine
a small number of owned repositories
```

Design cleanly enough that expansion remains possible without prematurely building for it.

---

# 34. Testing Requirements

Layer 2 planning must identify how to test the system without repeatedly triggering real expensive agent runs.

Introduce test seams around:

```text
GitHub API
AgentExecutor
Git process interaction where practical
event ingestion
clock/time where needed
persistence
```

Support a fake/mock agent executor.

The fake executor should make it possible to simulate:

```text
successful resolution
agent failure
timeout
no changes
modified files
validation failure
```

Test important workflow behavior such as:

```text
unauthorized !RESOLVE is rejected
duplicate GitHub event does not execute twice
same PR cannot run concurrently
different safe jobs can queue correctly
failed agent does not push
successful job records commit
restart does not silently duplicate work
malformed GitHub data does not execute shell code
```

Use real integration tests selectively where appropriate.

---

# 35. Developer Experience

Provide clear setup documentation.

A developer should eventually be able to:

```text
clone repository
install dependencies
configure environment
configure GitHub authentication
register managed repository
configure Cline executable/model
start backend/orchestrator
start UI
verify connectivity
trigger test event
```

Provide:

```text
README
example environment/configuration
development commands
test commands
build commands
troubleshooting notes
```

Keep setup Windows/PowerShell friendly.

Do not make WSL mandatory unless there is a strong technical reason.

---

# 36. Implementation Strategy

After repository inspection, divide implementation into coherent phases.

Prefer vertical slices where useful.

A likely progression may resemble:

```text
Phase 1
Core domain + persistence + configuration

Phase 2
GitHub event ingestion + authorization + command parsing

Phase 3
Job queue + orchestration lifecycle

Phase 4
Workspace/worktree manager

Phase 5
Cline executor + prompt construction

Phase 6
Git validation/commit/push/reporting

Phase 7
Local API + monitoring UI

Phase 8
Manual controls + retries + recovery

Phase 9
Hardening + testing + documentation
```

This is guidance, not a mandatory phase structure.

Modify it based on the repository.

Avoid creating a giant implementation that is impossible to validate incrementally.

---

# 37. Layer 2 Deliverable

Before substantial coding, produce a repository-specific planning artifact.

It must include:

## Current Repository Assessment

What exists now and what conventions must be respected.

## Proposed Architecture

Actual components/modules appropriate to this codebase.

## Data Model

Concrete entities and important fields.

## Runtime Flow

From GitHub event to completed resolution.

## Technology Decisions

What libraries/frameworks/storage mechanisms will be used and why.

## Security Model

How authorization, secrets, command validation, and process isolation work.

## Worktree Strategy

How PR workspaces are created, reused, cleaned, and locked.

## Agent Execution Strategy

How Cline and model configuration are invoked.

## UI Structure

Primary screens/components and required API surface.

## Failure/Recovery Strategy

What happens when operations fail or the process restarts.

## Test Strategy

Unit/integration boundaries and mocked dependencies.

## Implementation Phases

Ordered concrete work items.

## Risks / Open Questions

Only genuine implementation risks; do not use this section to avoid making reasonable engineering decisions.

Once this Layer 2 plan is internally coherent, proceed with implementation.

---

# 38. Decision-Making Rules

When details are unspecified:

1. Inspect the repository.
2. Follow existing conventions where sensible.
3. Prefer the smallest architecture that satisfies the requirements.
4. Prefer reliable and observable behavior over cleverness.
5. Prefer local/simple infrastructure over cloud dependencies.
6. Keep dangerous behavior opt-in.
7. Keep agent execution replaceable.
8. Keep GitHub integration replaceable.
9. Do not sacrifice security to reduce a small amount of implementation work.
10. Make reasonable engineering decisions without repeatedly asking the user to decide trivial implementation details.

Ask for clarification only when a decision is both:

```text
material
AND
impossible to infer safely from the repository or requirements
```

Otherwise make the best engineering choice and document it.

---

# 39. Success Criteria

The MVP is successful when the following scenario works reliably:

```text
1. The local orchestrator is running.

2. A configured GitHub repository has an open pull request.

3. Review feedback exists on that PR.

4. An authorized user responds with:

   !RESOLVE

5. The orchestrator detects the command exactly once.

6. It reconstructs the relevant review context.

7. It prepares an isolated worktree for that PR.

8. It launches Cline using the configured Luna/model selection.

9. The coding agent inspects the repository and attempts the fix.

10. The orchestrator captures the result.

11. Relevant validation is performed or captured.

12. If acceptable, the change is committed and pushed to the
    existing PR branch.

13. GitHub receives a concise result reply.

14. The local UI shows the complete job lifecycle, logs,
    resulting commit, and final status.

15. The developer's normal working checkout remains untouched.
```

This complete path is more important than implementing numerous secondary commands.

---

# 40. Final Instruction

Treat this document as the **system-level contract**.

Your responsibility as the repository-aware implementation agent is to:

```text
inspect
→ understand
→ derive Layer 2 architecture
→ plan concrete implementation
→ implement incrementally
→ validate
→ document
```

Do not replace the requirements with a completely different product.

Do not over-engineer beyond the intended single-developer local orchestration use case.

The central invariant is:

> An explicitly authorized GitHub PR command may request a coding-agent resolution attempt, but the orchestrator—not the AI agent—controls authorization, repository selection, workspace isolation, execution lifecycle, Git operations, reporting, and audit history.

Build around that invariant.
