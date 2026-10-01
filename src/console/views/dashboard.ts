import type { DashboardModel, JobSummary, RepositorySummary } from "../queries.js";
import { REASONING_EFFORTS, type ReasoningEffort } from "../../types.js";
import { KINDS_REQUIRING_PROVIDER, type AgentDefinition } from "../../config/loader.js";
import type { OpenCodePermission } from "../../config/opencode-profile.js";
import {
  bundledProviderCatalog,
  type ProviderCatalogSnapshot,
  type ProviderModelOption,
  type ProviderOption,
} from "../../agent/provider-catalog.js";
import { elapsedTimeElement, escapeHtml, relativeTimeElement, statusPill } from "./components.js";

/** Configured agent definitions, keyed by the agent id a repository references. */
type AgentDefinitions = Record<string, AgentDefinition>;

/**
 * Per-repository agent options for the pickers: the executor kind its agent
 * runs as, the effort tiers that agent declares, and whether its kind accepts
 * an empty provider (a CLI that folds the provider into the model id).
 * Unknown agents fall back to the global defaults so a repository row never
 * renders an unpickable state.
 */
function agentOptionsFor(
  repo: RepositorySummary,
  agents: AgentDefinitions,
): { efforts: readonly ReasoningEffort[]; providerOptional: boolean; kind: string | undefined } {
  const definition = repo.agent === undefined ? undefined : agents[repo.agent];
  return {
    efforts: definition?.efforts ?? REASONING_EFFORTS,
    providerOptional: definition !== undefined && !KINDS_REQUIRING_PROVIDER.has(definition.kind),
    kind: definition?.kind,
  };
}

/**
 * The catalog entries a repository's agent kind may use. Providers are
 * first-party to one executor (Cline billing/Codex vs OpenCode's Zen
 * gateway), so a card only offers entries its own agent could authenticate
 * against. Unknown agents fall back to the full catalog, matching the other
 * agent defaults above.
 */
function providersForKind(
  catalog: ProviderCatalogSnapshot,
  kind: string | undefined,
): ProviderOption[] {
  if (kind === undefined) return catalog.providers;
  return catalog.providers.filter((provider) => provider.kinds.includes(kind));
}

function validationLabel(repository: RepositorySummary): string {
  const commands = repository.validationCommands ?? [];
  if (commands.length === 0) return '<span class="muted">None configured</span>';
  return `<ul class="cmd-list">${commands.map((command) => `<li><code>${escapeHtml(command.join(" "))}</code></li>`).join("")}</ul>`;
}

const OPENCODE_EXECUTOR = "opencode";

const OPENCODE_PERMISSION_LABELS: Record<OpenCodePermission, string> = {
  edit: "edit workspace",
  shell: "run shell",
  web: "browse web",
  skill: "load skills",
};

/**
 * The executor kind a repository's configured agent runs as. An agent id is a
 * free operator label; its definition's kind selects the registered executor,
 * defaulting to the id itself — matching the config loader.
 */
function executorKindOf(repo: RepositorySummary, agents: AgentDefinitions): string | undefined {
  if (repo.agent === undefined) return undefined;
  return agents[repo.agent]?.kind ?? repo.agent;
}

/** Tool access in plain language; an empty permission list means read-only. */
function permissionPreset(permissions: readonly OpenCodePermission[]): string {
  return permissions.length === 0
    ? "read-only"
    : permissions
        .map((permission) => OPENCODE_PERMISSION_LABELS[permission] ?? permission)
        .join(", ");
}

function stepLimitChip(limit: number | null): string {
  return limit === null ? "" : `<span class="chip">step limit ${String(limit)}</span>`;
}

/**
 * The dashboard-managed OpenCode agent team as a readable repository summary:
 * the active primary, each subagent and whether the primary may call it, the
 * model each child runs with (an explicit override or inherited from the
 * repository's selected model), and tool access in plain language. Only
 * OpenCode-executor repositories render this section; a repository using
 * another executor shows no OpenCode controls at all, even when a dormant
 * profile is stored. An OpenCode repository without a saved profile states its
 * current default behavior. The Configure link is the direct dashboard entry
 * point for the repository-local editor, anchored at `#repo-agents-<id>`.
 */
function opencodeAgentsSection(repo: RepositorySummary, agents: AgentDefinitions): string {
  if (executorKindOf(repo, agents) !== OPENCODE_EXECUTOR) return "";
  const anchor = `repo-agents-${String(repo.id)}`;
  // The Configure link is the direct dashboard entry point for the
  // repository-local editor: the client fetches the authenticated full-profile
  // route (`/repos/:id/opencode-profile`) on click and mounts the editor here,
  // so the anchor is a no-JS fallback rather than the only behavior.
  const configure = `<a href="#${anchor}" data-repo-agents-configure data-repo-id="${String(repo.id)}" data-repo-agents-url="/repos/${String(repo.id)}/opencode-profile">Configure agents</a>`;
  const heading = `<h4>OpenCode agents ${configure}</h4>`;
  const profile = repo.opencodeProfile ?? null;
  if (profile === null) {
    return `<div class="repo-opencode-agents" id="${anchor}" data-opencode-agents data-repo-id="${String(repo.id)}" data-has-profile="0">${heading}<p class="repo-chips"><span class="chip">default behavior</span><span class="muted">No dashboard-managed agent team; OpenCode runs with its normal project and global configuration.</span></p></div>`;
  }
  const primaryModel =
    repo.model && repo.model.length > 0 ? repo.model : "the repository's selected model";
  const primary = `<li><span class="chip">primary <code>${escapeHtml(profile.primaryId)}</code></span><span class="chip">tools: ${escapeHtml(permissionPreset(profile.primaryPermissions))}</span>${stepLimitChip(profile.primaryStepLimit)}<small class="muted">${escapeHtml(profile.primaryDescription)}</small></li>`;
  const children =
    profile.subagents.length === 0
      ? '<li><span class="chip">no subagents</span><small class="muted">The primary cannot call a child until one is added and enabled.</small></li>'
      : profile.subagents
          .map((subagent) => {
            const callable = subagent.enabled ? "callable" : "disabled";
            const model = subagent.model === null ? `inherits ${primaryModel}` : subagent.model;
            return `<li><span class="chip"><code>${escapeHtml(subagent.id)}</code></span><span class="chip">${callable}</span><span class="chip">model: ${escapeHtml(model)}</span><span class="chip">tools: ${escapeHtml(permissionPreset(subagent.permissions))}</span>${stepLimitChip(subagent.stepLimit)}<small class="muted">${escapeHtml(subagent.description)}</small></li>`;
          })
          .join("");
  const foot = `<p class="panel-foot"><span class="chip" data-revision-value>revision ${String(profile.revision)}</span><span class="muted"> Only enabled children are callable. External-directory access and nested delegation are always denied for managed agents.</span></p>`;
  return `<div class="repo-opencode-agents" id="${anchor}" data-opencode-agents data-repo-id="${String(repo.id)}" data-has-profile="1" data-revision="${String(profile.revision)}">${heading}<ul class="cmd-list">${primary}${children}</ul>${foot}</div>`;
}

const CUSTOM_PROVIDER = "__custom__";

function providerOptionLabel(provider: { name: string; auth: string }): string {
  return `${provider.name} — ${provider.auth}`;
}

function modelOptionLabel(model: ProviderModelOption): string {
  return model.name;
}

function modelDescription(model: ProviderModelOption): string {
  return model.description ?? "";
}

function modelBadgeLabels(model: ProviderModelOption): string[] {
  const tier =
    model.tier === "recommended"
      ? "RECOMMENDED"
      : model.tier === "free"
        ? "FREE"
        : model.tier === "subscribed"
          ? "PASS"
          : undefined;
  return [
    ...new Set([tier, ...(model.tags ?? [])].filter((label): label is string => Boolean(label))),
  ];
}

function modelBadgeClass(label: string): string {
  const normalized = label.toLowerCase().replace(/[^a-z0-9]+/gu, "-");
  return `model-badge-${normalized || "default"}`;
}

function modelBadges(model: ProviderModelOption): string {
  return modelBadgeLabels(model)
    .map(
      (label) => `<span class="model-badge ${modelBadgeClass(label)}">${escapeHtml(label)}</span>`,
    )
    .join("");
}

function effortLabel(effort: ReasoningEffort): string {
  return effort === "xhigh" ? "Extra high" : effort.charAt(0).toUpperCase() + effort.slice(1);
}

function effortOptions(
  repo: RepositorySummary,
  configuredEfforts: readonly ReasoningEffort[],
): string {
  const efforts = [...configuredEfforts];
  const current = repo.effort;
  if (current && !efforts.includes(current as ReasoningEffort)) {
    efforts.push(current as ReasoningEffort);
  }
  return efforts
    .map(
      (effort) =>
        `<option value="${escapeHtml(effort)}"${effort === current ? " selected" : ""}>${escapeHtml(effortLabel(effort))}</option>`,
    )
    .join("");
}

function modelOptions(
  repo: RepositorySummary,
  providerId: string,
  catalog: ProviderCatalogSnapshot,
): string {
  const provider = catalog.providers.find((entry) => entry.id === providerId);
  if (!provider) return "";
  const models = [...provider.models];
  const current = repo.model ?? "";
  if (providerId === repo.provider) {
    for (const id of [current]) {
      if (!id || models.some((model) => model.id === id)) continue;
      models.push({ id, name: id, tags: ["CURRENT"] });
    }
  }
  return models
    .map((model) => {
      const selected = providerId === repo.provider && model.id === current ? " selected" : "";
      return `<option value="${escapeHtml(model.id)}" data-provider-id="${escapeHtml(provider.id)}" data-model-name="${escapeHtml(model.name)}" data-model-tier="${escapeHtml(model.tier ?? "")}" data-model-tags="${escapeHtml((model.tags ?? []).join("|"))}" data-model-description="${escapeHtml(modelDescription(model))}"${selected}>${escapeHtml(modelOptionLabel(model))}</option>`;
    })
    .join("");
}

function modelProviderControl(
  repo: RepositorySummary,
  catalog: ProviderCatalogSnapshot,
  agents: AgentDefinitions,
): string {
  const providerId = repo.provider ?? "";
  const { efforts, providerOptional, kind } = agentOptionsFor(repo, agents);
  const providers = providersForKind(catalog, kind);
  const knownProvider = providers.find((provider) => provider.id === providerId);
  const knownProviderForAnotherKind = catalog.providers.find(
    (provider) => provider.id === providerId,
  );
  const providerMismatch =
    providerId.length > 0 && !knownProvider && knownProviderForAnotherKind !== undefined;
  // An empty provider is a real state for provider-optional agents, not an
  // unnamed custom one — render it as its own selectable option so saving the
  // card round-trips the empty value instead of coercing it to a custom id.
  const emptyProvider = providerOptional && providerId === "";
  const providerValue =
    knownProvider || emptyProvider || providerMismatch ? providerId : CUSTOM_PROVIDER;
  const emptyOption = providerOptional
    ? `<option value=""${emptyProvider ? " selected" : ""}>None — provider is folded into the model id</option>`
    : "";
  const mismatchOption = providerMismatch
    ? `<option value="${escapeHtml(providerId)}" data-provider-mismatch selected>Current provider: ${escapeHtml(providerId)} (not supported by ${escapeHtml(kind ?? "this agent")})</option>`
    : "";
  const providerOptions = [mismatchOption, emptyOption]
    .concat(
      providers.map(
        (provider) =>
          `<option value="${escapeHtml(provider.id)}"${provider.id === providerId ? " selected" : ""}>${escapeHtml(providerOptionLabel(provider))}</option>`,
      ),
    )
    .concat(
      `<option value="${CUSTOM_PROVIDER}"${providerValue === CUSTOM_PROVIDER ? " selected" : ""}>Custom provider</option>`,
    )
    .join("");
  const providerIsSelectable = knownProvider || emptyProvider || providerMismatch;
  const customProvider = `<input name="repo-provider-input-${repo.id}" data-repo-provider-input value="${escapeHtml(providerIsSelectable ? "" : providerId)}" placeholder="provider id"${providerIsSelectable ? " hidden" : ""}>`;
  const modelSelect = `<select name="repo-model-select-${repo.id}" data-repo-model-select data-repo-field="model"${knownProvider ? "" : " hidden"}>${providers.map((provider) => `<optgroup label="${escapeHtml(providerOptionLabel(provider))}">${modelOptions(repo, provider.id, catalog)}</optgroup>`).join("")}</select>`;
  const modelInput = `<input name="repo-model-input-${repo.id}" data-repo-model-input data-repo-field="model" value="${escapeHtml(repo.model ?? "")}" placeholder="model id"${knownProvider ? " hidden" : ""}>`;
  const effort = `<select name="repo-effort-${repo.id}" data-repo-effort data-repo-field="effort">${effortOptions(repo, efforts)}</select>`;
  const timeout = `<input name="repo-timeout-${repo.id}" data-repo-timeout type="number" min="1" step="1" inputmode="numeric" value="${repo.timeout_seconds === null || repo.timeout_seconds === undefined ? "" : String(repo.timeout_seconds)}" placeholder="No limit" aria-label="Agent timeout in seconds">`;
  const selectedModel = knownProvider?.models.find((model) => model.id === repo.model);
  const currentModel =
    selectedModel ??
    (repo.model
      ? {
          id: repo.model,
          name: repo.model,
          description: "Current repository model.",
          tags: ["CURRENT"],
        }
      : undefined);
  const modelHint = currentModel ? modelDescription(currentModel) : "Choose a model.";
  const modelMeta = currentModel
    ? `<strong data-repo-model-name>${escapeHtml(currentModel.name)}</strong><span class="model-picker-badges" data-repo-model-badges>${modelBadges(currentModel)}</span><code class="model-picker-id" data-repo-model-id>ID: ${escapeHtml(currentModel.id)}</code>`
    : `<strong data-repo-model-name>Choose a model</strong><span class="model-picker-badges" data-repo-model-badges></span><code class="model-picker-id" data-repo-model-id hidden></code>`;
  const hint = knownProvider
    ? `${knownProvider.description} All catalog models are selectable.`
    : emptyProvider
      ? "No separate provider; enter the model id in provider/model form."
      : providerMismatch
        ? `Provider ${providerId} is not supported by the configured ${kind ?? "agent"}; choose a supported provider to replace it.`
        : "Custom provider; enter the exact provider and model ids.";
  return `<div class="model-provider-picker" data-action-scope="settings-${String(repo.id)}" data-repo-picker data-repo-id="${repo.id}" data-catalog-source="${catalog.source}" data-saved-provider="${escapeHtml(providerId)}" data-saved-model="${escapeHtml(repo.model ?? "")}" data-saved-effort="${escapeHtml(repo.effort ?? "")}" data-saved-timeout="${escapeHtml(repo.timeout_seconds === null || repo.timeout_seconds === undefined ? "" : String(repo.timeout_seconds))}"${kind ? ` data-agent-kind="${escapeHtml(kind)}"` : ""}${providerOptional ? " data-provider-optional" : ""}${providerMismatch ? ` data-provider-mismatch="${escapeHtml(providerId)}"` : ""}><label>Provider <select name="repo-provider-${repo.id}" data-repo-provider-select data-repo-field="provider" data-provider-value="${escapeHtml(providerId)}">${providerOptions}</select>${customProvider}</label>${providerMismatch ? `<small class="model-picker-mismatch" data-provider-mismatch-message>Provider mismatch: the persisted provider is not supported by this repository's configured agent.</small>` : ""}<label>Model ${modelSelect}${modelInput}</label><div class="model-picker-meta" data-repo-model-meta>${modelMeta}</div><small class="model-picker-description" data-repo-model-description>${escapeHtml(modelHint)}</small><label>Effort ${effort}</label><label>Timeout (seconds) ${timeout}</label><small class="model-picker-hint" data-repo-hint>${escapeHtml(hint)} Blank timeout means no limit. Effort tiers come from the configured agent.</small><p class="action-feedback" data-action-feedback data-action-announcement role="status" aria-live="polite" aria-atomic="true"></p></div>`;
}

export function repositoryCards(
  repositories: RepositorySummary[],
  catalog: ProviderCatalogSnapshot = bundledProviderCatalog(),
  agents: AgentDefinitions = {},
): string {
  if (repositories.length === 0) return '<p class="muted">No repositories configured.</p>';
  return `<div class="grid">${repositories.map((repo) => repositoryCard(repo, catalog, agents)).join("")}</div>`;
}

/**
 * The enable/disable state leads the card, because it is the one thing here
 * that decides whether the rest of the configuration does anything at all.
 * The toggle stays its sibling: the client script finds the label through the
 * button's parent when it swaps both after a successful POST.
 */
function repositoryCard(
  repo: RepositorySummary,
  catalog: ProviderCatalogSnapshot,
  agents: AgentDefinitions,
): string {
  const on = repo.enabled === 1;
  const head = `<header class="repo-head"><h3>${escapeHtml(`${repo.owner}/${repo.name}`)}</h3><span class="state state-${on ? "on" : "off"}" data-enabled>${on ? "enabled" : "disabled"}</span><button data-action="toggle-repository" data-url="/repos/${repo.id}/toggle">${on ? "Disable" : "Enable"}</button></header>`;
  const chips = `<p class="repo-chips"><span class="chip">agent <code>${escapeHtml(repo.agent ?? "unknown")}</code></span><span class="chip">effort <code>${escapeHtml(repo.effort ?? "unknown")}</code></span></p>`;
  const validation = `<div class="repo-validation"><h4>Validation commands</h4>${validationLabel(repo)}</div>`;
  const opencode = opencodeAgentsSection(repo, agents);
  return `<article class="card repo-card" data-presentation="quiet" data-action-scope="repository-${String(repo.id)}" data-live-key="repository-${String(repo.id)}">${head}${chips}<div class="repo-defaults">${modelProviderControl(repo, catalog, agents)}</div>${opencode}${validation}<p class="action-feedback" data-action-feedback data-action-announcement role="status" aria-live="polite" aria-atomic="true"></p></article>`;
}

/**
 * A job as a two-line row rather than a run-on sentence of links and dashes.
 *
 * The repository and PR are the identity and lead; the status pill sits at the
 * far right where the eye can scan a whole lane's states in one vertical pass;
 * the command and timings drop to a quieter second line.
 */
function jobItem(job: JobSummary): string {
  const meta = [
    `<code>${escapeHtml(job.command)}</code>`,
    relativeTimeElement(job.created_at),
    `<span class="job-row-elapsed">${elapsedTimeElement(job.created_at, job.finished_at)}</span>`,
  ].join("");
  return `<li class="job-row" data-live-key="job-${String(job.id)}"><a class="job-row-main" href="/jobs/${job.id}"><span class="job-row-repo">${escapeHtml(`${job.owner}/${job.name}`)} <span class="job-row-pr">#${String(job.pr_number)}</span></span>${statusPill(job.status)}</a><span class="job-row-meta">${meta}</span></li>`;
}

export function jobLane(title: string, jobs: JobSummary[], regionId?: string): string {
  const body = jobs.length
    ? `<ul class="job-rows">${jobs.map(jobItem).join("")}</ul>`
    : '<p class="lane-empty muted">No jobs in this lane.</p>';
  const lane = title.toLowerCase().split(" ")[0] ?? "lane";
  const content = `<section class="panel presentation-panel lane lane-${escapeHtml(lane)}" data-presentation="panel"><h2 data-focus-fallback tabindex="-1">${escapeHtml(title)} <span class="lane-count">${String(jobs.length)}</span></h2>${body}</section>`;
  return regionId ? `<div id="${regionId}">${content}</div>` : content;
}

export function dashboardRegions(
  model: DashboardModel,
  catalog: ProviderCatalogSnapshot = bundledProviderCatalog(),
  agents: AgentDefinitions = {},
  _timeZone?: string,
): {
  health: string;
  repositories: string;
  jobs: string;
} {
  const health = model.health;
  const tracked = model.running.length + model.queued.length;
  const summary = `${String(model.repositories.length)} ${model.repositories.length === 1 ? "repository" : "repositories"} · ${String(tracked)} active ${tracked === 1 ? "job" : "jobs"}`;
  const catalogStatus = catalog.updatedAt
    ? `Cline catalog refreshed ${relativeTimeElement(catalog.updatedAt)}.`
    : "Cline catalog fallback is ready; live featured models refresh when available.";
  // The note describes the pickers directly below it, so it belongs inside the
  // repositories region rather than stranded at the top of the page.
  const catalogNote = `<p class="catalog-note">Provider catalog: ${catalogStatus} Cline models use provider-qualified ids; OpenAI Codex models use bare Codex ids.</p>`;
  return {
    health: `<div class="health-summary">${statusPill(health.status)}<span class="muted page-summary">${escapeHtml(summary)}</span></div><section class="stat-strip" aria-label="Orchestrator health"><div class="metric ${health.stale ? "stale" : ""}"><span>Orchestrator</span><strong>${escapeHtml(health.status)}</strong><small>${health.lastPolledAt ? `last poll ${relativeTimeElement(health.lastPolledAt)}` : "no poll recorded"}</small></div><div class="metric"><span>Poll freshness</span><strong>${health.lastPolledAt ? relativeTimeElement(health.lastPolledAt) : "—"}</strong><small>${health.stale ? "stale — polling may have stopped" : `interval ${String(health.pollIntervalSec)}s`}</small></div><div class="metric"><span>Queue depth</span><strong>${String(health.queueDepth)}</strong><small>jobs waiting</small></div><div class="metric"><span>Concurrency</span><strong>${String(health.inFlight)} / ${String(health.concurrency)}</strong><small>jobs executing</small></div></section>`,
    repositories: `<h2 data-focus-fallback tabindex="-1">Repositories <span class="muted panel-note">${String(model.repositories.length)}</span></h2>${catalogNote}${repositoryCards(model.repositories, catalog, agents)}`,
    jobs: `<div class="lanes">${jobLane("Running", model.running)}${jobLane("Queued", model.queued)}${jobLane("Recent successes and failures", model.recent)}</div>`,
  };
}

/**
 * Health first, then the work, then the configuration.
 *
 * The lanes used to sit below the repository cards — a wall of model pickers
 * stood between an operator and the one thing they open this page to see.
 */
export function dashboardView(
  model: DashboardModel,
  catalog: ProviderCatalogSnapshot = bundledProviderCatalog(),
  agents: AgentDefinitions = {},
  timeZone?: string,
): string {
  const regions = dashboardRegions(model, catalog, agents, timeZone);
  const head = `<header class="page-head presentation-peak" data-presentation="peak"><div class="page-title"><h1 data-focus-fallback tabindex="-1">Dashboard</h1></div><div id="health-region">${regions.health}</div></header>`;
  return `<div class="dash-page">${head}<div id="job-lanes" class="presentation-panel" data-presentation="panel">${regions.jobs}</div><section class="panel presentation-panel" data-presentation="panel" id="repositories">${regions.repositories}</section></div>`;
}
