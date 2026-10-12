/**
 * Terminal sound-control input adapter (design D5, task 4.5).
 *
 * A small, disposable key handler that owns raw mode for as long as it is
 * installed. It is offered only for a supported interactive TTY; every other
 * launch resolves to a no-op so non-interactive runs can only change sound
 * through config/flags. `m` opts in to sound when disabled and otherwise toggles
 * mute, Ctrl+C is routed to the existing stop handler on every press, and
 * disposal restores the prior raw-mode and flowing state.
 */

export interface SoundInput {
  isTTY?: boolean;
  isRaw?: boolean;
  readableFlowing?: boolean | null;
  setRawMode?(mode: boolean): void;
  resume?(): void;
  pause?(): void;
  on(event: "data", listener: (chunk: Buffer | string) => void): unknown;
  off?(event: "data", listener: (chunk: Buffer | string) => void): unknown;
  removeListener?(event: "data", listener: (chunk: Buffer | string) => void): unknown;
}

/** Optional textual feedback sink for the sound-state key. */
export interface SoundInputOutput {
  write(text: string): void;
}

export interface SoundInputOptions {
  input: SoundInput;
  enabled: boolean;
  muted: boolean;
  onChange: (enabled: boolean, muted: boolean) => void;
  onStop: () => void;
  onHelp?: () => void;
  /** Reports only after raw mode, resume and listener setup all succeed. */
  onAvailability?: (available: boolean) => void;
  interactive: boolean;
  /** When supplied, the adapter emits readable sound-state feedback. */
  output?: SoundInputOutput;
}

/** The Ctrl+C control character delivered on a raw-mode stream. */
const CTRL_C = "\u0003";

function reportAvailability(options: SoundInputOptions, available: boolean): void {
  try {
    options.onAvailability?.(available);
  } catch {
    // Availability feedback is observational and cannot break raw-mode setup.
  }
}

export interface SoundState {
  enabled: boolean;
  muted: boolean;
  message: string;
}

/**
 * Resolve the next sound state for one `m` press. Disabled sound is opted in
 * (enabled and unmuted); enabled sound toggles mute. The message is fixed text,
 * never derived from a dynamic string.
 */
export function nextSoundState(enabled: boolean, muted: boolean): SoundState {
  if (!enabled || muted) return { enabled: true, muted: false, message: "sound on" };
  return { enabled: true, muted: true, message: "sound muted" };
}

function writeFeedback(output: SoundInputOutput | undefined, message: string): void {
  if (output === undefined) return;
  try {
    output.write(`${message}\n`);
  } catch {
    // A feedback sink failure must never break input handling.
  }
}

/**
 * Install the sound-control key handler and return an idempotent disposer.
 *
 * A non-interactive launch, a non-TTY input or a stream without raw-mode
 * support yields a no-op disposer that never touches the stream. A supported
 * install records the prior raw/flowing state, enables raw mode and resumes
 * reads; disposal removes the listener, restores raw mode and pauses only when
 * the stream was not already flowing.
 */
export function installSoundInput(options: SoundInputOptions): () => void {
  const { input } = options;
  const supported =
    options.interactive && input.isTTY === true && typeof input.setRawMode === "function";
  if (!supported) {
    reportAvailability(options, false);
    return () => undefined;
  }

  const wasRaw = input.isRaw === true;
  const wasFlowing = input.readableFlowing === true;
  let enabled = options.enabled;
  let muted = options.muted;
  let disposed = false;

  // Restore the recorded raw/flowing state. Each step is independent so a
  // partially applied setup, or a throwing listener removal, can never strand
  // the terminal in raw mode or a resumed state.
  const restore = (): void => {
    try {
      input.setRawMode?.(wasRaw);
    } catch {
      // Restoring raw mode is best-effort.
    }
    if (!wasFlowing) {
      try {
        input.pause?.();
      } catch {
        // Restoring the prior flowing state is best-effort.
      }
    }
  };

  const removeListener = (): void => {
    try {
      input.off?.("data", onData);
    } catch {
      // A failed removal must never suppress raw-mode restoration.
    }
    try {
      input.removeListener?.("data", onData);
    } catch {
      // Best-effort duplicate removal.
    }
  };

  const onData = (chunk: Buffer | string): void => {
    const text = typeof chunk === "string" ? chunk : chunk.toString("utf8");
    for (const char of text) {
      if (char === CTRL_C) {
        // Preserve the existing repeated-request behavior: every Ctrl+C in the
        // stream reaches the stop handler, even one after a mid-buffer stop.
        try {
          options.onStop();
        } catch {
          // Input handling continues regardless of a stop-handler defect.
        }
        continue;
      }
      // A Ctrl+C (or a state consumer) may have disposed the handler while this
      // chunk was being processed; nothing after a stop may change sound state.
      if (disposed) continue;
      if (char === "q" || char === "Q") {
        try {
          options.onStop();
        } catch {
          // Shutdown remains owned by the existing stop handler.
        }
        continue;
      }
      if (char === "?" || char === "h" || char === "H") {
        try {
          options.onHelp?.();
        } catch {
          // A display toggle must never interrupt the key handler.
        }
        continue;
      }
      if (char === "m" || char === "M") {
        const next = nextSoundState(enabled, muted);
        enabled = next.enabled;
        muted = next.muted;
        writeFeedback(options.output, next.message);
        try {
          options.onChange(enabled, muted);
        } catch {
          // A state-consumer failure must never break raw-mode handling.
        }
      }
    }
  };

  try {
    input.setRawMode?.(true);
  } catch {
    restore();
    reportAvailability(options, false);
    return () => undefined;
  }
  try {
    input.resume?.();
  } catch {
    removeListener();
    restore();
    reportAvailability(options, false);
    return () => undefined;
  }
  try {
    input.on("data", onData);
  } catch {
    removeListener();
    restore();
    reportAvailability(options, false);
    return () => undefined;
  }

  reportAvailability(options, true);
  return () => {
    if (disposed) return;
    disposed = true;
    removeListener();
    restore();
    reportAvailability(options, false);
  };
}
