import type { DashboardModel, JobSummary, RepositorySummary } from "../queries.js";
import {
  bundledProviderCatalog,
  type ProviderCatalogSnapshot,
  type ProviderModelOption,
} from "../../agent/provider-catalog.js";
import { duration, escapeHtml, relativeTimestamp, statusPill } from "./components.js";

function validationLabel(repository: RepositorySummary): string {
  const commands = repository.validationCommands ?? [];
  if (commands.length === 0) return '<span class="muted">No validation commands configured</span>';
  return `<ul>${commands.map((command) => `<li><code>${escapeHtml(command.join(" "))}</code></li>`).join("")}</ul>`;
}

const CUSTOM_PROVIDER = "__custom__";

function providerOptionLabel(provider: { name: string; auth: string }): string {
  return `${provider.name} — ${provider.auth}`;
}

function modelOptionLabel(model: ProviderModelOption): string {
  const tags = model.tags?.length ? ` · ${model.tags.join(" · ")}` : "";
  const tier = model.tier === "free" ? " · FREE" : model.tier === "subscribed" ? " · PASS" : "";
  return `${model.name}${tier}${tags}`;
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
      return `<option value="${escapeHtml(model.id)}" data-provider-id="${escapeHtml(provider.id)}"${selected}>${escapeHtml(modelOptionLabel(model))}</option>`;
    })
    .join("");
}

function modelProviderControl(repo: RepositorySummary, catalog: ProviderCatalogSnapshot): string {
  const providerId = repo.provider ?? "";
  const knownProvider = catalog.providers.find((provider) => provider.id === providerId);
  const providerValue = knownProvider ? providerId : CUSTOM_PROVIDER;
  const providerOptions = catalog.providers
    .map(
      (provider) =>
        `<option value="${escapeHtml(provider.id)}"${provider.id === providerId ? " selected" : ""}>${escapeHtml(providerOptionLabel(provider))}</option>`,
    )
    .concat(
      `<option value="${CUSTOM_PROVIDER}"${providerValue === CUSTOM_PROVIDER ? " selected" : ""}>Custom provider</option>`,
    )
    .join("");
  const customProvider = `<input name="repo-provider-input-${repo.id}" data-repo-provider-input value="${escapeHtml(knownProvider ? "" : providerId)}" placeholder="provider id"${knownProvider ? " hidden" : ""}>`;
  const modelSelect = `<select name="repo-model-select-${repo.id}" data-repo-model-select data-repo-field="model"${knownProvider ? "" : " hidden"}>${catalog.providers.map((provider) => modelOptions(repo, provider.id, catalog)).join("")}</select>`;
  const modelInput = `<input name="repo-model-input-${repo.id}" data-repo-model-input data-repo-field="model" value="${escapeHtml(repo.model ?? "")}" placeholder="model id"${knownProvider ? " hidden" : ""}>`;
  const hint = knownProvider
    ? `${knownProvider.description} All catalog models are selectable.`
    : "Custom provider; enter the exact provider and model ids.";
  return `<div class="model-provider-picker" data-repo-picker data-repo-id="${repo.id}" data-catalog-source="${catalog.source}"><label>Provider <select name="repo-provider-${repo.id}" data-repo-provider-select data-repo-field="provider" data-provider-value="${escapeHtml(providerId)}">${providerOptions}</select>${customProvider}</label><label>Model ${modelSelect}${modelInput}</label><small class="model-picker-hint" data-repo-hint>${escapeHtml(hint)}</small></div>`;
}

export function repositoryCards(
  repositories: RepositorySummary[],
  catalog: ProviderCatalogSnapshot = bundledProviderCatalog(),
): string {
  if (repositories.length === 0) return '<p class="muted">No repositories configured.</p>';
  return `<div class="grid">${repositories.map((repo) => `<article class="card"><h3>${escapeHtml(`${repo.owner}/${repo.name}`)}</h3><p>Agent <strong>${escapeHtml(repo.agent ?? "unknown")}</strong> · Effort <strong>${escapeHtml(repo.effort ?? "unknown")}</strong></p><div class="repo-defaults">${modelProviderControl(repo, catalog)}</div><p><strong>Validation commands</strong>${validationLabel(repo)}</p><p>State: <strong data-enabled>${repo.enabled === 1 ? "enabled" : "disabled"}</strong> <button data-action="toggle-repository" data-url="/repos/${repo.id}/toggle">${repo.enabled === 1 ? "Disable" : "Enable"}</button></p></article>`).join("")}</div>`;
}

function jobItem(job: JobSummary): string {
  return `<li><a href="/jobs/${job.id}">${escapeHtml(`${job.owner}/${job.name} PR #${job.pr_number}`)}</a> — ${statusPill(job.status)} <span class="muted">created ${relativeTimestamp(job.created_at)}</span>${job.finished_at ? ` · ${duration(job.created_at, job.finished_at)}` : ""}</li>`;
}

export function jobLane(title: string, jobs: JobSummary[], regionId?: string): string {
  const content = `<section class="panel"><h2>${escapeHtml(title)}</h2>${jobs.length ? `<ul>${jobs.map(jobItem).join("")}</ul>` : '<p class="muted">No jobs in this lane.</p>'}</section>`;
  return regionId ? `<div id="${regionId}">${content}</div>` : content;
}

export function dashboardRegions(
  model: DashboardModel,
  catalog: ProviderCatalogSnapshot = bundledProviderCatalog(),
): {
  health: string;
  repositories: string;
  jobs: string;
} {
  const health = model.health;
  return {
    health: `<section class="health" aria-label="Orchestrator health"><div class="metric ${health.stale ? "stale" : ""}"><span>Orchestrator</span><strong>${escapeHtml(health.status)}</strong><small>${health.lastPolledAt ? `last poll ${relativeTimestamp(health.lastPolledAt)}` : "no poll recorded"}</small></div><div class="metric"><span>Poll freshness</span><strong>${health.pollAgeSec === null ? "—" : `${health.pollAgeSec}s`}</strong><small>${health.stale ? "stale — polling may have stopped" : `interval ${health.pollIntervalSec}s`}</small></div><div class="metric"><span>Queue depth</span><strong>${health.queueDepth}</strong><small>jobs waiting</small></div><div class="metric"><span>Concurrency</span><strong>${health.inFlight} / ${health.concurrency}</strong><small>jobs executing</small></div></section>`,
    repositories: `<h2>Repositories</h2>${repositoryCards(model.repositories, catalog)}`,
    jobs: `<div class="lanes">${jobLane("Running", model.running)}${jobLane("Queued", model.queued)}${jobLane("Recent successes and failures", model.recent)}</div>`,
  };
}

export function dashboardView(
  model: DashboardModel,
  catalog: ProviderCatalogSnapshot = bundledProviderCatalog(),
): string {
  const regions = dashboardRegions(model, catalog);
  const catalogStatus = catalog.updatedAt
    ? `Cline catalog refreshed ${relativeTimestamp(catalog.updatedAt)}.`
    : "Cline catalog fallback is ready; live featured models refresh when available.";
  return `<h1>Dashboard</h1><p class="sr-status" data-live-status role="status">Live updates are connected when supported.</p><p class="catalog-note">Provider catalog: ${escapeHtml(catalogStatus)} Cline models use provider-qualified ids; OpenAI Codex models use bare Codex ids.</p><div id="health-region">${regions.health}</div><section class="panel" id="repositories">${regions.repositories}</section><div id="job-lanes">${regions.jobs}</div>`;
}
