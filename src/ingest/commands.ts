import type { GitHubClient } from "../github/client.js";
import type { NormalizedEvent, ParsedCommand } from "../types.js";

export interface CommandDefinition {
  name: string;
  eligibleKinds: NormalizedEvent["kind"][];
}

export class CommandRegistry {
  private readonly definitions = new Map<string, CommandDefinition>();

  register(definition: CommandDefinition): void {
    const name = definition.name.toUpperCase();
    if (!/^[A-Z][A-Z0-9-]*$/.test(name)) {
      throw new Error(`invalid command name: ${definition.name}`);
    }
    if (this.definitions.has(name)) throw new Error(`command already registered: ${name}`);
    this.definitions.set(name, { ...definition, name });
  }

  get(name: string): CommandDefinition | undefined {
    return this.definitions.get(name.toUpperCase());
  }

  detect(body: string): ParsedCommand[] {
    const found: ParsedCommand[] = [];
    let fence: "```" | "~~~" | null = null;
    for (const line of body.split(/\r?\n/u)) {
      const trimmed = line.trimStart();
      if (fence !== null) {
        if (trimmed.startsWith(fence)) fence = null;
        continue;
      }
      if (trimmed.startsWith("```") || trimmed.startsWith("~~~")) {
        fence = trimmed.slice(0, 3) as "```" | "~~~";
        continue;
      }
      if (trimmed.startsWith(">")) continue;
      const match = /^!([A-Za-z][A-Za-z0-9-]*)(?:\s+(.*?))?\s*$/u.exec(trimmed);
      if (!match) continue;
      const definition = this.get(match[1]!);
      if (!definition) continue;
      const rawArgs = match[2]?.trim();
      found.push({
        name: definition.name,
        args: rawArgs ? rawArgs.split(/\s+/u) : [],
      });
    }
    return found;
  }
}

export function createDefaultCommandRegistry(): CommandRegistry {
  const registry = new CommandRegistry();
  registry.register({ name: "RESOLVE", eligibleKinds: ["review-comment"] });
  return registry;
}

export type PlacementResult =
  { kind: "accepted" } | { kind: "rejected"; reason: "command-placement" };

export async function enforceCommandPlacement(
  event: NormalizedEvent,
  command: ParsedCommand,
  registry: CommandRegistry,
  github: GitHubClient,
): Promise<PlacementResult> {
  const definition = registry.get(command.name);
  if (!definition) throw new Error(`unregistered command: ${command.name}`);
  if (definition.eligibleKinds.includes(event.kind)) return { kind: "accepted" };

  await github.postConversationReply(
    event.owner,
    event.repo,
    event.prNumber,
    "`!RESOLVE` must be used in a pull-request review comment thread so file and diff context are available.",
  );
  return { kind: "rejected", reason: "command-placement" };
}
