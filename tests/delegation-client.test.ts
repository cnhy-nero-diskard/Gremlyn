/**
 * Task 4.4: client reconciliation preserves expansion, focused nodes,
 * reading/scroll and follow state through child updates and reconnect.
 *
 * These tests run the shipped reconciliation functions from
 * `src/console/assets.ts` inside a `node:vm` context against a small fake DOM,
 * so they exercise the real implementation rather than string assertions.
 * The cases cover sibling changes, repeated session nodes across attempts and
 * attempt switches, including the operator-visible failures:
 *
 * - a keyed attempt/invocation/session `<details>` is its own `data-live-key`
 *   owner, and `querySelector` cannot match the owner itself;
 * - focus must follow a stable id/name selector, not a shifted positional path;
 * - scroll identity must be qualified by the owning live key so repeated
 *   session nodes in different attempts never share or transfer a position;
 * - horizontal reading and a follow-off position must survive updates.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { runInNewContext } from "node:vm";
import { clientScript } from "../src/console/assets.js";

// ---------------------------------------------------------------------------
// Tiny fake DOM (no dependencies)
// ---------------------------------------------------------------------------

interface FakeAttribute {
  name: string;
  value: string;
}

type FakeChild = FakeElement | FakeText;

function kebabCase(property: string): string {
  return property.replace(/[A-Z]/gu, (character) => "-" + character.toLowerCase());
}

function matchCompound(node: FakeElement, selector: string): boolean {
  const negations: string[] = [];
  const stripped = selector.replace(/:not\(([^)]*)\)/gu, (_match, inner: string) => {
    negations.push(inner.trim());
    return "";
  });
  for (const negation of negations) {
    if (matchCompound(node, negation)) return false;
  }
  let rest = stripped.trim();
  if (rest === "") return true;
  const tagMatch = rest.match(/^([a-zA-Z][\w-]*)/u);
  if (tagMatch) {
    if (node.tagName !== tagMatch[1]?.toUpperCase()) return false;
    rest = rest.slice(tagMatch[0].length);
  }
  while (rest.length > 0) {
    if (rest.startsWith("#")) {
      const idMatch = rest.match(/^#([\w-]+)/u);
      if (!idMatch) return false;
      if (node.id !== idMatch[1]) return false;
      rest = rest.slice(idMatch[0].length);
    } else if (rest.startsWith("[")) {
      const attrMatch = rest.match(/^\[([^\]]+)\]/u);
      if (!attrMatch) return false;
      const body = attrMatch[1] ?? "";
      const equals = body.indexOf("=");
      if (equals === -1) {
        if (!node.hasAttribute(body.trim())) return false;
      } else {
        const name = body.slice(0, equals).trim();
        let expected = body.slice(equals + 1).trim();
        if (
          (expected.startsWith('"') && expected.endsWith('"')) ||
          (expected.startsWith("'") && expected.endsWith("'"))
        ) {
          expected = expected.slice(1, -1);
        }
        if (node.getAttribute(name) !== expected) return false;
      }
      rest = rest.slice(attrMatch[0].length);
    } else {
      return false;
    }
  }
  return true;
}

function matchesSelector(node: FakeElement, selector: string): boolean {
  return selector.split(",").some((part) => matchCompound(node, part.trim()));
}

class FakeText {
  readonly nodeType = 3;
  parentNode: FakeElement | null = null;
  textContent: string;

  constructor(text: string) {
    this.textContent = text;
  }

  cloneNode(): FakeText {
    return new FakeText(this.textContent);
  }
}

class FakeElement {
  readonly nodeType = 1;
  readonly tagName: string;
  parentNode: FakeElement | null = null;
  childNodes: FakeChild[] = [];
  attributes: FakeAttribute[] = [];
  style: Record<string, string> = {};
  hidden = false;
  open = false;
  checked = false;
  disabled = false;
  value = "";
  scrollTop = 0;
  scrollLeft = 0;
  scrollHeight = 0;
  scrollWidth = 0;
  clientHeight = 0;
  clientWidth = 0;
  tabIndex = -1;
  selectionStart: number | null = null;
  selectionEnd: number | null = null;
  selectionDirection = "none";
  readonly ownerDocument: FakeDocument | null;
  private readonly classes = new Set<string>();

  constructor(tagName: string, ownerDocument: FakeDocument | null) {
    this.tagName = tagName.toUpperCase();
    this.ownerDocument = ownerDocument;
  }

  get id(): string {
    return this.getAttribute("id") ?? "";
  }

  set id(value: string) {
    this.setAttribute("id", value);
  }

  get name(): string {
    return this.getAttribute("name") ?? "";
  }

  set name(value: string) {
    this.setAttribute("name", value);
  }

  get classList(): {
    contains: (name: string) => boolean;
    add: (name: string) => void;
    remove: (name: string) => void;
    toggle: (name: string, force?: boolean) => boolean;
  } {
    const classes = this.classes;
    return {
      contains: (name: string) => classes.has(name),
      add: (name: string) => {
        classes.add(name);
      },
      remove: (name: string) => {
        classes.delete(name);
      },
      toggle: (name: string, force?: boolean) => {
        const on = force === undefined ? !classes.has(name) : force;
        if (on) classes.add(name);
        else classes.delete(name);
        return on;
      },
    };
  }

  get dataset(): Record<string, string> {
    return new Proxy({} as Record<string, string>, {
      get: (_target, property: string) =>
        this.getAttribute("data-" + kebabCase(property)) ?? undefined,
      set: (_target, property: string, value) => {
        this.setAttribute("data-" + kebabCase(property), String(value));
        return true;
      },
      has: (_target, property: string) => this.hasAttribute("data-" + kebabCase(property)),
    });
  }

  get firstChild(): FakeChild | null {
    return this.childNodes[0] ?? null;
  }

  get nextElementSibling(): FakeElement | null {
    const siblings = this.parentNode?.childNodes ?? [];
    const index = siblings.indexOf(this);
    for (let i = index + 1; i < siblings.length; i += 1) {
      const node = siblings[i];
      if (node && node.nodeType === 1) return node as FakeElement;
    }
    return null;
  }

  hasAttribute(name: string): boolean {
    return this.attributes.some((attribute) => attribute.name === name);
  }

  getAttribute(name: string): string | null {
    return this.attributes.find((attribute) => attribute.name === name)?.value ?? null;
  }

  setAttribute(name: string, value: string): void {
    const existing = this.attributes.find((attribute) => attribute.name === name);
    if (existing) existing.value = String(value);
    else this.attributes.push({ name, value: String(value) });
  }

  removeAttribute(name: string): void {
    this.attributes = this.attributes.filter((attribute) => attribute.name !== name);
  }

  matches(selector: string): boolean {
    return matchesSelector(this, selector);
  }

  closest(selector: string): FakeElement | null {
    if (matchesSelector(this, selector)) return this;
    let current: FakeElement | null = this.parentNode;
    while (current) {
      if (matchesSelector(current, selector)) return current;
      current = current.parentNode;
    }
    return null;
  }

  contains(node: FakeChild | null): boolean {
    let current: FakeChild | null = node;
    while (current) {
      if (current === this) return true;
      current = current.parentNode;
    }
    return false;
  }

  querySelector(selector: string): FakeElement | null {
    for (const node of this.descendants()) {
      if (node.nodeType === 1 && matchesSelector(node as FakeElement, selector))
        return node as FakeElement;
    }
    return null;
  }

  querySelectorAll(selector: string): FakeElement[] {
    const found: FakeElement[] = [];
    for (const node of this.descendants()) {
      if (node.nodeType === 1 && matchesSelector(node as FakeElement, selector))
        found.push(node as FakeElement);
    }
    return found;
  }

  append(...nodes: FakeChild[]): void {
    nodes.forEach((node) => this.appendChild(node));
  }

  appendChild(node: FakeChild): FakeChild {
    if (node.parentNode) node.parentNode.removeChild(node);
    node.parentNode = this;
    this.childNodes.push(node);
    return node;
  }

  insertBefore(node: FakeChild, reference: FakeChild | null): FakeChild {
    if (node.parentNode) node.parentNode.removeChild(node);
    node.parentNode = this;
    if (!reference) {
      this.childNodes.push(node);
      return node;
    }
    const index = this.childNodes.indexOf(reference);
    if (index < 0) this.childNodes.push(node);
    else this.childNodes.splice(index, 0, node);
    return node;
  }

  removeChild(node: FakeChild): FakeChild {
    const index = this.childNodes.indexOf(node);
    if (index >= 0) this.childNodes.splice(index, 1);
    if (node.parentNode === this) node.parentNode = null;
    return node;
  }

  cloneNode(deep = false): FakeElement {
    const clone = new FakeElement(this.tagName, this.ownerDocument);
    this.attributes.forEach((attribute) => clone.setAttribute(attribute.name, attribute.value));
    clone.hidden = this.hidden;
    clone.open = this.open;
    clone.checked = this.checked;
    clone.disabled = this.disabled;
    clone.value = this.value;
    if (deep) this.childNodes.forEach((child) => clone.appendChild(child.cloneNode(true)));
    return clone;
  }

  get textContent(): string {
    return this.childNodes.map((child) => child.textContent).join("");
  }

  set textContent(value: string) {
    this.childNodes.slice().forEach((node) => this.removeChild(node));
    if (value !== "") this.appendChild(new FakeText(String(value)));
  }

  focus(): void {
    if (this.ownerDocument) this.ownerDocument.activeElement = this;
  }

  setSelectionRange(start: number, end: number, direction?: string): void {
    this.selectionStart = start;
    this.selectionEnd = end;
    this.selectionDirection = direction ?? "none";
  }

  private *descendants(): Generator<FakeChild> {
    for (const child of this.childNodes) {
      yield child;
      if (child.nodeType === 1) yield* (child as FakeElement).descendants();
    }
  }
}

class FakeDocument {
  activeElement: FakeElement | null = null;

  createElement(tagName: string): FakeElement {
    return new FakeElement(tagName, this);
  }

  querySelector(): FakeElement | null {
    return null;
  }

  querySelectorAll(): FakeElement[] {
    return [];
  }

  getElementById(): null {
    return null;
  }

  addEventListener(): void {
    // The reconciliation block registers no document listeners.
  }
}

interface NodeSpec {
  tag: string;
  attrs?: Record<string, string>;
  props?: Record<string, unknown>;
  text?: string;
  children?: NodeSpec[];
}

function build(document: FakeDocument, spec: NodeSpec): FakeElement {
  const node = document.createElement(spec.tag);
  for (const [name, value] of Object.entries(spec.attrs ?? {})) node.setAttribute(name, value);
  Object.assign(node, spec.props ?? {});
  if (spec.text !== undefined) node.textContent = spec.text;
  for (const child of spec.children ?? []) node.appendChild(build(document, child));
  return node;
}

// ---------------------------------------------------------------------------
// Load the shipped reconciliation block into a vm
// ---------------------------------------------------------------------------

interface FocusSnapshot {
  ownerKey: string;
  selector: { kind: string; value: string } | null;
  path: number[];
}

interface DetailSnapshot {
  ownerKey: string;
  path: number[];
  key: string;
  open: boolean;
}

interface ReconcileState {
  focus: FocusSnapshot | null;
  activity: { follow: boolean } | null;
  details: DetailSnapshot[];
  scrolls: Record<string, { top: number; left: number; pinned: boolean }>;
}

interface ReconcileApi {
  remember: (root: FakeElement) => ReconcileState;
  restore: (root: FakeElement, state: ReconcileState) => void;
  scrollState: (
    root: FakeElement,
  ) => Record<string, { top: number; left: number; pinned: boolean }>;
  detailsSnapshot: (root: FakeElement) => DetailSnapshot[];
  focusSnapshot: (root: FakeElement) => FocusSnapshot | null;
  reconcileChildren: (parent: FakeElement, incoming: FakeElement) => void;
  semanticSnapshot: (root: FakeElement) => Map<string, string>;
  announceSemanticChanges: (root: FakeElement, before: Map<string, string>) => void;
}

function loadReconcile(): { api: ReconcileApi; document: FakeDocument } {
  const start = clientScript.indexOf("  const logState = (root) => {");
  const end = clientScript.indexOf("  const redirectToSignIn", start);
  assert.ok(start >= 0 && end > start, "the reconciliation block is present in the client script");
  const document = new FakeDocument();
  const window = {
    gremlynConsole: {} as Record<string, unknown>,
    location: { assign: () => undefined },
  };
  const block = clientScript.slice(start, end);
  runInNewContext(
    `${block}
window.gremlynConsole.__reconcile = { remember, restore, scrollState, detailsSnapshot, focusSnapshot, reconcileChildren, semanticSnapshot, announceSemanticChanges };`,
    { document, window, console },
  );
  const api = window.gremlynConsole.__reconcile as ReconcileApi | undefined;
  assert.ok(api, "reconciliation helpers are exposed on window.gremlynConsole.__reconcile");
  return { api, document };
}

// ---------------------------------------------------------------------------
// Expansion
// ---------------------------------------------------------------------------

test("a keyed session details restores its own expansion after a rebuild", () => {
  const { api, document } = loadReconcile();
  const make = (firstOpen: boolean, secondOpen: boolean): FakeElement =>
    build(document, {
      tag: "div",
      children: [
        {
          tag: "details",
          attrs: { "data-live-key": "session-ses_a", "data-details-key": "session-ses_a" },
          props: { open: firstOpen },
        },
        {
          tag: "details",
          attrs: { "data-live-key": "session-ses_b", "data-details-key": "session-ses_b" },
          props: { open: secondOpen },
        },
      ],
    });
  const root = make(true, false);
  const snapshot = api.detailsSnapshot(root);
  assert.equal(snapshot.length, 2);
  assert.equal(snapshot[0]?.ownerKey, "session-ses_a");
  assert.equal(snapshot[0]?.key, "session-ses_a");
  assert.equal(snapshot[0]?.open, true);
  assert.equal(snapshot[1]?.ownerKey, "session-ses_b");
  assert.equal(snapshot[1]?.open, false);

  // Reconnect rebuilds the fragment from server defaults (both collapsed): the
  // client-only open state has to be reapplied by stable key, and the owner is
  // the details itself, which querySelector cannot match.
  const rebuilt = make(false, false);
  api.restore(rebuilt, api.remember(root));
  const details = rebuilt.querySelectorAll("details");
  assert.equal(details[0]?.open, true, "the expanded session survives the rebuild");
  assert.equal(details[1]?.open, false);
});

test("a keyed details without a details key still restores by positional path", () => {
  const { api, document } = loadReconcile();
  const make = (open: boolean): FakeElement =>
    build(document, {
      tag: "div",
      children: [{ tag: "details", attrs: { "data-live-key": "attempt-1" }, props: { open } }],
    });
  const root = make(true);
  const snapshot = api.detailsSnapshot(root);
  assert.equal(snapshot[0]?.ownerKey, "attempt-1");
  assert.equal(snapshot[0]?.key, "");
  assert.equal(snapshot[0]?.open, true);
  assert.equal(snapshot[0]?.path.length, 0);

  const rebuilt = make(false);
  api.restore(rebuilt, api.remember(root));
  assert.equal(rebuilt.querySelector("details")?.open, true);
});

test("a nested details keeps its expansion under a keyed owner", () => {
  const { api, document } = loadReconcile();
  const make = (nestedOpen: boolean): FakeElement =>
    build(document, {
      tag: "div",
      children: [
        {
          tag: "details",
          attrs: { "data-live-key": "session-1" },
          children: [
            { tag: "summary", text: "Session 1" },
            {
              tag: "details",
              attrs: { "data-details-key": "session-1-args" },
              props: { open: nestedOpen },
              children: [{ tag: "summary", text: "arguments" }],
            },
          ],
        },
      ],
    });
  const root = make(true);
  const rebuilt = make(false);
  api.restore(rebuilt, api.remember(root));
  const outer = rebuilt.querySelector("details");
  const nested = rebuilt.querySelector('[data-details-key="session-1-args"]');
  assert.equal(outer?.open, false, "the owner's own state stays put");
  assert.equal(nested?.open, true, "the nested fold survives");
});

// ---------------------------------------------------------------------------
// Focus
// ---------------------------------------------------------------------------

test("focus is restored by its stable id when siblings shift the path", () => {
  const { api, document } = loadReconcile();
  const make = (extraSibling: boolean): FakeElement =>
    build(document, {
      tag: "div",
      children: [
        {
          tag: "section",
          attrs: { "data-live-key": "session-1" },
          children: [
            { tag: "span", text: "header" },
            ...(extraSibling ? [{ tag: "span", text: "new sibling" }] : []),
            { tag: "button", attrs: { id: "session-1-retry" }, text: "Retry" },
          ],
        },
      ],
    });
  const root = make(false);
  const button = root.querySelector("#session-1-retry");
  assert.ok(button);
  button.focus();
  const state = api.remember(root);
  assert.deepEqual(JSON.parse(JSON.stringify(state.focus?.selector)), {
    kind: "id",
    value: "session-1-retry",
  });

  // A child appears before the control, so the recorded positional path would
  // resolve to the wrong element after the update.
  const rebuilt = make(true);
  document.activeElement = null;
  api.restore(rebuilt, state);
  assert.equal(
    document.activeElement,
    rebuilt.querySelector("#session-1-retry"),
    "focus follows the stable selector, not the shifted path",
  );
});

// ---------------------------------------------------------------------------
// Reading position and follow
// ---------------------------------------------------------------------------

test("repeated session nodes in different attempts keep distinct positions", () => {
  const { api, document } = loadReconcile();
  const make = (first: number, second: number): FakeElement =>
    build(document, {
      tag: "div",
      children: [
        {
          tag: "section",
          attrs: { "data-live-key": "attempt-1" },
          children: [
            {
              tag: "div",
              attrs: { "data-live-key": "session-1", "data-scroll-keep": "session-log" },
              props: { scrollTop: first, scrollLeft: 20, scrollHeight: 1000, clientHeight: 200 },
            },
          ],
        },
        {
          tag: "section",
          attrs: { "data-live-key": "attempt-2" },
          children: [
            {
              tag: "div",
              attrs: { "data-live-key": "session-2", "data-scroll-keep": "session-log" },
              props: { scrollTop: second, scrollLeft: 70, scrollHeight: 1000, clientHeight: 200 },
            },
          ],
        },
      ],
    });
  const root = make(120, 300);
  const state = api.remember(root);
  assert.deepEqual([...Object.keys(state.scrolls)].sort(), [
    "session-1::session-log",
    "session-2::session-log",
  ]);

  const rebuilt = make(0, 0);
  api.restore(rebuilt, state);
  const nodes = rebuilt.querySelectorAll("[data-scroll-keep]");
  assert.equal(nodes[0]?.scrollTop, 120, "the first attempt keeps its own reading place");
  assert.equal(nodes[1]?.scrollTop, 300, "the second attempt keeps its own reading place");
  assert.equal(nodes[0]?.scrollLeft, 20);
  assert.equal(nodes[1]?.scrollLeft, 70);
});

test("an attempt switch does not inherit the previous attempt's reading position", () => {
  const { api, document } = loadReconcile();
  const root = build(document, {
    tag: "div",
    children: [
      {
        tag: "section",
        attrs: { "data-live-key": "attempt-1" },
        children: [
          {
            tag: "div",
            attrs: { "data-scroll-keep": "session-log" },
            props: { scrollTop: 240, scrollLeft: 40, scrollHeight: 1000, clientHeight: 200 },
          },
        ],
      },
    ],
  });
  const state = api.remember(root);
  assert.deepEqual([...Object.keys(state.scrolls)], ["attempt-1::session-log"]);

  // A new attempt renders a fresh session node of the same keep-kind; it must
  // not receive the retired attempt's position.
  const rebuilt = build(document, {
    tag: "div",
    children: [
      {
        tag: "section",
        attrs: { "data-live-key": "attempt-3" },
        children: [
          {
            tag: "div",
            attrs: { "data-scroll-keep": "session-log" },
            props: { scrollTop: 0, scrollLeft: 0, scrollHeight: 1000, clientHeight: 200 },
          },
        ],
      },
    ],
  });
  api.restore(rebuilt, state);
  const node = rebuilt.querySelector("[data-scroll-keep]");
  assert.equal(node?.scrollTop, 0, "the new attempt starts at its own top");
  assert.equal(node?.scrollLeft, 0);
});

test("horizontal reading and a follow-off position survive a sibling update", () => {
  const { api, document } = loadReconcile();
  const make = (siblingState: string, scrollTop: number, scrollLeft: number): FakeElement =>
    build(document, {
      tag: "div",
      children: [
        {
          tag: "label",
          children: [{ tag: "input", attrs: { type: "checkbox", "data-activity-follow": "" } }],
        },
        {
          tag: "ol",
          attrs: { "data-scroll-keep": "activity" },
          props: { scrollTop, scrollLeft, scrollHeight: 1000, clientHeight: 200 },
        },
        { tag: "span", attrs: { "data-live-key": "child-2" }, text: siblingState },
      ],
    });
  const root = make("running", 50, 12);
  const state = api.remember(root);
  assert.equal(state.activity?.follow, false);

  // Another child changes state and the fragment rebuilds at the default place.
  const rebuilt = make("finished", 0, 0);
  api.restore(rebuilt, state);
  const stream = rebuilt.querySelector("[data-scroll-keep]");
  const follow = rebuilt.querySelector("[data-activity-follow]");
  assert.equal(follow?.checked, false, "follow stays off");
  assert.equal(stream?.scrollTop, 50, "the reading position is not yanked to the bottom");
  assert.equal(stream?.scrollLeft, 12, "the horizontal reading position survives");
});

test("the log keeps its horizontal reading position when follow is off", () => {
  const { api, document } = loadReconcile();
  const make = (scrollTop: number, scrollLeft: number): FakeElement =>
    build(document, {
      tag: "div",
      children: [
        { tag: "select", attrs: { "data-log-level": "" } },
        { tag: "input", attrs: { "data-log-filter": "" } },
        { tag: "input", attrs: { type: "checkbox", "data-log-follow": "" } },
        {
          tag: "div",
          attrs: { "data-log-items": "", "data-scroll-keep": "log" },
          props: { scrollTop, scrollLeft, scrollHeight: 1000, clientHeight: 200 },
        },
      ],
    });
  const root = make(80, 33);
  const state = api.remember(root);
  const rebuilt = make(0, 0);
  api.restore(rebuilt, state);
  const stream = rebuilt.querySelector("[data-log-items]");
  assert.equal(stream?.scrollTop, 80, "the log keeps the operator's place");
  assert.equal(stream?.scrollLeft, 33, "the log keeps its horizontal offset");
});

// ---------------------------------------------------------------------------
// Sibling-change reconciliation
// ---------------------------------------------------------------------------

test("a sibling state change keeps the expanded node, focus and reading position stable", () => {
  const { api, document } = loadReconcile();
  const make = (
    siblingState: string,
    open: boolean,
    scrollTop: number,
    scrollLeft: number,
  ): FakeElement =>
    build(document, {
      tag: "div",
      children: [
        {
          tag: "details",
          attrs: { "data-live-key": "session-1", "data-details-key": "session-1" },
          props: { open },
          children: [
            { tag: "summary", text: "Session 1" },
            {
              tag: "div",
              attrs: { "data-scroll-keep": "session-log" },
              props: { scrollTop, scrollLeft, scrollHeight: 800, clientHeight: 200 },
              children: [{ tag: "button", attrs: { id: "session-1-retry" }, text: "Retry" }],
            },
          ],
        },
        { tag: "span", attrs: { "data-live-key": "session-2" }, text: siblingState },
      ],
    });
  const root = make("running", true, 90, 15);
  const retry = root.querySelector("#session-1-retry");
  assert.ok(retry);
  retry.focus();
  const state = api.remember(root);

  // An unrelated child changes state; the parent fragment reconciles in place
  // with server defaults, and the client state has to survive.
  const incoming = make("finished", false, 0, 0);
  api.reconcileChildren(root, incoming);
  api.restore(root, state);

  assert.equal(root.querySelector("details")?.open, true, "the expanded node survives");
  assert.equal(document.activeElement, root.querySelector("#session-1-retry"), "focus survives");
  assert.equal(
    root.querySelector('[data-live-key="session-2"]')?.textContent,
    "finished",
    "the unrelated sibling did update",
  );
  const stream = root.querySelector("[data-scroll-keep]");
  assert.equal(stream?.scrollTop, 90, "the reading position survives");
  assert.equal(stream?.scrollLeft, 15, "the horizontal offset survives");
});

test("delegation announcements name the child scope and stay quiet on routine polls", () => {
  const { api, document } = loadReconcile();
  const announcer = document.createElement("div");
  document.querySelector = () => announcer;
  const make = (state: string, timestamp: string, duplicate = false): FakeElement =>
    build(document, {
      tag: "div",
      attrs: { id: "job-detail-region" },
      children: [
        {
          tag: "details",
          attrs: {
            "data-live-key": "attempt-2-invocation-1-ses_child",
            "data-announcement-label": "Attempt 2, invocation 1, agent reviewer, session ses_child",
          },
          children: [
            { tag: "span", attrs: { "data-status-value": state }, text: state },
            ...(duplicate
              ? [{ tag: "span", attrs: { "data-status-value": state }, text: state }]
              : []),
            { tag: "time", text: timestamp },
          ],
        },
      ],
    });
  const before = api.semanticSnapshot(make("running", "first poll"));
  api.announceSemanticChanges(make("running", "second poll", true), before);
  assert.equal(announcer.textContent, "", "timestamps and repeated status copy remain quiet");
  api.announceSemanticChanges(make("succeeded", "third poll"), before);
  assert.equal(
    announcer.textContent,
    "Attempt 2, invocation 1, agent reviewer, session ses_child is now succeeded.",
  );
  assert.equal(announcer.getAttribute("aria-live"), "polite");
  announcer.textContent = "";
  api.announceSemanticChanges(make("succeeded", "reconnect"), before);
  assert.equal(announcer.textContent, "", "replayed transition is deduplicated");
});
