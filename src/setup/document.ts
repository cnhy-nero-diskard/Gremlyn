import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { isSeq, parseDocument, type Document, type YAMLSeq } from "yaml";
import { ConfigError, loadConfig } from "../config/loader.js";

/** Options that keep the example file byte-stable through a no-op round trip. */
export const DOCUMENT_STRINGIFY_OPTIONS = {
  flowCollectionPadding: false,
} as const;

export type SetupDocument = Document;

/**
 * Line ending observed when a document was loaded. The YAML emitter always
 * writes LF, so without this a CRLF file — what a Windows checkout or editor
 * produces — comes back reflowed in its entirety on the first append.
 */
const documentNewline = new WeakMap<SetupDocument, string>();

/** Read an operator-authored YAML document without converting it to an object. */
export function loadDocument(path: string): SetupDocument {
  const source = readFileSync(path, "utf8");
  const document = parseDocument(source, {
    keepSourceTokens: true,
    ...DOCUMENT_STRINGIFY_OPTIONS,
  });
  if (source.includes("\r\n")) documentNewline.set(document, "\r\n");
  if (document.errors.length > 0) {
    throw new Error(
      `cannot parse configuration document ${path}: ${document.errors
        .map((error) => error.message)
        .join("; ")}`,
    );
  }
  return document;
}

/** Append a literal repository map to the existing repositories sequence. */
export function appendRepository(document: SetupDocument, entry: Record<string, unknown>): void {
  const repositories = document.get("repositories", true);
  if (repositories === undefined || repositories === null) {
    const sequence = document.createNode([]) as YAMLSeq;
    sequence.items.push(document.createNode(entry));
    document.set("repositories", sequence);
    return;
  }
  if (!isSeq(repositories)) {
    throw new Error("repositories must be a YAML sequence before a repository can be appended");
  }
  repositories.items.push(document.createNode(entry));
  // Empty flow collections are common in hand-authored files. Once an entry
  // is appended, prefer the documented block sequence form so the generated
  // entry remains readable and future appends preserve that style.
  if (repositories.items.length === 1 && repositories.flow === true) repositories.flow = false;
}

/** Remove repository sequence entries selected by the caller, preserving all other YAML nodes. */
export function removeRepositories(
  document: SetupDocument,
  predicate: (entry: Record<string, unknown>) => boolean,
): number {
  const repositories = document.get("repositories", true);
  if (repositories === undefined || repositories === null) return 0;
  if (!isSeq(repositories)) {
    throw new Error(
      "repositories must be a YAML sequence before repository entries can be removed",
    );
  }

  const raw = asRecord(document.toJS());
  const entries = Array.isArray(raw?.repositories) ? raw.repositories : [];
  let removed = 0;
  for (let index = repositories.items.length - 1; index >= 0; index -= 1) {
    const entry = asRecord(entries[index]);
    if (entry !== undefined && predicate(entry)) {
      repositories.items.splice(index, 1);
      removed += 1;
    }
  }
  return removed;
}

/**
 * Emit the document while retaining comments, ordering, scalar styles, and the
 * line ending it was loaded with.
 */
export function emitDocument(document: SetupDocument): string {
  const text = document.toString(DOCUMENT_STRINGIFY_OPTIONS);
  return documentNewline.get(document) === "\r\n" ? text.replace(/\r?\n/gu, "\r\n") : text;
}

/** Short aliases matching the document API vocabulary used by the setup flow. */
export const load = loadDocument;
export const append = appendRepository;
export const emit = emitDocument;

export interface ValidatedWriteSuccess {
  ok: true;
  text: string;
}

export interface ValidatedWriteFailure {
  ok: false;
  problems: string[];
}

export type ValidatedWriteResult = ValidatedWriteSuccess | ValidatedWriteFailure;

/**
 * Environment used while checking a generated document. Secret values never
 * come from the document or get written to disk; the loader sees placeholders
 * in memory only.
 */
export function placeholderEnvironment(
  documentText: string,
  source: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = { ...source };
  let raw: unknown;
  try {
    raw = parseDocument(documentText).toJS();
  } catch {
    // loadConfig will report the actual parse problem from the temporary file.
    return environment;
  }
  const root = asRecord(raw);
  const github = asRecord(root?.github);
  const consoleConfig = asRecord(root?.console);
  const githubTokenEnv = asNonEmptyString(github?.token_env) ?? "GREMLYN_GITHUB_TOKEN";
  const consoleTokenEnv = asNonEmptyString(consoleConfig?.token_env) ?? "GREMLYN_CONSOLE_TOKEN";
  environment[githubTokenEnv] = "gremlyn-setup-placeholder-github-token";
  environment[consoleTokenEnv] = "gremlyn-setup-placeholder-console-token";
  return environment;
}

/** Validate emitted YAML through the production loader using a temporary copy. */
export function validateDocumentText(
  configPath: string,
  documentText: string,
  env: NodeJS.ProcessEnv = process.env,
): string[] {
  const directory = dirname(resolve(configPath));
  mkdirSync(directory, { recursive: true });
  const scratch = mkdtempSync(join(directory, ".gremlyn-config-check-"));
  const candidate = join(scratch, "candidate.yaml");
  try {
    writeFileSync(candidate, documentText, { encoding: "utf8", mode: 0o600 });
    loadConfig(candidate, placeholderEnvironment(documentText, env));
    return [];
  } catch (error) {
    if (error instanceof ConfigError) return [...error.problems];
    throw error;
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

/**
 * Emit, validate, and atomically replace a configuration file. A loader
 * rejection returns its problem list and never touches the original file.
 */
export function writeValidatedConfig(
  configPath: string,
  document: SetupDocument,
  env: NodeJS.ProcessEnv = process.env,
): ValidatedWriteResult {
  const text = emitDocument(document);
  const target = resolve(configPath);
  const directory = dirname(target);
  if (!existsSync(directory)) {
    return {
      ok: false,
      problems: [`configuration directory does not exist: ${directory}`],
    };
  }

  const temporary = join(
    directory,
    `.gremlyn-config-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}.tmp`,
  );
  try {
    writeFileSync(temporary, text, { encoding: "utf8", mode: 0o600, flag: "wx" });
    try {
      loadConfig(temporary, placeholderEnvironment(text, env));
    } catch (error) {
      if (error instanceof ConfigError) {
        return { ok: false, problems: [...error.problems] };
      }
      throw error;
    }
    renameSync(temporary, target);
    return { ok: true, text };
  } finally {
    rmSync(temporary, { force: true });
  }
}

/** Append and validate in one operation; useful to keep flow code transactional. */
export function appendRepositoryToFile(
  configPath: string,
  entry: Record<string, unknown>,
  env: NodeJS.ProcessEnv = process.env,
): ValidatedWriteResult {
  const document = loadDocument(configPath);
  appendRepository(document, entry);
  return writeValidatedConfig(configPath, document, env);
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function asNonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}
