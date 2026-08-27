# Gremlyn

Gremlyn is a local PR-resolution orchestrator. It polls configured GitHub repositories for an authorized `!RESOLVE` reply on an inline review thread, prepares an isolated git worktree, runs Cline, independently validates the result, pushes a normal commit to the existing PR branch, and replies with the outcome. The developer's normal checkout is never modified.

## Requirements

- Windows 10/11 with PowerShell (WSL is not required)
- Node.js 22 or newer and npm 10 or newer
- Git 2.x
- Cline CLI 3.0.60, already authenticated with the provider used by your configured model
- A dedicated GitHub account and token for Gremlyn

The GitHub token should have only the repository permissions needed to read pull requests and review comments, post review replies, and push to existing PR branches. Do not use your personal token if a dedicated bot identity is available.

## Install

```powershell
git clone https://github.com/cnhy-nero-diskard/Gremlyn.git
Set-Location Gremlyn
npm ci
npm run build
npm test
```

Copy the complete example configuration and create local secrets:

```powershell
Copy-Item .\config.example.yaml .\gremlyn.yaml
$env:GREMLYN_GITHUB_TOKEN = 'your-dedicated-bot-token'
$env:GREMLYN_CONSOLE_TOKEN = 'generate-a-long-random-local-token'
```

Never put either token in `gremlyn.yaml`. The file names the environment variables; secret values come from the environment only.

## Configure

Edit `gremlyn.yaml`:

- Set `github.orchestrator_login` to the login authenticated by `GREMLYN_GITHUB_TOKEN`.
- Put permitted human GitHub logins in `allowed_authors`. The bot login must not appear there.
- For each repository, set its exact `owner`, `name`, local `source_path`, and a separate `workspace_root`.
- Keep `source_path` and `workspace_root` distinct. Workspaces are created as `<workspace_root>/pr-<number>`.
- Set `agent: cline`, the provider-qualified `model`, and `allowed_models`.
- Set validation commands as argument arrays, for example `[npm, test]`. An empty list intentionally performs git inspection only; Gremlyn never invents fallback commands.
- Leave `effort` unset to use Cline's highest supported tier, `xhigh`.

Confirm the configured source repository has an `origin` remote and that the bot has push access to same-repository PR branches. Fork PRs are deliberately unsupported.

## Start and verify connectivity

```powershell
npm start -- .\gremlyn.yaml
```

Startup validates the configuration, the GitHub bot identity, Cline version, data-directory exclusivity, and console bind. A successful start logs `orchestrator started` and begins polling.

Open `http://127.0.0.1:4780/auth`, enter `GREMLYN_CONSOLE_TOKEN`, and confirm the dashboard lists each configured repository. Then add `!RESOLVE` as a reply in an inline PR review thread authored by an allowlisted login. The console should show the job progressing through queued, preparing, running, validating, publishing, reporting, and a terminal state.

Stop with `Ctrl+C`. Gremlyn marks jobs left in transient states as interrupted on the next startup; it does not silently rerun them.

## Development

```powershell
npm ci
npm run build
npm run lint
npm run format:check
npm test
```

Tests use fixture GitHub clients, a fake agent, and temporary real git repositories. They do not need network access or paid agent invocations. `npm start -- .\gremlyn.yaml` is the production connectivity check and does use GitHub and Cline.

## Troubleshooting

- `github token missing` or `console token missing`: define the named environment variable in the same PowerShell process before starting.
- `token authenticates as ..., expected ...`: correct `github.orchestrator_login` or use the dedicated account's token.
- `unsupported Cline version`: install Cline 3.0.60; startup refuses a drifting CLI surface rather than failing during a job.
- `another Gremlyn instance is already using data directory`: stop the other process before starting a second instance against the same `data_dir`.
- `workspace-dirty`, `workspace-conflicted`, or `workspace-corrupted`: inspect the per-PR workspace. Gremlyn preserves evidence and requires an explicit confirmed reset from the console.
- `pull-request-closed`, `head-changed`, or `push-rejected`: refresh the PR state and retry deliberately. Gremlyn never force-pushes.
- Console returns `401`: sign in again at `/auth`; every job-data and action route requires the console token.
- No command is detected: `!RESOLVE` must be a standalone token at the start of a line in an inline review-comment thread, not a top-level PR conversation comment or quoted code.

Captured agent and validation output is stored beneath `data_dir`; SQLite stores references and structured lifecycle records. Configured secrets are redacted from logs and console views.
