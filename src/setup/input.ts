import { createInterface, type Interface } from "node:readline/promises";
import { stdin as defaultInput, stdout as defaultOutput } from "node:process";

export interface InputSource {
  isTTY: boolean;
  ask(question: string): Promise<string>;
  close?(): void;
}

export interface InputOptions {
  yes?: boolean;
  input?: InputSource;
}

export class InputResolutionError extends Error {
  readonly field: string;

  constructor(field: string, message: string) {
    super(message);
    this.name = "InputResolutionError";
    this.field = field;
  }
}

/** A readline-backed source used only when the process has an interactive TTY. */
export function createReadlineInput(input = defaultInput, output = defaultOutput): InputSource {
  const readline = createInterface({ input, output });
  return {
    isTTY: Boolean(input.isTTY && output.isTTY),
    ask: (question) => readline.question(question),
    close: () => readline.close(),
  };
}

export function nonInteractiveInput(): InputSource {
  return {
    isTTY: false,
    ask: async () => {
      throw new Error("interactive input was requested from a non-interactive input source");
    },
  };
}

/** Resolve a required literal: explicit value, accepted proposal, or prompt. */
export async function resolveInput<T>(
  field: string,
  options: {
    explicit?: T | undefined;
    proposed?: T | undefined;
    describe: (value: T) => string;
    yes?: boolean | undefined;
    input?: InputSource | undefined;
    format?: ((value: T) => string) | undefined;
    parse?: ((value: string) => T | undefined) | undefined;
  },
): Promise<T> {
  if (options.explicit !== undefined) return options.explicit;

  const input = options.input ?? nonInteractiveInput();
  if (options.proposed !== undefined) {
    if (options.yes === true) return options.proposed;
    if (!input.isTTY) {
      throw missingInput(
        field,
        `${options.describe(options.proposed)}; pass --yes to accept it or supply --${field}`,
      );
    }
    const answer = (await input.ask(`${options.describe(options.proposed)} [y/N]: `))
      .trim()
      .toLowerCase();
    if (answer === "y" || answer === "yes") return options.proposed;
  }

  if (!input.isTTY) {
    throw missingInput(
      field,
      `missing ${field}; supply --${field} or pass --yes to accept the proposal`,
    );
  }
  const answer = (await input.ask(`${field}: `)).trim();
  if (options.parse) {
    const parsed = options.parse(answer);
    if (parsed !== undefined) return parsed;
  } else if (answer.length > 0) {
    return answer as T;
  }
  throw missingInput(field, `missing ${field}; enter a value or supply --${field}`);
}

/** Resolve a boolean confirmation without treating an absent value as consent. */
export async function resolveConfirmation(
  field: string,
  options: {
    explicit?: boolean;
    proposed?: boolean;
    yes?: boolean;
    input?: InputSource;
    question: string;
  },
): Promise<boolean> {
  if (options.explicit !== undefined) return options.explicit;
  if (options.proposed !== undefined && options.yes === true) return options.proposed;
  const input = options.input ?? nonInteractiveInput();
  if (!input.isTTY) {
    throw missingInput(field, `missing ${field}; supply an explicit flag or pass --yes`);
  }
  const answer = (await input.ask(`${options.question} [y/N]: `)).trim().toLowerCase();
  return answer === "y" || answer === "yes";
}

/** Resolve a proposed list while permitting the operator to choose a subset. */
export async function resolveCommandList(
  field: string,
  proposed: readonly string[][],
  options: {
    explicit?: string[][] | undefined;
    yes?: boolean | undefined;
    input?: InputSource | undefined;
  } = {},
): Promise<string[][]> {
  if (options.explicit !== undefined) return options.explicit;
  if (proposed.length === 0) return [];
  if (options.yes === true) return proposed.map((command) => [...command]);
  const input = options.input ?? nonInteractiveInput();
  if (!input.isTTY) {
    throw missingInput(field, `missing ${field}; supply --validation-command values or pass --yes`);
  }
  const answer = (
    await input.ask(
      `Validation candidates ${proposed.map((command, index) => `${index + 1}:${command.join(" ")}`).join(", ")}. ` +
        "Enter comma-separated numbers, or none: ",
    )
  )
    .trim()
    .toLowerCase();
  if (answer === "" || answer === "none" || answer === "no") return [];
  const selected = new Set<number>();
  for (const token of answer.split(",")) {
    const index = Number(token.trim());
    if (!Number.isInteger(index) || index < 1 || index > proposed.length) {
      throw new InputResolutionError(
        field,
        `invalid validation command selection "${token.trim()}"`,
      );
    }
    selected.add(index - 1);
  }
  return proposed.filter((_command, index) => selected.has(index)).map((command) => [...command]);
}

function missingInput(field: string, detail: string): InputResolutionError {
  return new InputResolutionError(field, detail);
}

/** Close a prompt source without requiring every caller to know its implementation. */
export function closeInput(input: InputSource | undefined): void {
  input?.close?.();
}

/** Keep the type import useful for consumers that construct readline wrappers. */
export type ReadlineInterface = Interface;
