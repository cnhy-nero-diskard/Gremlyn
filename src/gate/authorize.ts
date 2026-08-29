import type Database from "better-sqlite3";
import { isForkPullRequest, type GitHubClient, type PullRequestInfo } from "../github/client.js";
import type { CommandRegistry } from "../ingest/commands.js";
import { AuthorizationStore } from "../store/authorization.js";
import type { NormalizedEvent, ParsedCommand } from "../types.js";

export interface AuthorizationRepository {
  id: number;
  owner: string;
  name: string;
  enabled: boolean;
  allowedModels: string[];
  defaultModel: string;
}

export type AuthorizationReason =
  | "repository-unregistered"
  | "orchestrator-authored"
  | "author-not-allowed"
  | "repository-disabled"
  | "repository-mismatch"
  | "pull-request-not-open"
  | "fork-pull-request"
  | "command-unregistered"
  | "command-placement"
  | "duplicate-command"
  | "invalid-command-arguments";

export type AuthorizationResult =
  | { kind: "authorized"; pullRequest: PullRequestInfo; model: string }
  | { kind: "rejected" | "ignored"; reason: AuthorizationReason };

export interface AuthorizeCommandOptions {
  event: NormalizedEvent;
  command: ParsedCommand;
  repository: AuthorizationRepository | null;
  allowedAuthors: string[];
  orchestratorLogin: string;
  registry: CommandRegistry;
  github: GitHubClient;
  db: Database.Database;
}

export async function authorizeCommand(
  options: AuthorizeCommandOptions,
): Promise<AuthorizationResult> {
  const { event, command, repository } = options;
  if (repository === null) {
    return { kind: "ignored", reason: "repository-unregistered" };
  }
  const audit = new AuthorizationStore(options.db);
  const reject = (
    kind: "rejected" | "ignored",
    reason: AuthorizationReason,
  ): AuthorizationResult => {
    audit.record(repository.id, event, command, kind, reason);
    return { kind, reason };
  };

  // Poll checkpoints may intentionally overlap. Deduplicate before any path
  // writes an authorization outcome or posts guidance, including ignored bot
  // comments and rejected commands.
  if (audit.isProcessed(repository.id, event, command)) {
    return { kind: "ignored", reason: "duplicate-command" };
  }

  if (sameLogin(event.authorLogin, options.orchestratorLogin)) {
    return reject("ignored", "orchestrator-authored");
  }
  if (!options.allowedAuthors.some((login) => sameLogin(login, event.authorLogin))) {
    return reject("rejected", "author-not-allowed");
  }
  if (!repository.enabled) return reject("ignored", "repository-disabled");
  const definition = options.registry.get(command.name);
  if (!definition) return reject("rejected", "command-unregistered");
  if (!definition.eligibleKinds.includes(event.kind)) {
    await options.github.postConversationReply(
      event.owner,
      event.repo,
      event.prNumber,
      `!${command.name} must be used in an eligible review location.`,
    );
    return reject("rejected", "command-placement");
  }
  const pullRequest = await options.github.getPullRequest(event.owner, event.repo, event.prNumber);
  if (
    !sameLogin(repository.owner, event.owner) ||
    repository.name.toLowerCase() !== event.repo.toLowerCase() ||
    !sameLogin(pullRequest.baseRepoOwner, event.owner) ||
    pullRequest.baseRepoName.toLowerCase() !== event.repo.toLowerCase()
  ) {
    return reject("rejected", "repository-mismatch");
  }
  if (pullRequest.state !== "open" || pullRequest.merged) {
    return reject("rejected", "pull-request-not-open");
  }
  if (isForkPullRequest(pullRequest)) {
    await options.github.postReviewReply(
      event.owner,
      event.repo,
      event.prNumber,
      event.commentId,
      "Gremlyn cannot resolve this command because fork pull requests are not supported.",
    );
    return reject("rejected", "fork-pull-request");
  }
  if (command.args.length > 1) {
    const result = reject("rejected", "invalid-command-arguments");
    await options.github.postReviewReply(
      event.owner,
      event.repo,
      event.prNumber,
      event.commentId,
      `Gremlyn rejected !${command.name}: expected at most one model argument, but received ${String(command.args.length)}.`,
    );
    return result;
  }
  const model = command.args[0] ?? repository.defaultModel;
  return { kind: "authorized", pullRequest, model };
}

function sameLogin(left: string, right: string): boolean {
  return left.localeCompare(right, undefined, { sensitivity: "accent" }) === 0;
}
