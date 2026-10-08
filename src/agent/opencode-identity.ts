import { resolve } from "node:path";
import {
  parseSessionRecord,
  sessionRecordPath,
  type ManagedSessionHttp,
} from "./managed-sessions.js";

/** Only runtime identity evidence is retained; message content is never returned. */
export interface OpenCodeInitialIdentity {
  readonly agentId?: string;
  readonly model?: string;
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function identifier(value: unknown): string | undefined {
  return typeof value === "string" &&
    value.length > 0 &&
    value.length <= 256 &&
    !/[\p{Cc}\p{Cf}]/u.test(value)
    ? value
    : undefined;
}

/** Parse only the attributable top-level run-stream session ID, never nested tool output. */
export function openCodeStreamParentId(line: string): string | undefined {
  try {
    const value: unknown = JSON.parse(line);
    if (!record(value)) return undefined;
    const id = identifier(value.sessionID);
    return id !== undefined && /^ses[A-Za-z0-9_-]+$/u.test(id) ? id : undefined;
  } catch {
    return undefined;
  }
}

function sameDirectory(left: string, right: string): boolean {
  const a = resolve(left);
  const b = resolve(right);
  return process.platform === "win32" ? a.toLowerCase() === b.toLowerCase() : a === b;
}

/**
 * Read the FIRST assistant identity, not the mutable current session agent.
 * Pinned V2 message listing applies type/order before pagination. Root attribution
 * must agree first; an unavailable identity stays unknown rather than borrowing
 * the requested label or forwarding private message/configuration content.
 */
export async function readOpenCodeInitialIdentity(input: {
  readonly http: ManagedSessionHttp;
  readonly parentSessionId: string;
  readonly cwd: string;
  readonly timeoutMs?: number;
}): Promise<OpenCodeInitialIdentity> {
  const budget = input.timeoutMs ?? 5_000;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const read = async (): Promise<OpenCodeInitialIdentity> => {
    const response = await input.http.get(sessionRecordPath(input.parentSessionId));
    if (response.status !== 200) return {};
    const parent = parseSessionRecord(response.body);
    if (
      parent === undefined ||
      parent.id !== input.parentSessionId ||
      parent.parentID !== undefined ||
      !sameDirectory(parent.directory, input.cwd)
    )
      return {};
    const messages = await input.http.get(`${sessionRecordPath(input.parentSessionId)}/message`, {
      type: "assistant",
      order: "asc",
      limit: "1",
    });
    if (messages.status !== 200 || !record(messages.body) || !Array.isArray(messages.body.data))
      return {};
    const first: unknown = messages.body.data[0];
    if (!record(first) || first.type !== "assistant") return {};
    const agentId = identifier(first.agent);
    let model: string | undefined;
    if (record(first.model)) {
      const provider = identifier(first.model.providerID);
      const id = identifier(first.model.id);
      const variant = identifier(first.model.variant);
      if (provider !== undefined && id !== undefined) {
        model = `${provider}/${id}${variant === undefined ? "" : `#${variant}`}`;
      }
    }
    return {
      ...(agentId === undefined ? {} : { agentId }),
      ...(model === undefined ? {} : { model }),
    };
  };
  try {
    return await Promise.race([
      read(),
      new Promise<OpenCodeInitialIdentity>((done) => {
        timer = setTimeout(() => done({}), Math.max(0, budget));
      }),
    ]);
  } catch {
    return {};
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}
