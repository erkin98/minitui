import React from 'react';
import { Box, render, Text, useInput } from 'ink';
import { JSONUIProvider, Renderer, type StateStore } from '@json-render/ink';
import type { StoreAdapterConfig } from '@json-render/core';
import { createStoreAdapter } from '@json-render/core/store-utils';
import {
  JsonObjectSchema,
  type ActionBinding,
  type AppSpec,
  type JsonPatch,
  type ActionRequest,
  type DiagnosticsPort,
} from '@minitui/types';
import type {
  ActionDispatcher,
  ActionLifecycleEvent,
  LifecycleEmitter,
  RenderHandle,
  WidgetCatalogBinding,
} from '@minitui/renderer-core';
import type { MinituiCatalog } from '@minitui/catalog';
import { checkElementTree, hasCanonicalKeys } from '@minitui/catalog'; // the shared tree rule
import { RendererRefusal } from './refusal.js';
import { applyStatePatchTo } from './state-patch.js';
import { reportFault } from './binder/report.js';
import { refusalLine } from './binder/refusal-line.js';
import { sanitize, sanitizeSpecStrings } from '@minitui/sanitizer';
import { buildHandlers, ELEMENT_KEY } from './binder/build-handlers.js';
import { ConsentOverlay, type ConsentController } from './widgets/consent-overlay.js';
import { createFocusTypeChannel, FocusTypeProvider } from './focus-capture.js';
import type { WidgetProps } from './widgets/command-preview.js';
import { SELF_DISPLAYING } from './widgets/bindings.js';
import { withDisplayText } from './widgets/display-text.js';

// Array.isArray narrows a union containing a readonly array to any[], which leaks `any` into
// the caller; this guard keeps the prepared-binding walk fully typed.
function isBindingList(
  value: ActionBinding | readonly ActionBinding[],
): value is readonly ActionBinding[] {
  return Array.isArray(value);
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
  // Whether ink itself exits on Ctrl-C. Off by default: the mount treats Ctrl-C as a cancel and first
  // denies a pending request, and the host restores the terminal and exits.
  readonly exitOnCtrlC?: boolean | undefined;
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
  // Where a contained failure is reported (a failing action, a throwing subscriber, a rejecting log or
  // exit handler). Absent means nowhere.
  readonly diagnostics?: DiagnosticsPort | undefined;
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
// (the boundary flips to an error state and renders null), so a throw inside a render can NEVER
// fail the mount. This synchronous walk is the reliable gate: an unknown component type OR an
// unknown on/watch action throws a coded refusal (off-catalog) before render, outside React.
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

// A name the catalog does not list: the message is fixed text and the sanitised name, never raw text.
const offCatalog = (what: 'component' | 'action', name: string): RendererRefusal =>
  new RendererRefusal('off-catalog', `${what} "${sanitize(name)}" is not in the catalog allowlist`);

export function assertSpecOnCatalog(spec: AppSpec, catalog: MinituiCatalog): void {
  for (const el of Object.values(spec.elements)) {
    if (!catalog.componentDefs.has(el.type)) throw offCatalog('component', el.type);
    eachBinding(el, (b) => {
      if (!catalog.actionDefs.has(b.action)) throw offCatalog('action', b.action);
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

// The clear-terminal sequence: erase the screen and the scrollback, cursor home.
const CLEAR_TERMINAL =
  String.fromCharCode(27) +
  '[2J' +
  String.fromCharCode(27) +
  '[3J' +
  String.fromCharCode(27) +
  '[H';

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
//  1. hasCanonicalKeys on the raw spec — the key predicate, first, because the sanitiser walks a graph
//     that shares references as a tree (exponential);
//  2. sanitizeSpecStrings — the SPEC sanitize chokepoint;
//  3. assertSpecOnCatalog — synchronous allowlist gate;
//  4. checkElementTree — children form a tree within the depth bound;
//  5. a `watch` map is refused (the installed renderer has no watch implementation);
//  6. binding rewrite (`on`, single or array): the result has EXACTLY the keys action and params —
//     confirm, the onSuccess/onError callback chains and every unknown key are dropped, because
//     json-render's confirmation dialog renders agent-authored confirm text when present and its
//     action provider runs onSuccess.set (ungated state write) / onSuccess.action (secondary
//     action) / onError.* past the frozen action grammar — and gated actions get params[ELEMENT_KEY]
//     injected (handlers receive ONLY params — there is no other element-key channel);
//  7. props normalized to {} (json-render's element props field is required).
// Each element type the spec uses is resolved through the binding once, here, before any render. A type
// that resolves to nothing is refused: a marker in the frame would hide that the catalog lists a
// component the renderer cannot draw.
function refuseUnbound(
  spec: AppSpec,
  binding: WidgetCatalogBinding<React.ComponentType<WidgetProps>>,
): void {
  const types = new Set(Object.values(spec.elements).map((el) => el.type));
  for (const type of types) {
    if (binding.resolve(type) === undefined) {
      throw new RendererRefusal(
        'unbound-component',
        `component "${type}" is not bound by catalog "${binding.catalogId}"`,
      );
    }
  }
}

function refuseWatch(spec: AppSpec): void {
  for (const el of Object.values(spec.elements)) {
    if ((el as Record<string, unknown>).watch) {
      throw new RendererRefusal(
        'watch-unsupported',
        'the Ink renderer does not support watch bindings',
      );
    }
  }
}

function rewriteBindings(
  el: AppSpec['elements'][string],
  key: string,
  catalog: MinituiCatalog,
): BindingField | undefined {
  const bindings = (el as Record<string, unknown>).on as BindingField | undefined;
  if (!bindings) return undefined;
  // Mapping the single binding directly (never list[0]) keeps it clean under noUncheckedIndexedAccess;
  // the render-local params branch copies to {} so it is never `undefined` under
  // exactOptionalPropertyTypes.
  const rewriteOne = (one: SpecBinding): SpecBinding => ({
    action: one.action,
    params:
      catalog.actionDefs.get(one.action)?.kind !== 'render-local'
        ? { ...(one.params ?? {}), [ELEMENT_KEY]: key }
        : { ...(one.params ?? {}) },
  });
  const rewritten: BindingField = {};
  for (const [event, b] of Object.entries(bindings)) {
    rewritten[event] = Array.isArray(b) ? b.map(rewriteOne) : rewriteOne(b);
  }
  return rewritten;
}

function prepareSpec(
  spec: AppSpec,
  catalog: MinituiCatalog,
  binding: WidgetCatalogBinding<React.ComponentType<WidgetProps>>,
): AppSpec {
  // The key predicate runs first: it screens for a plain JSON tree, and the sanitiser walks a graph
  // that shares references as a tree (exponential). The generation gate refuses such specs; this is
  // the render-side backstop.
  if (!hasCanonicalKeys(spec)) {
    throw new RendererRefusal(
      'non-canonical-key',
      'the spec holds a key that sanitising would change',
    );
  }
  const clean = sanitizeSpecStrings(spec);
  assertSpecOnCatalog(clean, catalog);
  const [issue] = checkElementTree(clean);
  if (issue !== undefined) {
    throw new RendererRefusal('not-a-tree', `${issue.code}: ${issue.message}`);
  }
  refuseUnbound(clean, binding);
  refuseWatch(clean);
  const elements: Record<string, AppSpec['elements'][string]> = {};
  for (const [key, el] of Object.entries(clean.elements)) {
    const next: Record<string, unknown> = { ...el, props: el.props ?? {} };
    const on = rewriteBindings(el, key, catalog);
    if (on !== undefined) next.on = on;
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
    if (factory) map[id] = SELF_DISPLAYING.has(factory) ? factory : withDisplayText(factory);
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
  let activeSpec = prepareSpec(spec, catalog, binding);
  const specListeners = new Set<() => void>();
  const notifySpec = (): void => specListeners.forEach((f) => f());

  // The refusal row: the last refused or failed gated action, cleared when the next one starts. It is
  // updated before the host's sink runs, so a throwing sink cannot leave it stale.
  let refusalText: string | undefined;
  const emitLifecycle = (e: ActionLifecycleEvent): void => {
    const next =
      e.phase === 'error'
        ? refusalLine(e.actionName, e.fault)
        : e.phase === 'started'
          ? undefined
          : refusalText;
    if (next !== refusalText) {
      refusalText = next;
      notifySpec();
    }
    onLifecycle?.emit(e);
  };

  const actionRequests = new Set<(req: ActionRequest) => void>();
  // a throwing subscriber is reported and the others, and the action itself, still run
  const notifyAction = (req: ActionRequest): void =>
    actionRequests.forEach((f) => {
      try {
        f(req);
      } catch (error) {
        reportFault(args.diagnostics, 'an action subscriber failed', error);
      }
    });

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
    diagnostics: args.diagnostics,
  });
  // Each installed handler also notifies onAction subscribers with the ActionRequest (the host
  // and cli observe fired actions). Native state built-ins bypass this map by design; their
  // effects are observable through the store io itself.
  const handlers: Record<string, (params: Record<string, unknown>) => Promise<void>> = {};
  for (const [name, fn] of Object.entries(rawHandlers)) {
    handlers[name] = async (params) => {
      // A widget acts only while no request is pending. The controller is read here, at call time: the
      // keyboard isolation of the overlay arrives one commit after the box is first drawn, and a key
      // written in that commit would otherwise dispatch a gated action behind the prompt.
      if (consent.request !== undefined) return;
      const rawKey = params[ELEMENT_KEY];
      const key = typeof rawKey === 'string' ? rawKey : '';
      const clean = { ...params };
      delete clean[ELEMENT_KEY];
      notifyAction({ actionName: name, elementKey: key, params: clean });
      try {
        await fn(params); // fn re-strips ELEMENT_KEY for gated handlers; rejectors ignore params
      } catch (error) {
        // the log and exit rejectors reject by design; the library would print the rejection
        reportFault(args.diagnostics, 'an installed action handler failed', error, {
          actionName: name,
        });
      }
    };
  }

  const componentMap = buildComponentMap(catalog, binding);
  const Fallback = makeOffCatalogFallback();
  // Focused-text-capture seam: the interactive custom widgets report their focused element TYPE
  // here (via json-render's real useFocus), and the app-shell resolves its catalog `capturesText`
  // off the binding to gate the `q` quit key. Provided to the tree below via FocusTypeProvider.
  const focusTypes = createFocusTypeChannel();

  // The resolved output stream. withSynchronizedOutput brackets writes on a real TTY only; a fake or
  // piped stream comes back unwrapped, so no escapes leak into captured frames.
  const rawStdout = args.io?.stdout ?? process.stdout;
  const stdout = withSynchronizedOutput(rawStdout);
  // the render instance exists only after the first render; the clear below runs on later notifications
  const mounted: { instance?: ReturnType<typeof render> } = {};

  // When a request opens on a terminal (outside debug mode), clear the visible screen and reset the
  // renderer's frame accounting before the frame that shows the box is written: the renderer erases
  // one line per logical row, so rows that an earlier app frame wrapped past the terminal edge would
  // otherwise stay on the screen above the box.
  const clearScreenForRequest = (): void => {
    if (rawStdout.isTTY !== true || args.io?.debug === true) return;
    stdout.write(CLEAR_TERMINAL);
    mounted.instance?.clear();
  };

  const App: React.FC = () => {
    const [, force] = React.useReducer((n: number) => n + 1, 0);
    React.useEffect(() => {
      specListeners.add(force);
      return () => {
        specListeners.delete(force);
      };
    }, []);
    // The single read of the consent controller for this render. It decides whether the app is
    // drawn and it is the request the overlay shows, so a frame never holds both. The shell is the
    // only subscriber; the overlay gets a view that does not subscribe.
    const request = consent.request;
    const rendered = React.useRef(request);
    rendered.current = request;
    React.useEffect(() => {
      let hadRequest = rendered.current !== undefined;
      const unsubscribe = consent.subscribe(() => {
        const open = consent.request !== undefined;
        if (open && !hadRequest) clearScreenForRequest();
        hadRequest = open;
        force();
      });
      // a request that arrived between the render and this subscription
      if (consent.request !== rendered.current) force();
      return unsubscribe;
    }, []);
    const view = React.useMemo<ConsentController>(
      () => ({
        request,
        subscribe: () => () => {},
        resolve: (decision) => consent.resolve(decision),
      }),
      [request],
    );
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
    // exists. The focus provider of the adopted library binds the keyboard on every mount, so raw
    // mode is requested whatever this option says; a mount needs a stdin that supports it.
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
      // inactive while a request is pending, so that Escape denies and does nothing else whatever the
      // order of the listeners
      {
        isActive: (onQuit !== undefined || onCancel !== undefined) && request === undefined,
      },
    );
    // Ctrl-C cancels, as Esc does, and first denies a pending request so no decision is left open. ink
    // does not consume the key (exitOnCtrlC is off), and this listener is active with or without a
    // pending request; the overlay acts on plain keys only.
    useInput((input, key) => {
      if (!key.ctrl || input !== 'c') return;
      if (consent.request !== undefined) consent.resolve({ kind: 'deny' });
      onCancel?.();
    });
    return (
      <FocusTypeProvider value={focusTypes}>
        <JSONUIProvider store={store} handlers={handlers}>
          {/* The app stays mounted (its state and effects continue) but is not laid out and draws
              nothing while a request is pending. */}
          <Box flexDirection="column" display={request === undefined ? 'flex' : 'none'}>
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
            {refusalText !== undefined ? <Text wrap="truncate-end">{refusalText}</Text> : null}
          </Box>
          <ConsentOverlay controller={view} live={() => consent.request} />
        </JSONUIProvider>
      </FocusTypeProvider>
    );
  };

  // Forward the caller's io (the headless test harness injects fake stdio here) into ink's
  // render, defaulting to the real process streams. `stdout` is the RESOLVED stream wrapped by
  // withSynchronizedOutput. `renderInk` (defaulting to ink's real `render`) is the injected render
  // entry — a test hands a REAL wrapping render that records the options; production runs ink's
  // `render` unchanged.
  const doRender = args.renderInk ?? render;
  mounted.instance = doRender(<App />, {
    stdout,
    stderr: args.io?.stderr ?? process.stderr,
    stdin: args.io?.stdin ?? process.stdin,
    // Never let ink globally patch console: minitui owns its own diagnostics, and ink's patch would
    // route console.log around the sanitizer chokepoint (the same native-log bypass the render-local
    // allowlist rejects). It also makes the global patch state leak across renders in one process.
    patchConsole: false,
    exitOnCtrlC: args.exitOnCtrlC ?? false,
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
      activeSpec = prepareSpec(next, catalog, binding); // same chokepoint as bind: sanitize + assert + rewrite
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
      applyStatePatchTo(io, patch);
    },
    onAction(handler: (req: ActionRequest) => void): () => void {
      actionRequests.add(handler);
      return () => actionRequests.delete(handler);
    },
    unmount(): void {
      mounted.instance?.unmount(); // ink restores the terminal
    },
  };
  return handle;
}
