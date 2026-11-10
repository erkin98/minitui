import { videoMergeCatalog } from '@minitui/catalog';
import type {
  ActionDispatcher,
  DispatchContext,
  RenderHandle,
  RendererPort,
} from '@minitui/renderer-core';
import { RENDER_LOCAL_ALLOWLIST, createInkBinding } from '@minitui/renderer-ink';
import { createAppHost, type HostSession } from '@minitui/runtime-host';
import { MERGE_SPEC } from '@minitui/test-kit';
import { createDataStore } from '@minitui/transport';
import type { ActionKind, JsonValue } from '@minitui/types';
import { describe, expect, it } from 'vitest';

// The host cannot import renderer-ink, so it keeps its own list of the actions a renderer runs locally.
// These rows keep the two lists equal: every name the renderer runs locally must write state through
// the host, and a name outside the host's list is refused even when the catalog calls it local.

// A renderer that draws nothing and keeps the dispatcher the host hands it, so a row can raise an
// action exactly as a widget would.
function capturingRenderer(): { renderer: RendererPort; dispatcher: () => ActionDispatcher } {
  let captured: ActionDispatcher | undefined;
  const handle: RenderHandle = {
    update: () => undefined,
    applyStatePatch: () => undefined,
    onAction: () => () => undefined,
    unmount: () => undefined,
  };
  return {
    renderer: {
      mount: (args) => {
        captured = args.dispatcher;
        return Promise.resolve(handle);
      },
    },
    dispatcher: () => {
      if (captured === undefined) throw new Error('the host never mounted the renderer');
      return captured;
    },
  };
}

// The exec side is never reached by a local action; a call here fails the row.
const noExec: ActionDispatcher = {
  dispatch: (name) => Promise.reject(new Error(`a local action reached exec: ${name}`)),
};

async function mountHost(kindOf: (name: string) => ActionKind | undefined): Promise<{
  session: HostSession;
  dispatch: (
    name: string,
    params: Record<string, unknown>,
  ) => ReturnType<ActionDispatcher['dispatch']>;
}> {
  const { renderer, dispatcher } = capturingRenderer();
  const host = createAppHost({
    renderer,
    binding: createInkBinding(videoMergeCatalog),
    dispatcher: noExec,
    store: createDataStore(),
    checkParams: () => false,
    callableFromOf: (name) => videoMergeCatalog.callableFromOf(name),
    kindOf,
    permissionOf: (name) => videoMergeCatalog.permissionOf(name),
  });
  const session = await host.mount(MERGE_SPEC);
  const dispatch = (name: string, params: Record<string, unknown>) => {
    const ctx: DispatchContext = {
      actionName: name,
      actionKind: 'render-local',
      resolvedParams: params,
      stateSnapshot: session.state.getState(),
      elementKey: 'parity',
    };
    return dispatcher().dispatch(name, ctx);
  };
  return { session, dispatch };
}

// One call per name on the renderer's list, and what it must leave in the state. A name the renderer
// adds without a case here fails the row, so the lists cannot drift apart unnoticed.
const CASES: Readonly<
  Record<string, { params: Record<string, unknown>; expected: Record<string, JsonValue> }>
> = {
  setState: { params: { statePath: '/note', value: 'kept' }, expected: { note: 'kept' } },
  pushState: {
    params: { statePath: '/inputs', value: '/videos/c.mp4' },
    expected: { inputs: ['/videos/a.mp4', '/videos/b.mp4', '/videos/c.mp4'] },
  },
  removeState: {
    params: { statePath: '/inputs', index: 0 },
    expected: { inputs: ['/videos/b.mp4'] },
  },
};

describe('the render-local lists of the renderer and the host', () => {
  it('the renderer runs exactly the state trio locally', () => {
    expect([...RENDER_LOCAL_ALLOWLIST].sort()).toEqual(['pushState', 'removeState', 'setState']);
  });

  it.each([...RENDER_LOCAL_ALLOWLIST])(
    '%s, run as a widget would, writes the state through the host',
    async (name) => {
      const entry = CASES[name];
      if (entry === undefined) throw new Error(`no case for the renderer's local action ${name}`);
      const { session, dispatch } = await mountHost((action) => videoMergeCatalog.kindOf(action));
      expect(videoMergeCatalog.kindOf(name)).toBe('render-local');
      expect(await dispatch(name, entry.params)).toEqual({ status: 'settled' });
      expect(session.state.getState()).toMatchObject(entry.expected);
      session.dispose();
    },
  );

  it.each(['log', 'exit'])(
    '%s is refused by the host list even when the catalog calls it local',
    async (name) => {
      const { session, dispatch } = await mountHost((action) =>
        action === name ? 'render-local' : videoMergeCatalog.kindOf(action),
      );
      const before = session.state.getState();
      const outcome = await dispatch(name, { statePath: '/note', value: 'x' });
      expect(outcome.status).toBe('denied');
      expect(outcome.status === 'denied' ? outcome.reason : '').toMatch(/state allowlist/);
      expect(session.state.getState()).toEqual(before);
      session.dispose();
    },
  );
});
