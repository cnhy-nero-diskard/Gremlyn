import { test } from "node:test";
import assert from "node:assert/strict";
import { installSoundInput, nextSoundState, type SoundInput } from "../src/terminal/input.js";

/**
 * Terminal sound-control input (task 4.5). A fake raw-mode stream stands in for
 * stdin; no real TTY or audio is involved.
 */

class FakeInput implements SoundInput {
  isTTY = true;
  isRaw = false;
  readableFlowing: boolean | null = false;
  throwOnResume = false;
  throwOnOff = false;
  throwOnRemoveListener = false;
  throwOnOn = false;
  readonly rawModeChanges: boolean[] = [];
  resumeCount = 0;
  pauseCount = 0;
  private readonly listeners = new Set<(chunk: Buffer | string) => void>();

  setRawMode(mode: boolean): void {
    this.isRaw = mode;
    this.rawModeChanges.push(mode);
  }

  resume(): void {
    if (this.throwOnResume) throw new Error("resume failed");
    this.resumeCount += 1;
    this.readableFlowing = true;
  }

  pause(): void {
    this.pauseCount += 1;
    this.readableFlowing = false;
  }

  on(_event: "data", listener: (chunk: Buffer | string) => void): void {
    if (this.throwOnOn) throw new Error("on failed");
    this.listeners.add(listener);
  }

  off(_event: "data", listener: (chunk: Buffer | string) => void): void {
    if (this.throwOnOff) throw new Error("off failed");
    this.listeners.delete(listener);
  }

  removeListener(_event: "data", listener: (chunk: Buffer | string) => void): void {
    if (this.throwOnRemoveListener) throw new Error("removeListener failed");
    this.listeners.delete(listener);
  }

  press(key: string): void {
    for (const listener of [...this.listeners]) listener(key);
  }

  get listenerCount(): number {
    return this.listeners.size;
  }
}

class Capture {
  text = "";
  write(chunk: string): void {
    this.text += chunk;
  }
}

test("non-interactive and non-TTY launches never touch the stream", () => {
  const interactiveInput = new FakeInput();
  interactiveInput.isTTY = false;
  const skipped = installSoundInput({
    input: interactiveInput,
    enabled: false,
    muted: false,
    onChange: () => undefined,
    onStop: () => undefined,
    interactive: true,
  });
  assert.equal(interactiveInput.rawModeChanges.length, 0);
  assert.equal(interactiveInput.listenerCount, 0);
  skipped();

  const stream = new FakeInput();
  const dispose = installSoundInput({
    input: stream,
    enabled: false,
    muted: false,
    onChange: () => undefined,
    onStop: () => undefined,
    interactive: false,
  });
  dispose();
  dispose();
  assert.equal(stream.rawModeChanges.length, 0);
  assert.equal(stream.resumeCount, 0);
  assert.equal(stream.pauseCount, 0);
  assert.equal(stream.listenerCount, 0);
});

test("a stream without raw-mode support is a no-op", () => {
  const input = new FakeInput();
  (input as { setRawMode?: unknown }).setRawMode = undefined;
  const dispose = installSoundInput({
    input,
    enabled: false,
    muted: false,
    onChange: () => undefined,
    onStop: () => undefined,
    interactive: true,
  });
  dispose();
  assert.equal(input.listenerCount, 0);
  assert.equal(input.rawModeChanges.length, 0);
});

test("m opts into sound and then toggles mute with textual feedback", () => {
  const input = new FakeInput();
  const output = new Capture();
  const changes: [boolean, boolean][] = [];
  const dispose = installSoundInput({
    input,
    enabled: false,
    muted: false,
    onChange: (enabled, muted) => changes.push([enabled, muted]),
    onStop: () => undefined,
    interactive: true,
    output,
  });
  assert.deepEqual(input.rawModeChanges, [true], "raw mode is enabled while installed");
  assert.equal(input.listenerCount, 1);

  input.press("m");
  assert.deepEqual(changes, [[true, false]], "first press opts in to sound");
  assert.match(output.text, /sound on/);

  input.press("M");
  assert.deepEqual(changes, [
    [true, false],
    [true, true],
  ]);
  assert.match(output.text, /sound muted/);

  input.press("m");
  assert.deepEqual(changes.at(-1), [true, false], "pressing again unmutes");
  dispose();
});

test("Ctrl+C routes to the existing stop handler on every press and ignores other keys", () => {
  const input = new FakeInput();
  const changes: [boolean, boolean][] = [];
  let stops = 0;
  const dispose = installSoundInput({
    input,
    enabled: false,
    muted: false,
    onChange: (enabled, muted) => changes.push([enabled, muted]),
    onStop: () => {
      stops += 1;
    },
    interactive: true,
  });

  input.press("z");
  input.press("\u0003");
  input.press("q");
  input.press("\u0003");
  assert.equal(stops, 2, "each Ctrl+C reaches the stop handler");
  assert.deepEqual(changes, [], "control keys do not change sound state");
  dispose();
});

test("dispose restores raw mode and pauses only when reads were not flowing", () => {
  const notFlowing = new FakeInput();
  const disposeNotFlowing = installSoundInput({
    input: notFlowing,
    enabled: false,
    muted: false,
    onChange: () => undefined,
    onStop: () => undefined,
    interactive: true,
  });
  disposeNotFlowing();
  assert.deepEqual(notFlowing.rawModeChanges, [true, false]);
  assert.equal(notFlowing.pauseCount, 1, "a previously paused stream is paused again");
  assert.equal(notFlowing.listenerCount, 0);
  notFlowing.press("m");
  assert.equal(notFlowing.listenerCount, 0, "disposal removes the key handler");
  disposeNotFlowing();

  const previouslyRaw = new FakeInput();
  previouslyRaw.isRaw = true;
  const disposePreviouslyRaw = installSoundInput({
    input: previouslyRaw,
    enabled: false,
    muted: false,
    onChange: () => undefined,
    onStop: () => undefined,
    interactive: true,
  });
  disposePreviouslyRaw();
  assert.deepEqual(
    previouslyRaw.rawModeChanges,
    [true, true],
    "raw mode is restored to its prior value",
  );

  const flowing = new FakeInput();
  flowing.readableFlowing = true;
  const disposeFlowing = installSoundInput({
    input: flowing,
    enabled: false,
    muted: false,
    onChange: () => undefined,
    onStop: () => undefined,
    interactive: true,
  });
  disposeFlowing();
  assert.equal(flowing.pauseCount, 0, "a previously flowing stream is left flowing");
});

test("a partial setup failure restores raw mode and the prior flowing state", () => {
  const resumeFailed = new FakeInput();
  resumeFailed.throwOnResume = true;
  const disposeResume = installSoundInput({
    input: resumeFailed,
    enabled: false,
    muted: false,
    onChange: () => undefined,
    onStop: () => undefined,
    interactive: true,
  });
  assert.deepEqual(resumeFailed.rawModeChanges, [true, false], "raw mode is restored");
  assert.equal(resumeFailed.pauseCount, 1, "the prior paused state is restored");
  assert.equal(resumeFailed.listenerCount, 0);
  disposeResume();
  disposeResume();
  assert.deepEqual(resumeFailed.rawModeChanges, [true, false]);

  const onFailed = new FakeInput();
  onFailed.throwOnOn = true;
  const disposeOn = installSoundInput({
    input: onFailed,
    enabled: false,
    muted: false,
    onChange: () => undefined,
    onStop: () => undefined,
    interactive: true,
  });
  assert.deepEqual(onFailed.rawModeChanges, [true, false]);
  assert.equal(onFailed.resumeCount, 1);
  assert.equal(onFailed.pauseCount, 1);
  assert.equal(onFailed.listenerCount, 0);
  disposeOn();
});

test("a listener-removal failure cannot suppress raw restoration or pause", () => {
  const input = new FakeInput();
  const dispose = installSoundInput({
    input,
    enabled: false,
    muted: false,
    onChange: () => undefined,
    onStop: () => undefined,
    interactive: true,
  });
  input.throwOnOff = true;
  input.throwOnRemoveListener = true;
  assert.doesNotThrow(() => dispose());
  assert.deepEqual(input.rawModeChanges, [true, false]);
  assert.equal(input.pauseCount, 1);
  dispose();
});

test("a mid-buffer Ctrl+C stop preserves repeated stops but blocks later sound keys", () => {
  const input = new FakeInput();
  const changes: [boolean, boolean][] = [];
  let stops = 0;
  let dispose = (): void => undefined;
  dispose = installSoundInput({
    input,
    enabled: false,
    muted: false,
    onChange: (enabled, muted) => changes.push([enabled, muted]),
    onStop: () => {
      stops += 1;
      // The stop handler disposes the adapter synchronously, mid-chunk.
      dispose();
    },
    interactive: true,
  });

  input.press("\u0003\u0003m");
  assert.equal(stops, 2, "every Ctrl+C in the chunk reaches the stop handler");
  assert.deepEqual(changes, [], "no sound key after a mid-buffer stop changes state");

  input.press("m");
  assert.deepEqual(changes, [], "the handler stays disposed");
});

test("throwing state and stop consumers cannot break input handling", () => {
  const input = new FakeInput();
  const dispose = installSoundInput({
    input,
    enabled: false,
    muted: false,
    onChange: () => {
      throw new Error("state consumer defect");
    },
    onStop: () => {
      throw new Error("stop handler defect");
    },
    interactive: true,
  });
  assert.doesNotThrow(() => {
    input.press("m");
    input.press("\u0003");
  });
  dispose();
});

test("nextSoundState opts in when disabled and otherwise toggles mute", () => {
  assert.deepEqual(nextSoundState(false, false), {
    enabled: true,
    muted: false,
    message: "sound on",
  });
  assert.deepEqual(nextSoundState(true, false), {
    enabled: true,
    muted: true,
    message: "sound muted",
  });
  assert.deepEqual(nextSoundState(true, true), {
    enabled: true,
    muted: false,
    message: "sound on",
  });
});
