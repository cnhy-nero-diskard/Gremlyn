# Tasks — Agent credential isolation

Task 1 comes first because design D3 depends on its result: the seed set is an
empirical question, and building on an assumed answer risks shipping the same
`Unauthorized` failure the change exists to fix. Everything after it is ordered so
the failure becomes legible (group 2) before the fix lands (group 3), which means a
wrong seed set surfaces as a named reason rather than a mystery.

## 1. Determine the credential seed set

- [ ] 1.1 Extend `npm run probe:agent` with a seeded-run mode that copies a declared
      file list into the fresh `--data-dir` before invoking, and verify the probe
      reports the copied set alongside the run outcome
- [ ] 1.2 Determine empirically which files an isolated `--data-dir` needs to
      authenticate — starting from `secrets.json` and widening only as required —
      and verify a seeded isolated run reaches `finishReason: "completed"` where an
      unseeded one returns `Unauthorized`
- [ ] 1.3 Record the confirmed minimal seed set in design.md D3, replacing the
      unverified assumption, and verify the recorded set is exactly what task 1.2
      demonstrated

## 2. Make authentication failure legible

- [ ] 2.1 Detect provider authentication failure from the agent result and map it to
      its own reason code, and verify a captured `Unauthorized` result classifies as
      that reason rather than `agent-nonzero-exit`
- [ ] 2.2 Surface the authentication reason in the console job detail and in the
      GitHub outcome reply, and verify a failed attempt names authentication without
      exposing any credential value or transcript
- [ ] 2.3 Verify an authentication failure records the same failure detail every
      other stage failure records — stage, files changed, commit exists, pushed —
      with nothing published

## 3. Configure and verify the credential source

- [ ] 3.1 Add a required per-agent credential-source directory to the config schema
      and loader, and verify a config omitting it fails to load with a message
      naming the agent, the field, and the conventional default
- [ ] 3.2 Extend the startup agent check to verify the credential source exists and
      is readable, and verify a missing or unreadable source refuses startup with a
      configuration error and accepts no jobs
- [ ] 3.3 Verify the credential source is never written to — a full job run leaves
      the operator's authenticated agent installation byte-identical

## 4. Seed and scope the credential

- [ ] 4.1 Seed the confirmed file set into each attempt's `--data-dir` before
      invocation with owner-only permissions, and verify a seeded attempt directory
      contains exactly the declared set and nothing more
- [ ] 4.2 Verify no credential value reaches the process argument vector or the
      agent environment, extending the existing secret-isolation assertions
- [ ] 4.3 Verify the seeded credential is removed on every terminal path — success,
      failure, timeout, and cancellation — leaving no credential material on disk
- [ ] 4.4 Extend the startup interrupted-job sweep to remove stale attempt
      directories, and verify a directory left by a killed process is cleaned up on
      the next start without disturbing a running attempt

## 5. Verify isolation still holds

- [ ] 5.1 Verify two concurrent attempts each authenticate successfully and neither
      observes nor overwrites the other's agent session state, preserving the
      behavior task 8.5 of `add-pr-resolution-orchestrator` established
- [ ] 5.2 Verify a seeded run and an unseeded run against the same source directory
      produce independent session state, so seeding introduces no shared mutable path

## 6. Documentation and acceptance

- [ ] 6.1 Add the credential-source field to `config.example.yaml` with the
      conventional default and a note that it is read-only, and verify the loader
      parses the example successfully
- [ ] 6.2 Document in the README how to authenticate the agent and where its
      credentials live, including the re-verification step when the pinned agent
      version changes, and verify a clean setup can be brought to a first successful
      agent invocation by following it
- [ ] 6.3 Run `npm run probe:agent` against the configured provider and model and
      verify both isolated runs complete, closing the finding this change exists to
      fix
- [ ] 6.4 Verify task 11.6 of `add-pr-resolution-orchestrator` — the full acceptance
      scenario against a real repository with a real agent invocation — now reaches
      the agent-execution stage rather than failing on authentication
