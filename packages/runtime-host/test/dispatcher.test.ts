import { describe, it, expect } from 'vitest';
import { createDataStore } from '@minitui/transport';
import type { ActionDispatcher, ActionOutcome, DispatchContext } from '@minitui/renderer-core';
import type {
  ActionKind,
  ExecEvent,
  JsonValue,
  PermissionDescriptor,
  RuntimeFault,
} from '@minitui/types';
import { createHostState } from '../src/state.js';
import {
  createActionRouter,
  CONTEXT_MISMATCH,
  HOLE_NOT_A_POINTER,
  NO_LIVE_VALUE,
  PARAMS_REFUSED,
  UNKNOWN_ACTION,
} from '../src/dispatcher.js';

// The catalog is not importable from this package, so its action table is stood in for by literals.
// The merge templates are copied from the video-merge catalog.
const MERGE: PermissionDescriptor = {
  danger: true,
  resourceTemplate: 'ffmpeg -i ${/inputs/0} -i ${/inputs/1} -c:v ${/codec} ${/output}',
  summaryTemplate: 'Merge the selected videos into ${/output} using ${/codec}',
};
// One root only in the resource template, another only in the headline.
const NOTIFY: PermissionDescriptor = {
  danger: false,
  resourceTemplate: 'notify ${/target}',
  summaryTemplate: 'Send to ${/audience}',
};

interface Entry {
  readonly kind: ActionKind;
  readonly permission?: PermissionDescriptor;
}
const BASE_ACTIONS: ReadonlyMap<string, Entry> = new Map<string, Entry>([
  ['merge', { kind: 'exec-local', permission: MERGE }],
  ['notify', { kind: 'agent-callback', permission: NOTIFY }],
  ['setState', { kind: 'render-local' }],
  ['pushState', { kind: 'render-local' }],
  ['removeState', { kind: 'render-local' }],
  ['log', { kind: 'render-local' }],
]);

const LIVE: JsonValue = {
  inputs: ['/live/a.mp4', '/live/b.mp4'],
  codec: 'h264',
  output: '/live/out.mp4',
  target: '/live/target',
  audience: 'live-audience',
};

interface Call {
  readonly name: string;
  readonly ctx: DispatchContext;
}

function mkRouter(
  opts: {
    live?: JsonValue;
    actions?: ReadonlyMap<string, Entry>;
    outcome?: ActionOutcome;
    checkParams?: (name: string, params: Readonly<Record<string, unknown>>) => boolean;
  } = {},
) {
  const store = createDataStore({ initial: opts.live ?? LIVE });
  const state = createHostState(store);
  const actions = opts.actions ?? BASE_ACTIONS;
  const calls: Call[] = [];
  const checked: Array<Readonly<Record<string, unknown>>> = [];
  const faults: RuntimeFault[] = [];
  const denials: Array<{ readonly actionKey: string; readonly reason: string }> = [];
  const exec: ActionDispatcher = {
    dispatch: async (name, ctx) => {
      calls.push({ name, ctx });
      return opts.outcome ?? { status: 'settled' };
    },
  };
  const router = createActionRouter({
    state,
    exec,
    kindOf: (name) => actions.get(name)?.kind,
    permissionOf: (name) => actions.get(name)?.permission,
    checkParams: (name, params) => {
      checked.push(params);
      return opts.checkParams?.(name, params) ?? true;
    },
    observeFault: (fault) => faults.push(fault),
    observeDenied: (denial) => denials.push(denial),
  });
  return { router, store, state, calls, checked, faults, denials };
}

function only(calls: readonly Call[]): Call {
  const first = calls[0];
  if (first === undefined || calls.length !== 1) {
    throw new Error(`expected exactly one call to exec, got ${calls.length}`);
  }
  return first;
}

const mergeCtx = (over: Partial<DispatchContext> = {}): DispatchContext => ({
  actionName: 'merge',
  actionKind: 'exec-local',
  permission: MERGE,
  resolvedParams: {
    inputs: ['/stale/a.mp4', '/stale/b.mp4'],
    codec: 'copy',
    output: '/stale/out.mp4',
  },
  stateSnapshot: { stale: true },
  elementKey: 'merge-button',
  ...over,
});

const localCtx = (
  actionName: string,
  resolvedParams: Record<string, unknown>,
): DispatchContext => ({
  actionName,
  actionKind: 'render-local',
  resolvedParams,
  stateSnapshot: {},
  elementKey: 'widget',
});

describe('render-local: the STATE trio against the shared store', () => {
  it('setState writes the pointer and settles without touching exec', async () => {
    const t = mkRouter();
    const out = await t.router.dispatch(
      'setState',
      localCtx('setState', { statePath: '/codec', value: 'h265' }),
    );
    expect(out).toEqual({ status: 'settled' });
    expect(t.state.getIn('/codec')).toBe('h265');
    expect(t.calls).toEqual([]);
  });

  it('pushState with an empty clear path appends and clears nothing, as json-render does', async () => {
    const t = mkRouter({ live: { inputs: ['a'], draft: 'b' } });
    const out = await t.router.dispatch(
      'pushState',
      localCtx('pushState', { statePath: '/inputs', value: 'b', clearStatePath: '' }),
    );
    expect(out).toEqual({ status: 'settled' });
    expect(t.state.getState()).toEqual({ inputs: ['a', 'b'], draft: 'b' });
  });

  it('pushState appends and clears the clear pointer in the same action', async () => {
    const t = mkRouter({ live: { inputs: ['a'], draft: 'b' } });
    const out = await t.router.dispatch(
      'pushState',
      localCtx('pushState', { statePath: '/inputs', value: 'b', clearStatePath: '/draft' }),
    );
    expect(out).toEqual({ status: 'settled' });
    expect(t.state.getState()).toEqual({ inputs: ['a', 'b'], draft: '' });
  });

  it('removeState removes by index', async () => {
    const t = mkRouter({ live: { inputs: ['a', 'b', 'c'] } });
    await t.router.dispatch(
      'removeState',
      localCtx('removeState', { statePath: '/inputs', index: 1 }),
    );
    expect(t.state.getIn('/inputs')).toEqual(['a', 'c']);
  });

  const BAD: ReadonlyArray<readonly [string, string, Record<string, unknown>]> = [
    ['setState without a value', 'setState', { statePath: '/codec' }],
    ['setState with a value that is not JSON', 'setState', { statePath: '/codec', value: () => 1 }],
    ['setState on the empty pointer (the whole document)', 'setState', { statePath: '', value: 5 }],
    ['setState on a path that is not a pointer', 'setState', { statePath: 'codec', value: 1 }],
    ['setState on a pointer with a bad escape', 'setState', { statePath: '/a~2', value: 1 }],
    [
      'pushState with a clear path that is not a pointer',
      'pushState',
      { statePath: '/inputs', value: 'x', clearStatePath: 'draft' },
    ],
    ['removeState with a negative index', 'removeState', { statePath: '/inputs', index: -1 }],
    [
      'removeState with an index that is not an integer',
      'removeState',
      { statePath: '/inputs', index: 0.5 },
    ],
    ['removeState without an index', 'removeState', { statePath: '/inputs' }],
    ['a render-local action outside the STATE trio', 'log', { statePath: '/codec', value: 'x' }],
  ];
  it.each(BAD)('denies %s and writes nothing', async (_what, name, params) => {
    const t = mkRouter({ live: { inputs: ['a'], codec: 'h264' } });
    const before = t.state.getState();
    const out = await t.router.dispatch(name, localCtx(name, params));
    expect(out.status).toBe('denied');
    expect(t.state.getState()).toBe(before);
    expect(t.calls).toEqual([]);
  });
});

describe('the context must match the catalog', () => {
  it('denies an action the catalog does not know and never reaches exec', async () => {
    const t = mkRouter();
    const out = await t.router.dispatch('rm-rf', mergeCtx({ actionName: 'rm-rf' }));
    expect(out).toEqual({ status: 'denied', reason: UNKNOWN_ACTION });
    expect(t.calls).toEqual([]);
    expect(t.denials).toEqual([{ actionKey: 'rm-rf', reason: UNKNOWN_ACTION }]);
  });

  it('denies a context whose kind differs from the catalog: a gated action labelled render-local writes nothing', async () => {
    const t = mkRouter();
    const before = t.state.getState();
    const out = await t.router.dispatch(
      'merge',
      mergeCtx({
        actionKind: 'render-local',
        resolvedParams: { statePath: '/codec', value: 'evil' },
      }),
    );
    expect(out).toEqual({ status: 'denied', reason: CONTEXT_MISMATCH });
    expect(t.state.getState()).toBe(before);
    expect(t.calls).toEqual([]);
  });

  it('denies a gated action labelled with another gated kind', async () => {
    const t = mkRouter();
    const out = await t.router.dispatch('merge', mergeCtx({ actionKind: 'agent-callback' }));
    expect(out).toEqual({ status: 'denied', reason: CONTEXT_MISMATCH });
    expect(t.calls).toEqual([]);
  });

  it('denies a context whose action name differs from the dispatched name', async () => {
    const t = mkRouter();
    const out = await t.router.dispatch('notify', mergeCtx({ actionKind: 'agent-callback' }));
    expect(out).toEqual({ status: 'denied', reason: CONTEXT_MISMATCH });
    expect(t.calls).toEqual([]);
  });

  it('dispatches the catalog descriptor, never the one the renderer sent', async () => {
    const t = mkRouter();
    const fake: PermissionDescriptor = {
      danger: false,
      resourceTemplate: 'ffmpeg',
      summaryTemplate: 'Preview only, nothing is written',
    };
    await t.router.dispatch('merge', mergeCtx({ permission: fake }));
    const { ctx } = only(t.calls);
    expect(ctx.permission).toBe(MERGE);
    expect(ctx.resolvedParams).toEqual({
      inputs: ['/live/a.mp4', '/live/b.mp4'],
      codec: 'h264',
      output: '/live/out.mp4',
    });
  });

  it('a renderer that sends no descriptor at all still gets the catalog one', async () => {
    const t = mkRouter();
    const { permission: _dropped, ...bare } = mergeCtx();
    await t.router.dispatch('merge', bare);
    expect(only(t.calls).ctx.permission).toBe(MERGE);
  });
});

describe('host-resolved consent values', () => {
  it('replaces stale merge slots with the live ones (a guard: the merge resource template names all three)', async () => {
    const t = mkRouter();
    await t.router.dispatch('merge', mergeCtx());
    const { name, ctx } = only(t.calls);
    expect(name).toBe('merge');
    expect(ctx.resolvedParams.inputs).toEqual(['/live/a.mp4', '/live/b.mp4']);
    expect(ctx.resolvedParams.output).toBe('/live/out.mp4');
    expect(ctx.resolvedParams.codec).toBe('h264');
  });

  it('grafts a root that only the headline template names', async () => {
    const t = mkRouter();
    await t.router.dispatch('notify', {
      actionName: 'notify',
      actionKind: 'agent-callback',
      resolvedParams: { target: '/stale/t', audience: 'stale-audience' },
      stateSnapshot: {},
      elementKey: 'k',
    });
    expect(only(t.calls).ctx.resolvedParams).toEqual({
      target: '/live/target',
      audience: 'live-audience',
    });
  });

  it('adds a root the renderer left out', async () => {
    const t = mkRouter();
    await t.router.dispatch('merge', mergeCtx({ resolvedParams: { codec: 'copy' } }));
    expect(only(t.calls).ctx.resolvedParams.output).toBe('/live/out.mp4');
  });

  it('leaves a key that no template names as the renderer sent it (mode is not in the consent text)', async () => {
    const t = mkRouter();
    await t.router.dispatch(
      'merge',
      mergeCtx({
        resolvedParams: { inputs: ['x'], codec: 'copy', output: '/x', mode: 'filter-concat' },
      }),
    );
    expect(only(t.calls).ctx.resolvedParams.mode).toBe('filter-concat');
  });

  it('refreshes the state snapshot from the live document', async () => {
    const t = mkRouter();
    await t.router.dispatch('merge', mergeCtx());
    expect(only(t.calls).ctx.stateSnapshot).toBe(t.store.getState());
  });

  it('keeps the progress callback the renderer attached', async () => {
    const t = mkRouter();
    const seen: ExecEvent[] = [];
    const onEvent = (ev: ExecEvent): void => {
      seen.push(ev);
    };
    await t.router.dispatch('merge', mergeCtx({ onEvent }));
    // Calling the forwarded callback must reach the renderer's own function.
    only(t.calls).ctx.onEvent?.({ kind: 'progress', value: 0.5 });
    expect(seen).toEqual([{ kind: 'progress', value: 0.5 }]);
  });

  it('does not change the context it was given', async () => {
    const t = mkRouter();
    const ctx = Object.freeze(
      mergeCtx({
        resolvedParams: Object.freeze({
          inputs: Object.freeze(['/stale/a.mp4']),
          codec: 'copy',
          output: '/stale/o',
        }),
      }),
    );
    await t.router.dispatch('merge', ctx);
    expect(ctx.resolvedParams.codec).toBe('copy');
    expect(only(t.calls).ctx).not.toBe(ctx);
  });

  it('denies when a hole has no live value, and exec never runs', async () => {
    const t = mkRouter({ live: { codec: 'h264', output: '/live/out.mp4' } });
    const out = await t.router.dispatch('merge', mergeCtx());
    expect(out).toEqual({ status: 'denied', reason: NO_LIVE_VALUE });
    expect(t.calls).toEqual([]);
    expect(t.denials).toEqual([{ actionKey: 'merge', reason: NO_LIVE_VALUE }]);
  });

  it('reads and writes keys with escaped characters', async () => {
    const actions = new Map<string, Entry>([
      [
        'esc',
        {
          kind: 'agent-callback',
          permission: {
            danger: false,
            resourceTemplate: 'x ${/a~1b} ${/t~0x/0}',
            summaryTemplate: 's',
          },
        },
      ],
    ]);
    const t = mkRouter({ actions, live: { 'a/b': 'slash', 't~x': ['tilde'] } });
    await t.router.dispatch('esc', { ...localCtx('esc', {}), actionKind: 'agent-callback' });
    expect(only(t.calls).ctx.resolvedParams).toEqual({ 'a/b': 'slash', 't~x': ['tilde'] });
  });

  it('grafts a hole whose first segment is empty from the key named by the empty string', async () => {
    const actions = new Map<string, Entry>([
      [
        'empty',
        {
          kind: 'agent-callback',
          permission: { danger: false, resourceTemplate: 'x ${/}', summaryTemplate: 's' },
        },
      ],
    ]);
    const t = mkRouter({ actions, live: { '': 'under-the-empty-key' } });
    await t.router.dispatch('empty', {
      ...localCtx('empty', { '': 'renderer-text' }),
      actionKind: 'agent-callback',
    });
    expect(only(t.calls).ctx.resolvedParams['']).toBe('under-the-empty-key');
  });

  it('denies the empty-segment hole when the document has no such key', async () => {
    const actions = new Map<string, Entry>([
      [
        'empty',
        {
          kind: 'agent-callback',
          permission: { danger: false, resourceTemplate: 'x ${/}', summaryTemplate: 's' },
        },
      ],
    ]);
    const t = mkRouter({ actions, live: { a: 1 } });
    const out = await t.router.dispatch('empty', {
      ...localCtx('empty', { '': 'renderer-text' }),
      actionKind: 'agent-callback',
    });
    expect(out).toEqual({ status: 'denied', reason: NO_LIVE_VALUE });
    expect(t.calls).toEqual([]);
  });

  it.each(['${x/output}', '${ /output}', '${output}', '${}'])(
    'denies a hole that is not a state pointer: %s',
    async (hole) => {
      const actions = new Map<string, Entry>([
        [
          'odd',
          {
            kind: 'agent-callback',
            permission: { danger: false, resourceTemplate: `x ${hole}`, summaryTemplate: 's' },
          },
        ],
      ]);
      const t = mkRouter({ actions });
      const out = await t.router.dispatch('odd', {
        ...localCtx('odd', { output: '/x' }),
        actionKind: 'agent-callback',
      });
      expect(out).toEqual({ status: 'denied', reason: HOLE_NOT_A_POINTER });
      expect(t.calls).toEqual([]);
    },
  );

  it('denies a hole that names a reserved key', async () => {
    const actions = new Map<string, Entry>([
      [
        'proto',
        {
          kind: 'agent-callback',
          permission: { danger: false, resourceTemplate: 'x ${/__proto__}', summaryTemplate: 's' },
        },
      ],
    ]);
    const t = mkRouter({ actions });
    const out = await t.router.dispatch('proto', {
      ...localCtx('proto', {}),
      actionKind: 'agent-callback',
    });
    expect(out).toEqual({ status: 'denied', reason: NO_LIVE_VALUE });
    expect(t.calls).toEqual([]);
  });
});

describe('the action parameter check and the observers', () => {
  it('runs the check on the grafted parameters and refuses before exec', async () => {
    const t = mkRouter({ checkParams: () => false });
    const out = await t.router.dispatch('merge', mergeCtx());
    expect(out).toEqual({ status: 'denied', reason: PARAMS_REFUSED });
    expect(t.calls).toEqual([]);
    expect(t.checked).toHaveLength(1);
    expect(t.denials).toEqual([{ actionKey: 'merge', reason: PARAMS_REFUSED }]);
  });

  it('hands the check the live values, not the renderer ones', async () => {
    const t = mkRouter();
    await t.router.dispatch('merge', mergeCtx());
    const params = t.checked[0];
    expect(params?.output).toBe('/live/out.mp4');
  });

  it('reports a failed outcome once and still returns it', async () => {
    const fault: RuntimeFault = { actionKey: 'merge', exitCode: 1, stderrExcerpt: 'boom' };
    const t = mkRouter({ outcome: { status: 'failed', fault } });
    const out = await t.router.dispatch('merge', mergeCtx());
    expect(out).toEqual({ status: 'failed', fault });
    expect(t.faults).toEqual([fault]);
    expect(t.denials).toEqual([]);
  });

  it('reports an exec refusal once and still returns it', async () => {
    const t = mkRouter({ outcome: { status: 'denied', reason: 'nope' } });
    const out = await t.router.dispatch('merge', mergeCtx());
    expect(out).toEqual({ status: 'denied', reason: 'nope' });
    expect(t.denials).toEqual([{ actionKey: 'merge', reason: 'nope' }]);
    expect(t.faults).toEqual([]);
  });

  it('stays quiet on a settled outcome and on render-local', async () => {
    const t = mkRouter();
    await t.router.dispatch('merge', mergeCtx());
    await t.router.dispatch(
      'setState',
      localCtx('setState', { statePath: '/codec', value: 'h265' }),
    );
    expect(t.faults).toEqual([]);
    expect(t.denials).toEqual([]);
  });
});
