import { describe, it, expect } from 'vitest';
import { createDataStore } from '@minitui/transport';
import type { MiniAppSpec } from '@minitui/spec';
import type {
  ActionDispatcher,
  ActionOutcome,
  DispatchContext,
  RenderHandle,
  RendererPort,
} from '@minitui/renderer-core';
import type {
  ActionKind,
  AppSpec,
  JsonPatch,
  PermissionDescriptor,
  RuntimeFault,
  VisibilityClass,
} from '@minitui/types';
import { createAppHost, MODEL_NOT_CALLABLE } from '../src/host.js';

const SPEC: MiniAppSpec = {
  root: 'app',
  elements: {
    app: { type: 'Box', props: {}, children: ['merge'] },
    merge: { type: 'Button', props: { label: 'Merge' } },
  },
  state: { inputs: ['a.mp4'] },
  meta: { catalogId: 'video-merge', schemaVersion: 1 },
};

const binding = { catalogId: 'video-merge', resolve: () => undefined };

const MERGE: PermissionDescriptor = {
  danger: true,
  resourceTemplate: 'ffmpeg -i ${/inputs/0}',
  summaryTemplate: 'Merge',
};

// What the composition root builds from the catalog.
const KINDS = new Map<string, ActionKind>([
  ['merge', 'exec-local'],
  ['probe', 'exec-mcp'],
  ['setState', 'render-local'],
]);
const hostChecks = {
  checkParams: (): boolean => true,
  callableFromOf: (): VisibilityClass | undefined => undefined,
  kindOf: (name: string): ActionKind | undefined => KINDS.get(name),
  permissionOf: (name: string): PermissionDescriptor | undefined =>
    name === 'merge' ? MERGE : undefined,
};

interface Call {
  readonly name: string;
  readonly ctx: DispatchContext;
}

// A scripted exec dispatcher: a real implementation of the port that records what it was given.
function scriptedExec(outcome: ActionOutcome = { status: 'settled' }) {
  const calls: Call[] = [];
  const dispatcher: ActionDispatcher = {
    dispatch: (name, ctx) => {
      calls.push({ name, ctx });
      return Promise.resolve(outcome);
    },
  };
  return { dispatcher, calls };
}

function firstOf<T>(items: readonly T[]): T {
  const first = items[0];
  if (first === undefined) throw new Error('expected at least one item');
  return first;
}

// A real capturing renderer. The host must never call the handle's own patch method: the shared store
// is the only channel, so a second apply would fold an append twice.
function fakeRenderer(
  opts: { mountThrows?: unknown; updateThrows?: unknown; onMount?: () => void } = {},
) {
  let mountArgs: Parameters<RendererPort['mount']>[0] | undefined;
  const updateSpecs: AppSpec[] = [];
  const applyStatePatchCalls: Array<readonly JsonPatch[]> = [];
  let unmountCount = 0;
  const handle: RenderHandle = {
    update: (spec) => {
      if (opts.updateThrows !== undefined) throw opts.updateThrows;
      updateSpecs.push(spec);
    },
    applyStatePatch: (patch) => {
      applyStatePatchCalls.push(patch);
    },
    onAction: () => () => {},
    unmount: () => {
      unmountCount += 1;
    },
  };
  const port: RendererPort = {
    async mount(args) {
      mountArgs = args;
      opts.onMount?.();
      if (opts.mountThrows !== undefined) throw opts.mountThrows;
      return handle;
    },
  };
  const mounted = (): Parameters<RendererPort['mount']>[0] => {
    if (mountArgs === undefined) throw new Error('the renderer was never mounted');
    return mountArgs;
  };
  return {
    port,
    mounted,
    get updateSpecs() {
      return updateSpecs;
    },
    get applyStatePatchCount() {
      return applyStatePatchCalls.length;
    },
    get unmountCount() {
      return unmountCount;
    },
  };
}

const mergeCtx = (over: Partial<DispatchContext> = {}): DispatchContext => ({
  actionName: 'merge',
  actionKind: 'exec-local',
  resolvedParams: { inputs: ['/abs/forged.mp4'] },
  stateSnapshot: {},
  elementKey: 'merge',
  ...over,
});

describe('createAppHost', () => {
  it('seeds the shared store before the renderer mounts, and hands the renderer the wire projection of the spec', async () => {
    const store = createDataStore();
    let seenAtMount: unknown;
    const r = fakeRenderer({ onMount: () => (seenAtMount = store.getState()) });
    const host = createAppHost({
      ...hostChecks,
      renderer: r.port,
      binding,
      dispatcher: scriptedExec().dispatcher,
      store,
    });
    const session = await host.mount(SPEC);

    expect(seenAtMount).toEqual({ inputs: ['a.mp4'] });
    expect(session.state.getState()).toEqual({ inputs: ['a.mp4'] });
    expect(session.getSpec()).toBe(SPEC);
    const wire = r.mounted().spec;
    expect(Object.keys(wire).sort()).toEqual(['elements', 'root']);
    expect(wire.root).toBe('app');
    expect(wire.elements).toBe(SPEC.elements);
    expect(r.mounted().binding).toBe(binding);
  });

  it('hands the renderer the host router, not the raw exec dispatcher', async () => {
    const store = createDataStore();
    const r = fakeRenderer();
    const exec = scriptedExec();
    const host = createAppHost({
      ...hostChecks,
      renderer: r.port,
      binding,
      dispatcher: exec.dispatcher,
      store,
    });
    await host.mount(SPEC);
    // exec refuses render-local; the host router settles it against the shared store.
    const out = await r.mounted().dispatcher.dispatch('setState', {
      actionName: 'setState',
      actionKind: 'render-local',
      resolvedParams: { statePath: '/codec', value: 'h265' },
      stateSnapshot: {},
      elementKey: 'c',
    });
    expect(out).toEqual({ status: 'settled' });
    expect(store.getIn('/codec')).toBe('h265');
    expect(exec.calls).toEqual([]);
  });

  it('an exec-local dispatch reaches exec with the consent values read from the live state', async () => {
    const store = createDataStore();
    const r = fakeRenderer();
    const exec = scriptedExec({ status: 'settled', result: { ran: 'merge' } });
    const host = createAppHost({
      ...hostChecks,
      renderer: r.port,
      binding,
      dispatcher: exec.dispatcher,
      store,
    });
    await host.mount(SPEC);

    const out = await r.mounted().dispatcher.dispatch('merge', mergeCtx());

    expect(out).toEqual({ status: 'settled', result: { ran: 'merge' } });
    const { name, ctx } = firstOf(exec.calls);
    expect(name).toBe('merge');
    expect(ctx.resolvedParams.inputs).toEqual(['a.mp4']);
  });

  it('a render-local write notifies through the store once and never through the renderer handle', async () => {
    const store = createDataStore();
    const r = fakeRenderer();
    const host = createAppHost({
      ...hostChecks,
      renderer: r.port,
      binding,
      dispatcher: scriptedExec().dispatcher,
      store,
    });
    const session = await host.mount({ ...SPEC, state: { codec: 'h264' } });
    let notified = 0;
    store.subscribe(() => {
      notified += 1;
    });
    await r.mounted().dispatcher.dispatch('setState', {
      actionName: 'setState',
      actionKind: 'render-local',
      resolvedParams: { statePath: '/codec', value: 'h265' },
      stateSnapshot: {},
      elementKey: 'c',
    });
    expect(session.state.getIn('/codec')).toBe('h265');
    expect(notified).toBe(1);
    expect(r.applyStatePatchCount).toBe(0);
  });

  it('applyStatePatch folds into the shared store once and never through the renderer handle', async () => {
    const store = createDataStore();
    const r = fakeRenderer();
    const host = createAppHost({
      ...hostChecks,
      renderer: r.port,
      binding,
      dispatcher: scriptedExec().dispatcher,
      store,
    });
    const session = await host.mount(SPEC);
    let notified = 0;
    store.subscribe(() => {
      notified += 1;
    });
    session.applyStatePatch([{ op: 'add', path: '/inputs/-', value: 'b.mp4' }]);
    expect(session.state.getIn('/inputs')).toEqual(['a.mp4', 'b.mp4']);
    expect(notified).toBe(1);
    expect(r.applyStatePatchCount).toBe(0);
  });
});

describe('the session lifetime', () => {
  async function mounted() {
    const store = createDataStore();
    const r = fakeRenderer();
    const host = createAppHost({
      ...hostChecks,
      renderer: r.port,
      binding,
      dispatcher: scriptedExec().dispatcher,
      store,
    });
    return { r, session: await host.mount(SPEC), store };
  }

  it('done is pending after mount', async () => {
    const { session } = await mounted();
    let settled = false;
    void session.done.then(() => {
      settled = true;
    });
    await Promise.resolve();
    expect(settled).toBe(false);
  });

  it('requestQuit settles done and the host does not unmount on its own', async () => {
    const { r, session } = await mounted();
    session.requestQuit({ status: 'completed', exitCode: 0 });
    await expect(session.done).resolves.toEqual({ status: 'completed', exitCode: 0 });
    expect(r.unmountCount).toBe(0);
  });

  it('requestQuit is first-wins', async () => {
    const { session } = await mounted();
    session.requestQuit({ status: 'completed', exitCode: 0 });
    session.requestQuit({ status: 'failed', exitCode: 1 });
    await expect(session.done).resolves.toEqual({ status: 'completed', exitCode: 0 });
  });

  it('the q key callback settles done as completed with exit 0', async () => {
    const { r, session } = await mounted();
    const onQuit = r.mounted().onQuit;
    expect(onQuit).toBeTypeOf('function');
    onQuit?.();
    await expect(session.done).resolves.toEqual({ status: 'completed', exitCode: 0 });
  });

  it('the Esc key callback settles done as cancelled with exit 130', async () => {
    const { r, session } = await mounted();
    const onCancel = r.mounted().onCancel;
    expect(onCancel).toBeTypeOf('function');
    onCancel?.();
    await expect(session.done).resolves.toEqual({ status: 'cancelled', exitCode: 130 });
  });

  it('dispose unmounts and settles a pending done to cancelled with exit 130', async () => {
    const { r, session } = await mounted();
    session.dispose();
    await expect(session.done).resolves.toEqual({ status: 'cancelled', exitCode: 130 });
    expect(r.unmountCount).toBe(1);
  });
});

describe('faults and refusals', () => {
  it('routes a failed gated action to observeFault and still returns it', async () => {
    const store = createDataStore();
    const r = fakeRenderer();
    const fault: RuntimeFault = {
      actionKey: 'merge',
      exitCode: 1,
      stderrExcerpt: 'codec not found',
    };
    const seen: RuntimeFault[] = [];
    const host = createAppHost({
      ...hostChecks,
      renderer: r.port,
      binding,
      dispatcher: scriptedExec({ status: 'failed', fault }).dispatcher,
      store,
      observeFault: (f) => {
        seen.push(f);
      },
    });
    await host.mount(SPEC);
    const out = await r.mounted().dispatcher.dispatch('merge', mergeCtx());
    expect(out.status).toBe('failed');
    expect(seen).toEqual([fault]);
  });

  it('reports a gated refusal to observeDenied', async () => {
    const store = createDataStore();
    const r = fakeRenderer();
    const seen: Array<{ actionKey: string; reason: string }> = [];
    const host = createAppHost({
      ...hostChecks,
      renderer: r.port,
      binding,
      dispatcher: scriptedExec({ status: 'denied', reason: 'nope' }).dispatcher,
      store,
      observeDenied: (d) => {
        seen.push(d);
      },
    });
    await host.mount(SPEC);
    await r.mounted().dispatcher.dispatch('merge', mergeCtx());
    expect(seen).toEqual([{ actionKey: 'merge', reason: 'nope' }]);
  });

  it('refuses a model call to an action that is not remoteOnly, and exec never runs', async () => {
    const exec = scriptedExec();
    const host = createAppHost({
      ...hostChecks,
      callableFromOf: () => 'clientOnly',
      renderer: fakeRenderer().port,
      binding,
      dispatcher: exec.dispatcher,
      store: createDataStore(),
    });
    const out = await host.dispatchFromModel('merge', mergeCtx({ resolvedParams: {} }));
    expect(out).toEqual({ status: 'denied', reason: MODEL_NOT_CALLABLE });
    expect(exec.calls).toEqual([]);
  });

  it('routes a model call to a remoteOnly action through the host router, which still checks the catalog', async () => {
    const exec = scriptedExec();
    const host = createAppHost({
      ...hostChecks,
      callableFromOf: () => 'remoteOnly',
      renderer: fakeRenderer().port,
      binding,
      dispatcher: exec.dispatcher,
      store: createDataStore(),
    });
    const out = await host.dispatchFromModel('probe', {
      actionName: 'probe',
      actionKind: 'exec-mcp',
      resolvedParams: { q: 'x' },
      stateSnapshot: {},
      elementKey: '',
    });
    expect(out).toEqual({ status: 'settled' });
    expect(exec.calls.map((c) => c.name)).toEqual(['probe']);
    const mismatch = await host.dispatchFromModel('probe', {
      actionName: 'probe',
      actionKind: 'agent-callback',
      resolvedParams: {},
      stateSnapshot: {},
      elementKey: '',
    });
    expect(mismatch.status).toBe('denied');
    expect(exec.calls).toHaveLength(1);
  });
});

describe('updateSpec and the renderer boundary', () => {
  const REPAIRED: MiniAppSpec = {
    root: 'app',
    elements: {
      app: { type: 'Box', props: {}, children: ['status'] },
      status: { type: 'Text', props: { text: 'retrying' } },
    },
    state: { inputs: ['a.mp4'], merge: { status: 'retry' } },
    meta: { catalogId: 'video-merge', schemaVersion: 1 },
  };

  it('re-renders a re-validated spec, re-seeds the state and getSpec reflects it', async () => {
    const store = createDataStore();
    const r = fakeRenderer();
    const host = createAppHost({
      ...hostChecks,
      renderer: r.port,
      binding,
      dispatcher: scriptedExec().dispatcher,
      store,
    });
    const session = await host.mount(SPEC);
    session.updateSpec(REPAIRED);
    const sent = firstOf(r.updateSpecs);
    expect(Object.keys(sent).sort()).toEqual(['elements', 'root']);
    expect(sent.elements).toBe(REPAIRED.elements);
    expect(session.getSpec()).toBe(REPAIRED);
    expect(store.getIn('/merge/status')).toBe('retry');
  });

  it('catches an off-catalog throw from update, routes a fault and rolls the spec and the state back', async () => {
    const store = createDataStore();
    const r = fakeRenderer({ updateThrows: new Error('off-catalog component: EvilWidget') });
    const seen: RuntimeFault[] = [];
    const host = createAppHost({
      ...hostChecks,
      renderer: r.port,
      binding,
      dispatcher: scriptedExec().dispatcher,
      store,
      observeFault: (f) => {
        seen.push(f);
      },
    });
    const session = await host.mount(SPEC);
    const REJECTED: MiniAppSpec = { ...REPAIRED, state: { inputs: ['a.mp4'], evil: true } };
    expect(() => session.updateSpec(REJECTED)).not.toThrow();
    expect(firstOf(seen).stderrExcerpt).toContain('off-catalog');
    expect(session.getSpec()).toBe(SPEC);
    expect(store.getState()).toEqual({ inputs: ['a.mp4'] });
  });

  it('a state that cannot be seeded leaves the previous spec in place and routes a fault', async () => {
    const store = createDataStore();
    const r = fakeRenderer();
    const seen: RuntimeFault[] = [];
    const host = createAppHost({
      ...hostChecks,
      renderer: r.port,
      binding,
      dispatcher: scriptedExec().dispatcher,
      store,
      observeFault: (f) => {
        seen.push(f);
      },
    });
    const session = await host.mount(SPEC);
    const BAD: MiniAppSpec = { ...REPAIRED, state: { f: () => 1 } };
    expect(() => session.updateSpec(BAD)).not.toThrow();
    expect(seen).toHaveLength(1);
    expect(session.getSpec()).toBe(SPEC);
    expect(r.updateSpecs).toEqual([]);
    expect(store.getState()).toEqual({ inputs: ['a.mp4'] });
  });

  it('sends a coded off-catalog refusal to the repair path', async () => {
    const refusal = Object.assign(new Error('off-catalog component: EvilWidget'), {
      code: 'off-catalog',
    });
    const seen: RuntimeFault[] = [];
    const host = createAppHost({
      ...hostChecks,
      renderer: fakeRenderer({ updateThrows: refusal }).port,
      binding,
      dispatcher: scriptedExec().dispatcher,
      store: createDataStore(),
      observeFault: (f) => {
        seen.push(f);
      },
    });
    const session = await host.mount(SPEC);
    expect(() => session.updateSpec(SPEC)).not.toThrow();
    expect(seen).toHaveLength(1);
  });

  it('rethrows a builder refusal from update after the rollback, with no fault', async () => {
    const refusal = Object.assign(new Error('unbound component'), { code: 'unbound-component' });
    const seen: RuntimeFault[] = [];
    const store = createDataStore();
    const host = createAppHost({
      ...hostChecks,
      renderer: fakeRenderer({ updateThrows: refusal }).port,
      binding,
      dispatcher: scriptedExec().dispatcher,
      store,
      observeFault: (f) => {
        seen.push(f);
      },
    });
    const session = await host.mount(SPEC);
    expect(() => session.updateSpec(REPAIRED)).toThrow('unbound component');
    expect(seen).toEqual([]);
    expect(session.getSpec()).toBe(SPEC);
    expect(store.getState()).toEqual({ inputs: ['a.mp4'] });
  });

  it('mount: an off-catalog throw is routed as a fault, mount rejects and the store goes back to what it was', async () => {
    const store = createDataStore({ initial: { before: true } });
    const seen: RuntimeFault[] = [];
    const host = createAppHost({
      ...hostChecks,
      renderer: fakeRenderer({ mountThrows: new Error('off-catalog component: EvilWidget') }).port,
      binding,
      dispatcher: scriptedExec().dispatcher,
      store,
      observeFault: (f) => {
        seen.push(f);
      },
    });
    await expect(host.mount(SPEC)).rejects.toThrow(/off-catalog/);
    expect(firstOf(seen).stderrExcerpt).toContain('off-catalog');
    expect(store.getState()).toEqual({ before: true });
  });

  it('mount: a builder refusal is rethrown with no fault', async () => {
    const refusal = Object.assign(new Error('initial state'), {
      code: 'initial-state-unsupported',
    });
    const seen: RuntimeFault[] = [];
    const host = createAppHost({
      ...hostChecks,
      renderer: fakeRenderer({ mountThrows: refusal }).port,
      binding,
      dispatcher: scriptedExec().dispatcher,
      store: createDataStore(),
      observeFault: (f) => {
        seen.push(f);
      },
    });
    await expect(host.mount(SPEC)).rejects.toThrow('initial state');
    expect(seen).toEqual([]);
  });
});
