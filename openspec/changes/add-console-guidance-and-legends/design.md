## Context

See `proposal.md` — Why. Current console values are rendered close to their
persistence vocabulary: status pills display raw statuses, command reasons and
attempt failures display raw strings, audit rows display action/target/effect,
and model capsules display catalog tags. Provider options already combine a
provider name with an authentication description, but the roles of agent,
provider, authentication, model, and effort are not explained together.

The console already has a redacted presentation boundary in
`src/console/queries.ts`, shared HTML helpers, and no client framework. Active
sibling proposals add keyed SSE reconciliation, dedicated monitoring and
configuration surfaces, a job safety rail, contextual recovery, staged settings,
bulk actions, and shortcut help. Guidance must reuse their anchors and state,
not create competing derivations.

## Goals / Non-Goals

**Goals:**

- Establish one typed terminology source used by inline values, legends, and
  task guidance.
- Keep essential meaning and raw correlation values together while moving long
  explanations behind native disclosure.
- Make help complete with local HTML/CSS and authenticated internal links.
- Compose with sibling surfaces through stable topic and landmark identifiers.

**Non-Goals:**

- Deriving job lifecycle success, action eligibility, or the recommended recovery
  path.
- Replacing the safety rail, contextual action feedback, shortcut reference, or
  configuration information architecture.
- Translating captured logs, agent output, review prose, or arbitrary exception
  messages.
- Building a documentation generator, Markdown runtime, external docs site, or
  client-side router.

## Decisions

### D1 — Use a typed terminology registry with neutral fallbacks

Add a console presentation registry whose entries contain a raw key, concise
label, definition, category, and optional help topic. Separate registries cover
job/attempt statuses, command outcomes and authorization reasons, known failure
reasons/stages, audit action/effect identifiers, and model tags/tiers. Provider
and technical-identifier terminology use typed helpers because their exact values
come from configuration or a row rather than a fixed enum.

Inline components and the help legends consume the same registry. Known-value
coverage tests compare exported domain vocabularies and catalog tags against
registered entries where those vocabularies are enumerable. Any runtime value
without an entry renders `Unrecognized <category>` plus the exact redacted raw
value and a neutral definition; it never falls back to title-casing a code and
pretending that is a semantic translation.

Translations receive only values that have crossed the existing redaction
boundary. The registry contains no secrets and copy controls read the rendered
redacted node, never a hidden unredacted data attribute.

*Alternative considered:* define friendly labels independently in every view.
Rejected because Commands, Audit, job attempts, help, and legends would drift and
new codes could disappear on one surface.

### D2 — Render help as an authenticated local route with stable topic anchors

Add a server-rendered `/help` route protected by the existing authentication
hook. A help index links to stable anchors for authorization, isolation,
validation, publication/reporting, actions, repository enablement, statuses,
failures, models, providers/authentication, and technical identifiers. All text,
styles, and behavior ship through current local assets; required understanding
never depends on an external link or request.

The shared authenticated layout renders Help wherever the sibling information
architecture places navigation. Contextual links add a known topic plus a
validated internal return target. The server accepts only recognized local route
shapes such as dashboard, repository configuration, job id, Commands, Audit, and
search; it never reflects a scheme, host, protocol-relative URL, or arbitrary
path. When no safe return is present, help returns to the authenticated landing
surface.

*Alternative considered:* rely on browser history for Back to context. Rejected
because direct links and refreshed pages have no reliable prior console entry and
could strand an operator.

### D3 — Make task guides semantic maps, not live state replicas

Each task topic is a short sequence of stable concepts and links to the landmark
owned by another view: the command outcome/reason, job safety rail, workspace
evidence, validation table, publication/reporting steps, contextual recovery
panel, or repository enablement review. The help view does not query a job to
calculate whether a step passed and does not render action buttons.

Contextual help may include an internal link back to a specific job or repository,
but current status, eligibility, and next action remain on that destination. The
keyboard topic links to the power-tools shortcut dialog/trigger instead of
copying its list.

*Alternative considered:* render a personalized help checklist from the current
job. Rejected because it would duplicate the safety rail and recovery presenter,
creating a second place where authoritative state could disagree.

### D4 — Pair a plain label with a reusable raw-value component

Introduce a shared semantic-value renderer with four parts: visible plain label,
visible exact raw value in `<code>`, an explicit type label, and an optional local
Help link. Long supporting definitions and cross-references sit in a native
`<details>` element with a stable key. Job, attempt, repository, pull request,
comment, commit, workspace, command, provider, model, and audit identifiers use
the same typed presentation rather than bare numbers or strings.

Raw reason/outcome/audit codes remain visible even when details are collapsed;
long values such as workspace paths or SHAs may wrap or scroll within their
container but are never truncated in the underlying selectable text. A small
Copy control is progressive enhancement over ordinary selection. It copies
`textContent` from the visible raw node and reports completion through the shared
scoped announcement mechanism from the accessibility/recovery changes.

*Alternative considered:* put raw codes only in tooltips or a global Advanced
mode. Rejected because tooltips are inaccessible to many keyboard/touch users and
a mode can hide audit-critical correlation data.

### D5 — Generate legends from the same data used by inline presentation

Legend components group registry entries by lifecycle status, failure semantics,
model metadata/tier, and provider/authentication vocabulary. Every row includes
the actual text marker, label, and concise definition. The job legend explicitly
separates stage, outcome, failure reason, publication state, and reporting state;
the model legend describes catalog metadata without making new billing or
availability claims.

Provider guidance is structural rather than a manually duplicated provider list:
it explains agent/executor, provider namespace, authentication description,
model id, and effort, while provider-specific options continue to come from the
live/offline catalog. Catalog tags that lack registered semantics render a
neutral exact-tag fallback.

The full legends live on Help. Compact inline Legend links or disclosure snippets
appear near first use on job, command/audit, and repository configuration
surfaces. They never replace the text-bearing badges required by accessibility.

*Alternative considered:* hard-code one static legend table in the help view.
Rejected because live catalog additions and active changes such as the stall
failsafe would not automatically share inline definitions or unknown fallbacks.

### D6 — Share repository enablement consequence copy

Define enable and disable consequence messages once in the guidance presentation
module. Single-repository controls from `stage-repository-settings-edits`, bulk
review from `add-console-operator-power-tools`, and the Help topic all render the
same content: disabled repositories create no jobs for later commands; ignored
commands are not replayed; existing jobs are not cancelled; enabling resumes only
eligible future commands; settings drafts remain independent.

The control-owning changes still decide placement, confirmation, eligibility,
and mutation behavior. This change supplies copy and Help cross-references only.

*Alternative considered:* repeat tailored prose in single, bulk, and help views.
Rejected because the no-replay and existing-job qualifications are safety-relevant
and must not diverge.

### D7 — Preserve disclosure through the shared keyed SSE reconciler

Native `<details>` supplies keyboard and assistive-technology behavior without
custom scripting. Give each disclosure a stable key and extend the same local
state capture/reconciliation used by the accessibility and settings changes so
`open` state survives unrelated fragment updates while the record remains.
No global disclosure preference is persisted.

If the accessibility change lands first, guidance registers its keys with that
mechanism. If guidance lands first, it adds only the minimal compatible
open-state capture that the later reconciler can absorb.

*Alternative considered:* custom accordion buttons and panels. Rejected because
they add focus, ARIA, and state-management work with no benefit over native
details for static explanatory content.

## Risks / Trade-offs

- **Friendly labels become stale or misleading.** → Centralize definitions,
  compare enumerable domain values in tests, use neutral unknown fallbacks, and
  keep exact raw codes visible.
- **Help duplicates operational truth.** → Link to owned landmarks and describe
  stable semantics only; never calculate current progress, eligibility, or
  recovery in the help view.
- **Provider or badge prose overstates billing/authentication.** → Source exact
  provider auth descriptions from the catalog, define only structural terms, and
  qualify badge definitions as catalog metadata.
- **Technical detail overwhelms novices.** → Keep labels and consequences first,
  use compact code styling and native details for longer definitions, but never
  hide correlation-critical raw values.
- **Copy controls leak redacted source values.** → Copy only rendered text nodes
  after query-layer redaction and do not store originals in DOM attributes.
- **Contextual return links enable redirects.** → Reconstruct only allow-listed
  internal route shapes and fall back to the authenticated landing page.
- **Sibling changes land in different orders.** → Integrate through stable topic,
  action-scope, rail, recovery, and disclosure keys; keep all behavior additive
  and avoid changing their route or mutation ownership.

## Migration Plan

1. Add the terminology registry, unknown fallbacks, semantic-value renderer, and
   coverage/redaction tests.
2. Add the authenticated local Help route, task topics, full legends, safe return
   links, and offline/no-external-dependency tests.
3. Adopt shared labels/raw values and compact contextual Help/Legend links in
   Commands, Audit, job/attempt, and repository settings views.
4. Reuse enablement consequence copy in single and bulk review surfaces and link
   action guidance to existing recovery controls.
5. Integrate disclosure keys with the keyed SSE reconciler and run combined
   sibling-change fixtures. No database or persisted-data migration is required;
   rollback removes additive presentation and the Help route without altering
   operational records.
