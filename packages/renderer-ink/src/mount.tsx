import React from 'react';
import { render, Text, useInput } from 'ink';
import { JSONUIProvider, Renderer, type StateStore } from '@json-render/ink';
import type { StoreAdapterConfig } from '@json-render/core';
import { createStoreAdapter } from '@json-render/core/store-utils';
import fastJsonPatch, { type Operation } from 'fast-json-patch';
import {
  assertJsonResourceBudget,
  JsonObjectSchema,
  JsonPatchArraySchema,
  JsonValueSchema,
  type ActionBinding,
  type AppSpec,
  type JsonValue,
  type JsonPatch,
  type ActionRequest,
} from '@minitui/types';
import type {
  ActionDispatcher,
  LifecycleEmitter,
  RenderHandle,
  WidgetCatalogBinding,
} from '@minitui/renderer-core';
import type { MinituiCatalog } from '@minitui/catalog';
import { throwingFallback } from '@minitui/catalog'; // render-time gate primitive (component-only)
import { sanitize, sanitizeSpecStrings } from '@minitui/sanitizer';
import { buildHandlers, ELEMENT_KEY } from './binder/build-handlers.js';
import { ConsentOverlay, type ConsentController } from './widgets/consent-overlay.js';
import { createFocusTypeChannel, FocusTypeProvider } from './focus-capture.js';
import type { WidgetProps } from './widgets/command-preview.js';

const { applyOperation } = fastJsonPatch;
const RESERVED_STATE_KEYS = new Set(['__proto__', 'constructor', 'prototype']);
const MAX_STATE_POINTER_DEPTH = 256;

function parseCanonicalPointer(pointer: string): string[] {
  let separators = 0;
  for (let offset = 0; offset < pointer.length; offset++) {
    if (pointer.charCodeAt(offset) === 0x2f && ++separators > MAX_STATE_POINTER_DEPTH) {
      throw new Error(`JSON pointer exceeds max depth ${MAX_STATE_POINTER_DEPTH}`);
    }
  }
  if (pointer === '') return [];
  if (!pointer.startsWith('/')) throw new Error(`invalid JSON pointer: ${pointer}`);
  const tokens = pointer
    .slice(1)
    .split('/')
    .map((token) => token.replace(/~1/g, '/').replace(/~0/g, '~'));
  for (const token of tokens) {
    if (RESERVED_STATE_KEYS.has(token)) throw new Error(`reserved state key not allowed: ${token}`);
    if (sanitize(token) !== token) {
      throw new Error(`state key is not canonical: ${JSON.stringify(token)}`);
    }
  }
  return tokens;
}

function isArrayValue(value: JsonValue): value is readonly JsonValue[] {
  return Array.isArray(value);
}

function isObjectValue(value: JsonValue): value is { readonly [key: string]: JsonValue } {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function parseArrayIndexToken(token: string): number | '-' | undefined {
  if (token === '-') return '-';
  if (!/^(0|[1-9][0-9]*)$/.test(token)) return undefined;
  const index = Number(token);
  return Number.isSafeInteger(index) ? index : undefined;
}

function assertCanonicalStateValue(value: JsonValue): void {
  const pending: JsonValue[] = [value];
  while (pending.length > 0) {
    const current = pending.pop()!;
    if (isArrayValue(current)) {
      for (const item of current) pending.push(item);
    } else if (isObjectValue(current)) {
      for (const [key, item] of Object.entries(current)) {
        if (RESERVED_STATE_KEYS.has(key)) throw new Error(`reserved state key not allowed: ${key}`);
        if (sanitize(key) !== key) {
          throw new Error(`state key is not canonical: ${JSON.stringify(key)}`);
        }
        pending.push(item);
      }
    }
  }
}

function resolveExisting(document: JsonValue, tokens: readonly string[]): JsonValue {
  let current = document;
  for (const token of tokens) {
    if (isArrayValue(current)) {
      const index = parseArrayIndexToken(token);
      if (index === undefined) throw new Error(`invalid array index: ${JSON.stringify(token)}`);
      if (index === '-' || index >= current.length) {
        throw new Error(`array member does not exist: ${JSON.stringify(token)}`);
      }
      current = current[index]!;
    } else if (isObjectValue(current)) {
      if (!Object.hasOwn(current, token)) throw new Error(`object member does not exist: ${token}`);
      current = current[token]!;
    } else {
      throw new Error('patch path traverses a primitive');
    }
  }
  return current;
}

function resolveParent(
  document: JsonValue,
  tokens: readonly string[],
): { readonly parent: JsonValue; readonly token: string } {
  const token = tokens.at(-1);
  if (token === undefined) throw new Error('root pointer has no parent');
  return { parent: resolveExisting(document, tokens.slice(0, -1)), token };
}

function assertAddTarget(document: JsonValue, tokens: readonly string[]): void {
  if (tokens.length === 0) return;
  const { parent, token } = resolveParent(document, tokens);
  if (isArrayValue(parent)) {
    const index = parseArrayIndexToken(token);
    if (index === undefined || (index !== '-' && index > parent.length)) {
      throw new Error(`invalid add array index: ${JSON.stringify(token)}`);
    }
  } else if (!isObjectValue(parent)) {
    throw new Error('patch target parent is a primitive');
  }
}

function assertExistingTarget(document: JsonValue, tokens: readonly string[]): void {
  if (tokens.length === 0) return;
  const { parent, token } = resolveParent(document, tokens);
  if (isArrayValue(parent)) {
    // A malformed token (leading zero, sign, non-digits) is a different defect than a
    // well-formed index that is out of range; name each precisely.
    const index = parseArrayIndexToken(token);
    if (index === undefined) throw new Error(`invalid array index: ${JSON.stringify(token)}`);
    if (index === '-' || index >= parent.length) {
      throw new Error(`array member does not exist: ${JSON.stringify(token)}`);
    }
  } else if (isObjectValue(parent)) {
    if (!Object.hasOwn(parent, token)) throw new Error(`object member does not exist: ${token}`);
  } else {
    throw new Error('patch target parent is a primitive');
  }
}

function isStrictPrefix(prefix: readonly string[], value: readonly string[]): boolean {
  return prefix.length < value.length && prefix.every((token, index) => value[index] === token);
}

// Array.isArray narrows a union containing a readonly array to any[], which leaks `any` into
// the caller; this guard keeps the prepared-binding walk fully typed.
function isBindingList(
  value: ActionBinding | readonly ActionBinding[],
): value is readonly ActionBinding[] {
  return Array.isArray(value);
}

function applyCanonicalOperation(
  document: JsonValue,
  operation: JsonPatch,
  index: number,
): JsonValue {
  const path = parseCanonicalPointer(operation.path);
  if ('value' in operation) assertCanonicalStateValue(operation.value);
  if (operation.op === 'add') assertAddTarget(document, path);
  if (operation.op === 'replace' || operation.op === 'remove' || operation.op === 'test') {
    assertExistingTarget(document, path);
  }
  if (operation.op === 'copy') {
    const from = parseCanonicalPointer(operation.from);
    const value = structuredClone(resolveExisting(document, from));
    assertAddTarget(document, path);
    return applyOperation(
      document,
      { op: 'add', path: operation.path, value },
      true,
      true,
      true,
      index,
    ).newDocument;
  }
  if (operation.op === 'move') {
    const from = parseCanonicalPointer(operation.from);
    const value = structuredClone(resolveExisting(document, from));
    if (isStrictPrefix(from, path)) throw new Error('move source cannot contain its destination');
    const removal: Operation = { op: 'remove', path: operation.from };
    const afterRemovalProbe = JsonValueSchema.parse(
      applyOperation(structuredClone(document), removal, true, true, true, index).newDocument,
    );
    assertAddTarget(afterRemovalProbe, path);
    const afterRemoval = applyOperation(document, removal, true, true, true, index).newDocument;
    return applyOperation(
      afterRemoval,
      { op: 'add', path: operation.path, value },
      true,
      true,
      true,
      index,
    ).newDocument;
  }
  return applyOperation(document, structuredClone(operation) as Operation, true, true, true, index)
    .newDocument;
}

export interface MountInkArgs {
  readonly spec: AppSpec;
  readonly catalog: MinituiCatalog;
  readonly binding: WidgetCatalogBinding<React.ComponentType<WidgetProps>>;
  readonly dispatcher: ActionDispatcher;
  readonly store: StoreAdapterConfig; // controlled io over the transport data store
  readonly onLifecycle?: LifecycleEmitter | undefined;
  readonly consent: ConsentController;
  readonly accessible?: boolean | undefined;
  // The post-mount QUIT producer's outlet. The mounted app's app-shell key binding (`q`, when
  // no consent modal is up and no free-text widget is focused) calls this; the HOST wires it to
  // a clean-completion quit — renderer-ink never imports the host runtime, so it does not own
  // the outcome vocabulary; it only signals "the user quit, cleanly".
  readonly onQuit?: (() => void) | undefined;
  readonly onCancel?: (() => void) | undefined; // Esc → the host maps this to a cancelled quit
  // Optional fake stdio for headless capture. The headless test harness injects
  // ink-testing-library-shaped streams here; forwarded VERBATIM into ink's render(tree, options),
  // defaulting to the real process streams. The seam lives ONLY on this ink-specific entry —
  // RendererPort stays renderer-agnostic (no io on the port).
  readonly io?:
    | {
        readonly stdout?: NodeJS.WriteStream | undefined;
        readonly stderr?: NodeJS.WriteStream | undefined;
        readonly stdin?: NodeJS.ReadStream | undefined;
        readonly debug?: boolean | undefined;
      }
    | undefined;
  // Test seam — the ink `render` entry, injected so a test can observe a render OPTION
  // (`isScreenReaderEnabled`) that the io-stream seam cannot carry, with a REAL wrapping render
  // instead of replacing the `ink` module. Defaults to ink's real `render`; production callers
  // never pass it. Lives ONLY on this ink-specific entry (like `io`) — RendererPort stays
  // renderer-agnostic.
  readonly renderInk?: typeof render | undefined;
}

// The handle `mountInk` returns: the `RenderHandle` PORT plus two TEST-ONLY inspection members
// that let renderer-ink's own tests assert through a typed public surface instead of an untyped
// reach-in (the prepared-spec chokepoint; a real drive into the wrapped handler map). The
// renderer-port impl narrows this to `RenderHandle` at the port boundary, so no production
// consumer (the host, via the port) ever sees them — the swap surface stays exactly RenderHandle.
export interface InkMountHandle extends RenderHandle {
  readonly activeSpec: AppSpec; // the live PREPARED spec (sanitized + gated)
  fireAction(elementKey: string, event: string): Promise<void>; // real call into the SAME wrapped handler map `emit` uses
}

// --- catalog allowlist: the render-time gate fires BEFORE render ---
// json-render wraps every element in an error boundary; a render-phase throw is swallowed
// (the boundary flips to an error state and renders null), so a throwing fallback can NEVER
// fail the mount. This synchronous walk is the reliable gate: unknown component type OR
// unknown on/watch action -> throw, outside React.
type SpecBinding = {
  action: string;
  params?: Record<string, unknown> | undefined;
  confirm?: unknown;
  onSuccess?: unknown;
  onError?: unknown;
};
type BindingField = Record<string, SpecBinding | SpecBinding[]>;

function eachBinding(el: AppSpec['elements'][string], visit: (b: SpecBinding) => void): void {
  for (const field of ['on', 'watch'] as const) {
    const bindings = (el as Record<string, unknown>)[field] as BindingField | undefined;
    if (!bindings) continue;
    for (const b of Object.values(bindings)) {
      for (const one of Array.isArray(b) ? b : [b]) visit(one);
    }
  }
}

export function assertSpecOnCatalog(spec: AppSpec, catalog: MinituiCatalog): void {
  for (const [key, el] of Object.entries(spec.elements)) {
    if (!catalog.componentDefs.has(el.type)) {
      // Call the catalog's exported render-time primitive (throws naming the type) from this
      // synchronous PRE-render walk. The action branch keeps its own error — the primitive is
      // component-only.
      throwingFallback(el.type);
    }
    eachBinding(el, (b) => {
      if (!catalog.actionDefs.has(b.action)) {
        throw new Error(
          `unknown action "${b.action}" (element "${key}") is not in the catalog allowlist`,
        );
      }
    });
  }
}

// Defense-in-depth for anything that slips the pre-render gate: render a LOUD red marker
// naming the off-catalog type. Deliberately does NOT throw (the boundary would null it out).
// Receives json-render's real component-render calling convention: { element }.
export function makeOffCatalogFallback(): React.ComponentType<{ element: { type: string } }> {
  return function OffCatalogFallback({
    element,
  }: {
    element: { type: string };
  }): React.ReactElement {
    return <Text color="red">[off-catalog: {element.type}]</Text>;
  };
}

// DEC-2026 synchronized output (tear-free streaming frames). ink 6.8.0 brackets its own
// throttled TTY frame writes in these escapes, but skips the bracketing whenever it detects a
// CI environment, and the guarantee lives inside ink's private write path. This wrapper makes
// the invariant minitui's own: every write to the RESOLVED stdout is bracketed
// begin-synchronized-update + data + end-synchronized-update whenever the stream is a TTY.
// Unsupported terminals ignore the private-mode escapes (safe no-op); non-TTY (pipe/CI) is
// returned unwrapped so no escapes leak into logs or captured frames.
export function withSynchronizedOutput(stdout: NodeJS.WriteStream): NodeJS.WriteStream {
  if (!stdout.isTTY) return stdout;
  const BSU = '\u001B[?2026h'; // begin synchronized update
  const ESU = '\u001B[?2026l'; // end synchronized update
  return new Proxy(stdout, {
    get(target, prop): unknown {
      if (prop !== 'write') {
        const value: unknown = Reflect.get(target, prop, target);
        if (typeof value === 'function') {
          const bound: unknown = value.bind(target);
          return bound;
        }
        return value;
      }
      return (chunk: unknown, ...rest: unknown[]): boolean => {
        target.write(BSU);
        const ok = (target.write as (...a: unknown[]) => boolean)(chunk, ...rest);
        target.write(ESU);
        return ok;
      };
    },
  });
}

// ONE immutable prepare pass at bind + every update:
//  1. sanitizeSpecStrings — the SPEC sanitize chokepoint;
//  2. assertSpecOnCatalog — synchronous allowlist gate;
//  3. binding rewrite (on + watch, single or array): confirm AND the onSuccess/onError callback
//     chains STRIPPED — json-render's confirmation dialog renders agent-authored
//     confirm.title/message when present, and its action provider runs onSuccess.set (ungated
//     state write) / onSuccess.action (secondary action) / onError.* past the frozen action
//     grammar; undefined keeps all three inert — and gated actions get params[ELEMENT_KEY]
//     injected (handlers receive ONLY params — there is no other element-key channel);
//  4. props normalized to {} (json-render's element props field is required).
function prepareSpec(spec: AppSpec, catalog: MinituiCatalog): AppSpec {
  const clean = sanitizeSpecStrings(spec);
  assertSpecOnCatalog(clean, catalog);
  const elements: Record<string, AppSpec['elements'][string]> = {};
  for (const [key, el] of Object.entries(clean.elements)) {
    const next: Record<string, unknown> = { ...el, props: el.props ?? {} };
    // rewrite one binding: strip the confirm/onSuccess/onError agent grammar + inject the gated
    // element key. Mapping the single binding directly (never list[0]) keeps it clean under
    // noUncheckedIndexedAccess; the render-local params branch copies to {} so it is never
    // `undefined` under exactOptionalPropertyTypes.
    const rewriteOne = (one: SpecBinding): SpecBinding => ({
      ...one,
      confirm: undefined,
      onSuccess: undefined,
      onError: undefined,
      params:
        catalog.actionDefs.get(one.action)?.kind !== 'render-local'
          ? { ...(one.params ?? {}), [ELEMENT_KEY]: key }
          : { ...(one.params ?? {}) },
    });
    for (const field of ['on', 'watch'] as const) {
      const bindings = (el as Record<string, unknown>)[field] as BindingField | undefined;
      if (!bindings) continue;
      const rewritten: BindingField = {};
      for (const [event, b] of Object.entries(bindings)) {
        rewritten[event] = Array.isArray(b) ? b.map(rewriteOne) : rewriteOne(b);
      }
      next[field] = rewritten;
    }
    elements[key] = next as AppSpec['elements'][string];
  }
  return { ...clean, elements };
}

// catalog component id -> native factory, via the renderer-agnostic binding.
function buildComponentMap(
  catalog: MinituiCatalog,
  binding: WidgetCatalogBinding<React.ComponentType<WidgetProps>>,
): Record<string, React.ComponentType<WidgetProps>> {
  const map: Record<string, React.ComponentType<WidgetProps>> = {};
  for (const id of catalog.componentDefs.keys()) {
    const factory = binding.resolve(id)?.factory;
    if (factory) map[id] = factory;
  }
  return map;
}

export function mountInk(args: MountInkArgs): InkMountHandle {
  const {
    spec,
    catalog,
    binding,
    dispatcher,
    store: io,
    onLifecycle,
    consent,
    onQuit,
    onCancel,
  } = args;

  // --- the SPEC chokepoint (bind + every update) ---
  let activeSpec = prepareSpec(spec, catalog);
  const specListeners = new Set<() => void>();
  const notifySpec = (): void => specListeners.forEach((f) => f());

  const emitLifecycle = (e: Parameters<LifecycleEmitter['emit']>[0]): void => onLifecycle?.emit(e);

  const actionRequests = new Set<(req: ActionRequest) => void>();
  const notifyAction = (req: ActionRequest): void => actionRequests.forEach((f) => f(req));

  // controlled store: build the StateStore from the transport io. The io's setSnapshot stays
  // in hand for applyStatePatch — the built StateStore has NO whole-snapshot writer.
  const store: StateStore = createStoreAdapter(io);

  // gated handlers for exec/mcp/callback + rejecting overrides for log/exit; the allowlisted
  // STATE mutators are ABSENT so json-render's native store-backed built-ins run for them.
  const rawHandlers = buildHandlers({
    catalog,
    dispatcher,
    getState: () => JsonObjectSchema.parse(io.getSnapshot()),
    emitLifecycle,
  });
  // Each installed handler also notifies onAction subscribers with the ActionRequest (the host
  // and cli observe fired actions). Native state built-ins bypass this map by design; their
  // effects are observable through the store io itself.
  const handlers: Record<string, (params: Record<string, unknown>) => Promise<void>> = {};
  for (const [name, fn] of Object.entries(rawHandlers)) {
    handlers[name] = async (params) => {
      const rawKey = params[ELEMENT_KEY];
      const key = typeof rawKey === 'string' ? rawKey : '';
      const clean = { ...params };
      delete clean[ELEMENT_KEY];
      notifyAction({ actionName: name, elementKey: key, params: clean });
      await fn(params); // fn re-strips ELEMENT_KEY for gated handlers; rejectors ignore params
    };
  }

  const componentMap = buildComponentMap(catalog, binding);
  const Fallback = makeOffCatalogFallback();
  // Focused-text-capture seam: the interactive custom widgets report their focused element TYPE
  // here (via json-render's real useFocus), and the app-shell resolves its catalog `capturesText`
  // off the binding to gate the `q` quit key. Provided to the tree below via FocusTypeProvider.
  const focusTypes = createFocusTypeChannel();

  const App: React.FC = () => {
    const [, force] = React.useReducer((n: number) => n + 1, 0);
    React.useEffect(() => {
      specListeners.add(force);
      return () => {
        specListeners.delete(force);
      };
    }, []);
    // Quit producer — a GLOBAL binding at the APP SHELL, ABOVE json-render's focus ring. App is
    // NOT a focus-ring member, so this binding claims no focus slot / Tab stop — it sits OVER
    // the ring. It defers to focused widgets on the only key that can collide:
    //  - Esc quits (cancel) whenever no consent modal is up. SAFE: every adopted interactive
    //    widget explicitly ignores Esc (the std text input early-returns on escape;
    //    Select/MultiSelect/ConfirmInput/Tabs act only on their own keys), so a shell Esc never
    //    eats a focused keystroke.
    //  - `q` quits (clean finish) UNLESS the currently-FOCUSED widget captures FREE TEXT — a
    //    text field consumes `q` as a typed character, so `q` must stay literal there. This is
    //    the FREE-TEXT reading, NOT a broader "any interactive widget in the spec" scan: a
    //    focused Button/Select/OrderList does NOT capture free text, so `q` still quits with
    //    them focused — otherwise a fully-interactive app with no text field would have NO
    //    clean-quit key (Esc means cancel, not completed). json-render does NOT expose the
    //    ring's focused id and a widget never receives its spec map-key, so the shell cannot
    //    read focus off json-render directly — instead the focus-capture seam carries the
    //    focused element TYPE up from the widgets (each reports via json-render's real
    //    useFocus().isActive), and the shell resolves its `capturesText` off the binding. A
    //    non-reporting focus (display-only spec, or a focused std non-text widget) reads as
    //    "not capturing", so `q` quits — the correct default.
    // The handler is inert while a consent modal is up (the overlay owns Esc = deny then).
    // `isActive` matches ConsentOverlay's pattern: only bind (enable raw mode) when a quit sink
    // exists — a mount with no `onQuit`/`onCancel` never touches raw mode.
    const focusedCapturesText = (): boolean => {
      const type = focusTypes.focusedType();
      return type !== undefined && binding.resolve(type)?.capturesText === true;
    };
    useInput(
      (input, key) => {
        if (consent.request !== undefined) return; // consent modal owns the keyboard
        if (key.escape) {
          onCancel?.();
          return;
        } // Esc = cancel quit
        if (input === 'q' && !focusedCapturesText()) onQuit?.(); // q = clean quit
      },
      { isActive: onQuit !== undefined || onCancel !== undefined },
    );
    return (
      <FocusTypeProvider value={focusTypes}>
        <JSONUIProvider store={store} handlers={handlers}>
          <Renderer
            spec={
              activeSpec as never /* structural bridge: prepared AppSpec (props normalized) is json-render Spec-shaped */
            }
            registry={
              componentMap as never /* structural bridge: WidgetProps.element.props is optional while json-render's element props is required — the same documented bridge the widget siblings use */
            }
            includeStandard={false}
            fallback={
              Fallback as never /* narrowed props — receives the full component-render props at runtime */
            }
          />
          <ConsentOverlay controller={consent} />
        </JSONUIProvider>
      </FocusTypeProvider>
    );
  };

  // Forward the caller's io (the headless test harness injects fake stdio here) into ink's
  // render, defaulting to the real process streams. withSynchronizedOutput wraps the RESOLVED
  // stdout; its isTTY guard returns a non-TTY stream (fake / pipe / CI) unwrapped, so DEC-2026
  // frame bracketing lands ONLY on a real TTY and no escapes leak into captured frames.
  // `renderInk` (defaulting to ink's real `render`) is the injected render entry — a test hands
  // a REAL wrapping render that records the options; production runs ink's `render` unchanged.
  const doRender = args.renderInk ?? render;
  const instance = doRender(<App />, {
    stdout: withSynchronizedOutput(args.io?.stdout ?? process.stdout),
    stderr: args.io?.stderr ?? process.stderr,
    stdin: args.io?.stdin ?? process.stdin,
    // Never let ink globally patch console: minitui owns its own diagnostics, and ink's patch would
    // route console.log around the sanitizer chokepoint (the same native-log bypass the render-local
    // allowlist rejects). It also makes the global patch state leak across renders in one process.
    patchConsole: false,
    // ink's RenderOptions is THIRD-PARTY and its optional fields carry no `| undefined`; under
    // exactOptionalPropertyTypes an explicit `undefined` value is rejected, so an omitted
    // debug/accessible flag is OMITTED from the object entirely (never widen a third-party type).
    ...(args.io?.debug !== undefined ? { debug: args.io.debug } : {}),
    // accessible → ink's screen-reader mode. Pass the raw flag so an omitted flag stays
    // undefined and ink keeps its INK_SCREEN_READER env default, rather than clobbering it
    // with a hardcoded false.
    ...(args.accessible !== undefined ? { isScreenReaderEnabled: args.accessible } : {}),
  });

  const handle: InkMountHandle = {
    get activeSpec() {
      return activeSpec;
    },
    update(next: AppSpec): void {
      activeSpec = prepareSpec(next, catalog); // same chokepoint as bind: sanitize + assert + rewrite
      notifySpec();
    },
    // TEST-ONLY: a real call into the SAME wrapped handler map the live `emit` path uses (not a
    // mock) — the deny-outcome unit asserts outcome→lifecycle without a second full keypress
    // render. Reads the PREPARED binding (single or array), whose params already carry the
    // injected ELEMENT_KEY.
    async fireAction(elementKey: string, event: string): Promise<void> {
      const raw = activeSpec.elements[elementKey]?.on?.[event];
      if (!raw) return;
      const list: readonly ActionBinding[] = isBindingList(raw) ? raw : [raw];
      for (const b of list) {
        const handler = handlers[b.action];
        if (handler) await handler({ ...(b.params ?? {}) });
      }
    },
    applyStatePatch(patch: readonly JsonPatch[]): void {
      // FULL RFC-6902 per the renderer-core contract — move/copy/test included.
      // Parse first, then mutate only one private clone. The local preflight mirrors the
      // transport-side patch semantics without introducing the forbidden renderer→transport
      // edge. Keep intermediate documents mutable: readonly schemas freeze parsed containers,
      // so the final object parse belongs after the complete sequence.
      const parsed = JsonPatchArraySchema.parse(patch);
      const initial = JsonObjectSchema.parse(io.getSnapshot());
      assertCanonicalStateValue(initial);
      let document: JsonValue = structuredClone(initial);
      for (let index = 0; index < parsed.length; index++) {
        document = applyCanonicalOperation(document, parsed[index]!, index);
        assertJsonResourceBudget(document);
      }
      // A generic patch may produce null at the root; json-render's state model may not.
      // Parse before the sole write so rejection is atomic.
      const next = JsonObjectSchema.parse(document);
      assertCanonicalStateValue(next);
      io.setSnapshot(next);
    },
    onAction(handler: (req: ActionRequest) => void): () => void {
      actionRequests.add(handler);
      return () => actionRequests.delete(handler);
    },
    unmount(): void {
      instance.unmount(); // ink restores the terminal
    },
  };
  return handle;
}
