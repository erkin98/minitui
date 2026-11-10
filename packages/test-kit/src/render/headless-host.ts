import type { ActionDispatcher, ActionOutcome, DispatchContext } from '@minitui/renderer-core';
import { mountInk, type MountInkArgs } from '@minitui/renderer-ink';
import { toWireSpec, type MiniAppSpec } from '@minitui/spec';
import {
  JsonObjectSchema,
  type DiagnosticsPort,
  type ExecEvent,
  type PermissionRequest,
  type RuntimeFault,
} from '@minitui/types';
import type { MockPermissionEngine } from '../tools/mock-permission-engine.js';
import type { MockToolRegistry, ToolOutcome } from '../tools/mock-tool-registry.js';
import { createTestConsentController } from '../tools/test-consent-controller.js';
import { FakeStdin, FakeStdout, asReadStream, asWriteStream } from './fake-streams.js';
import { keyBytes } from './keys.js';
import { waitFor } from './wait.js';

type HeadlessStore = MountInkArgs['store'];
type StatusPointers = { readonly progress: string; readonly status: string };

/** A status line longer than this is cut, as the cli cuts it: one stderr line can be very long. */
const STATUS_CAP = 1_000;

// The three callbacks MountInkArgs['store'] is: mountInk wraps them with the adopted store adapter, which
// does the pointer work, so this holds a snapshot and notifies.
function headlessStateStore(initial: Record<string, unknown>): HeadlessStore {
  let state: Record<string, unknown> = { ...initial };
  const listeners = new Set<() => void>();
  return {
    getSnapshot: () => state,
    setSnapshot: (next: Record<string, unknown>) => {
      state = next;
      for (const listener of listeners) listener();
    },
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}

// With no permission double nothing can ask, and this inert controller is what renderer-ink's own mount
// tests use.
const noopConsent: MountInkArgs['consent'] = {
  request: undefined,
  subscribe: () => () => {},
  resolve: () => {},
};

// The flush after a key: a microtask and one timer turn. waitFor covers focus and mount effects.
async function flush(): Promise<void> {
  await Promise.resolve();
  await new Promise((resolve) => setTimeout(resolve, 0));
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

// A new object with `value` at the JSON Pointer; missing parents become empty objects.
function setAtPointer(
  root: Record<string, unknown>,
  pointer: string,
  value: unknown,
): Record<string, unknown> {
  const tokens = pointer
    .split('/')
    .slice(1)
    .map((t) => t.replaceAll('~1', '/').replaceAll('~0', '~'));
  const write = (node: Record<string, unknown>, at: number): Record<string, unknown> => {
    const key = tokens[at];
    if (key === undefined) return node;
    if (at === tokens.length - 1) return { ...node, [key]: value };
    const child = node[key];
    return { ...node, [key]: write(isRecord(child) ? child : {}, at + 1) };
  };
  return write(root, 0);
}

/**
 * The headless twin of the cli's exec-event bridge: each event of an action becomes one write at the
 * pointers the catalog names for that action (progress, then the status line). An action with no
 * pointers writes nothing.
 */
export function bridgeExecEventToStore(
  store: HeadlessStore,
  pointersOf: (actionName: string) => StatusPointers | undefined,
): (ev: ExecEvent, actionName: string) => void {
  return (ev, actionName) => {
    const pointers = pointersOf(actionName);
    if (pointers === undefined) return;
    const write = (pointer: string, value: unknown): void =>
      store.setSnapshot(setAtPointer(store.getSnapshot(), pointer, value));
    if (ev.kind === 'progress') write(pointers.progress, ev.value);
    else if (ev.kind === 'exit')
      write(pointers.status, ev.code === 0 ? 'done' : `failed (exit ${ev.code})`);
    else if (ev.kind === 'stderr') write(pointers.status, ev.chunk.slice(0, STATUS_CAP));
  };
}

// A drained tool outcome as an ActionOutcome; a failure carries the canonical runtime fault.
function toOutcome(actionName: string, last: ToolOutcome | undefined): ActionOutcome {
  if (last === undefined) return { status: 'settled' };
  if (last.exitCode === 0) return { status: 'settled', result: last };
  const fault: RuntimeFault = {
    actionKey: actionName,
    exitCode: last.exitCode,
    stderrExcerpt: last.stderr ?? '',
  };
  return { status: 'failed', fault };
}

/**
 * A test double of the host's action router: render-local passes through, every other action asks the
 * permission double first (a deny never reaches the tool), then the scripted tool runs to its end. Its
 * progress, stderr and exit go to the dispatch's own event callback and to the store sink.
 */
export function createMockDispatcher(args: {
  readonly permission?: MockPermissionEngine | undefined;
  readonly tools?: MockToolRegistry | undefined;
  readonly storeSink?: ((ev: ExecEvent, actionName: string) => void) | undefined;
}): ActionDispatcher & { outcomes(): readonly ActionOutcome[] } {
  let recorded: readonly ActionOutcome[] = [];
  let made = 0;
  const record = (outcome: ActionOutcome): ActionOutcome => {
    recorded = [...recorded, outcome];
    return outcome;
  };
  return {
    async dispatch(actionName: string, ctx: DispatchContext): Promise<ActionOutcome> {
      if (ctx.actionKind !== 'render-local' && args.permission !== undefined) {
        made += 1;
        const request: PermissionRequest = {
          id: `request-${made}`,
          descriptor: ctx.permission ?? {
            danger: true,
            resourceTemplate: actionName,
            summaryTemplate: actionName,
          },
          resolvedCommand: actionName,
          resolvedPaths: [],
        };
        const decision = await args.permission.check(request);
        if (decision.kind === 'deny') return record({ status: 'denied', reason: decision.reason });
      }
      const emit = (ev: ExecEvent): void => {
        ctx.onEvent?.(ev);
        args.storeSink?.(ev, actionName);
      };
      let last: ToolOutcome | undefined;
      if (args.tools?.has(actionName) === true) {
        for await (const ev of args.tools.run(actionName, ctx.resolvedParams)) {
          if (ev.phase === 'progress')
            emit({ kind: 'progress', value: ev.progress, message: ev.message });
          if (ev.phase === 'result' || ev.phase === 'error') last = ev.outcome;
        }
        if (last?.stderr !== undefined) emit({ kind: 'stderr', chunk: last.stderr });
        if (last !== undefined) emit({ kind: 'exit', code: last.exitCode });
      }
      return record(toOutcome(actionName, last));
    },
    outcomes: () => recorded,
  };
}

export interface HeadlessHost {
  frame(): string;
  frames(): readonly string[];
  press(key: string): Promise<void>;
  /** Flush a key-driven dispatch, which press() does not wait for. */
  settle(): Promise<void>;
  waitFor(cond: () => boolean, what: string): Promise<void>;
  dispatch(actionName: string, ctx?: Partial<DispatchContext>): Promise<ActionOutcome>;
  outcomes(): readonly ActionOutcome[];
  unmount(): void;
}

/**
 * The spec, rendered by the real mountInk (the production binder and sanitizer) into fake streams, with
 * the mock dispatcher behind its actions and no real terminal. With a permission double, consent goes
 * through the real overlay and an ask waits until the overlay is answered.
 */
export async function mountHeadless(args: {
  readonly spec: MiniAppSpec;
  readonly catalog: MountInkArgs['catalog'];
  readonly binding: MountInkArgs['binding'];
  readonly permission?: MockPermissionEngine | undefined;
  readonly tools?: MockToolRegistry | undefined;
  readonly accessible?: boolean | undefined;
  readonly onQuit?: (() => void) | undefined;
  readonly onCancel?: (() => void) | undefined;
  readonly diagnostics?: DiagnosticsPort | undefined;
}): Promise<HeadlessHost> {
  const stdout = new FakeStdout();
  const stderr = new FakeStdout();
  const stdin = new FakeStdin();
  const store = headlessStateStore(args.spec.state);
  const dispatcher = createMockDispatcher({
    permission: args.permission,
    tools: args.tools,
    storeSink: bridgeExecEventToStore(
      store,
      (name) => args.catalog.actionDefs.get(name)?.statusPointers,
    ),
  });
  const handle = mountInk({
    spec: toWireSpec(args.spec),
    catalog: args.catalog,
    binding: args.binding,
    dispatcher,
    store,
    consent:
      args.permission !== undefined ? createTestConsentController(args.permission) : noopConsent,
    accessible: args.accessible,
    onQuit: args.onQuit,
    onCancel: args.onCancel,
    diagnostics: args.diagnostics,
    io: {
      stdout: asWriteStream(stdout),
      stderr: asWriteStream(stderr),
      stdin: asReadStream(stdin),
      debug: true,
    },
  });
  await waitFor(() => stdout.frames.length > 0, 'the first frame');

  return {
    frame: () => stdout.frames.at(-1) ?? '',
    frames: () => [...stdout.frames],
    async press(key) {
      stdin.write(keyBytes(key));
      await flush();
    },
    async dispatch(actionName, ctx) {
      const full: DispatchContext = {
        actionName,
        actionKind: 'exec-local',
        resolvedParams: {},
        stateSnapshot: JsonObjectSchema.parse(store.getSnapshot()),
        elementKey: actionName,
        ...ctx,
      };
      const outcome = await dispatcher.dispatch(full.actionName, full);
      await flush();
      return outcome;
    },
    settle: flush,
    waitFor,
    outcomes: () => dispatcher.outcomes(),
    unmount: () => handle.unmount(),
  };
}
