import { clientScriptPath, stylesheetPath } from "../assets.js";
import { escapeHtml } from "./components.js";

export type ConsoleSection = "dashboard" | "commands" | "audit";
export type SignInReason = "invalid" | "expired" | "signed-out";

export function layout(
  title: string,
  body: string,
  options: {
    stream?: string;
    wide?: boolean;
    authenticated?: boolean;
    section?: ConsoleSection;
  } = {},
): string {
  const stream = options.stream ? `<div data-stream="${escapeHtml(options.stream)}"></div>` : "";
  const authenticated = options.authenticated !== false;
  const section = options.section ?? "dashboard";
  const current = (name: ConsoleSection): string =>
    authenticated && section === name ? ' aria-current="page"' : "";
  const navigation = authenticated
    ? `<nav aria-label="Primary"><a href="/"${current("dashboard")}>Dashboard</a><a href="/commands"${current("commands")}>Commands</a><a href="/audit"${current("audit")}>Audit</a><form method="post" action="/auth/sign-out"><button type="submit">Sign out</button></form></nav>`
    : "";
  const liveChannels = authenticated
    ? `<p class="console-status" data-connection-status role="status" aria-live="polite" aria-atomic="true">Live updates are ready.</p><div class="sr-only" data-operation-announcer role="status" aria-live="polite" aria-atomic="true"></div>`
    : "";
  // The job page runs two live panels side by side and needs the room; the
  // list pages read better held to a comfortable measure.
  const shell = options.wide ? "shell shell-wide" : "shell";
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${escapeHtml(title)}</title><link rel="stylesheet" href="${stylesheetPath}"></head><body><div class="${shell}"><header class="site-header presentation-quiet" data-presentation="quiet"><strong>Gremlyn operator console</strong>${navigation}</header>${liveChannels}<main>${body}</main>${stream}</div><script src="${clientScriptPath}" defer></script></body></html>`;
}

export function authLayout(reason?: SignInReason): string {
  const message =
    reason === "invalid"
      ? "The token was not accepted. Try again."
      : reason === "expired"
        ? "Your session expired. Sign in again to continue."
        : reason === "signed-out"
          ? "You have been signed out."
          : "";
  const error = `<p id="auth-error" class="sr-status auth-error" data-auth-error role="alert"${message ? "" : " hidden"}>${escapeHtml(message)}</p>`;
  return layout(
    "Gremlyn sign in",
    `<section class="signin card presentation-peak" data-presentation="peak"><h1>Sign in</h1><p>Authenticate to view jobs and operational state.</p><form method="post" action="/auth" data-sign-in-form><label for="token">Console token</label><input id="token" name="token" type="password" autofocus autocomplete="off" value="" aria-describedby="auth-error"${message ? ' aria-invalid="true"' : ""}><button class="primary" type="submit">Sign in</button>${error}</form></section>`,
    { authenticated: false },
  );
}
