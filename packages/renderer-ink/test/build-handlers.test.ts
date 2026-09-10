import { describe, it, expect } from 'vitest';
import { buildHandlers, ELEMENT_KEY } from '../src/binder/build-handlers.js';
import type { ActionDispatcher, DispatchContext } from '@minitui/renderer-core';
import { makeCatalog } from './support/make-catalog.js';
import { z } from 'zod';

const catalog = makeCatalog({
  actions: {
    setState: {
      kind: 'render-local',
      params: z.object({ statePath: z.string(), value: z.unknown() }),
    },
    merge: {
      kind: 'exec-local',
      params: z.object({ inputs: z.array(z.string()) }),
      permission: { danger: true, resourceTemplate: 'ffmpeg', summaryTemplate: 'merge' },
    },
    log: { kind: 'render-local', params: z.object({ msg: z.string() }) },
  },
});

type Handler = (params: Record<string, unknown>) => Promise<void>;

// Index-safe lookup that fails loud: a missing handler is a test failure, not a silent skip.
function mustGet(handlers: Record<string, Handler>, name: string): Handler {
  const handler = handlers[name];
  if (handler === undefined) throw new Error(`handler "${name}" is not registered`);
  return handler;
}

function dispatcherSpy() {
  const dispatcher: ActionDispatcher = { dispatch: async () => ({ status: 'settled' as const }) };
  return dispatcher;
}

describe('buildHandlers', () => {
  it('gated + rejected entries only; allowlisted state mutators are OMITTED (native built-ins)', () => {
    const handlers = buildHandlers({
      catalog,
      dispatcher: dispatcherSpy(),
      getState: () => ({}),
      emitLifecycle: () => {},
    });
    // setState absent -> json-render ActionProvider's native store-backed built-in runs;
    // exit present (rejecting) even though the catalog does not declare it.
    expect(Object.keys(handlers).sort()).toEqual(['exit', 'log', 'merge']);
    expect(handlers.setState).toBeUndefined();
  });

  it('routes exec-local through the dispatcher (gated) and strips ELEMENT_KEY into elementKey', async () => {
    const calls: DispatchContext[] = [];
    const dispatcher: ActionDispatcher = {
      dispatch: async (_name: string, ctx: DispatchContext) => {
        calls.push(ctx);
        return { status: 'settled' as const };
      },
    };
    const handlers = buildHandlers({
      catalog,
      dispatcher,
      getState: () => ({}),
      emitLifecycle: () => {},
    });
    await mustGet(handlers, 'merge')({ inputs: ['a.mp4'], [ELEMENT_KEY]: 'btn-merge' });
    expect(calls).toHaveLength(1);
    const ctx = calls[0];
    expect(ctx?.elementKey).toBe('btn-merge');
    expect(ctx?.resolvedParams).toEqual({ inputs: ['a.mp4'] }); // key stripped before dispatch
  });

  it('a disallowed render-local (log) rejects instead of running', async () => {
    const handlers = buildHandlers({
      catalog,
      dispatcher: dispatcherSpy(),
      getState: () => ({}),
      emitLifecycle: () => {},
    });
    await expect(mustGet(handlers, 'log')({ msg: 'x' })).rejects.toThrow(
      /render-local|not allowed|log/i,
    );
  });

  it('exit is rejected even when the catalog omits it (native built-in must be shadowed)', async () => {
    const handlers = buildHandlers({
      catalog,
      dispatcher: dispatcherSpy(),
      getState: () => ({}),
      emitLifecycle: () => {},
    });
    await expect(mustGet(handlers, 'exit')({})).rejects.toThrow(/not allowed|exit/i);
  });
});
