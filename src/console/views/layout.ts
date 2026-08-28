import { clientScriptPath, stylesheetPath } from "../assets.js";
import { escapeHtml } from "./components.js";

export function layout(title: string, body: string, options: { stream?: string } = {}): string {
  const stream = options.stream ? `<div data-stream="${escapeHtml(options.stream)}"></div>` : "";
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${escapeHtml(title)}</title><link rel="stylesheet" href="${stylesheetPath}"></head><body><div class="shell"><header class="site-header"><strong>Gremlyn operator console</strong><nav><a href="/">Dashboard</a><a href="/commands">Commands</a><a href="/audit">Audit</a></nav></header><main>${body}</main>${stream}</div><script src="${clientScriptPath}" defer></script></body></html>`;
}

export function authLayout(): string {
  return layout(
    "Gremlyn sign in",
    `<section class="signin card"><h1>Sign in</h1><p>Authenticate to view jobs and operational state.</p><label for="token">Console token</label><input id="token" type="password" autocomplete="current-password"><button class="primary" data-sign-in>Sign in</button><p class="sr-status" data-auth-error role="alert"></p></section>`,
  );
}
