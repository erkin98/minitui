import { describe, it, expect } from 'vitest';
import { gatedHandler } from '../src/binder/gated-handler.js';
import type {
  ActionDispatcher,
  DispatchContext,
  ActionOutcome,
  ActionLifecycleEvent,
} from '@minitui/renderer-core';
import type { MinituiActionDef } from '@minitui/catalog';
import { z } from 'zod';

const def: MinituiActionDef = {
  params: z.object({ inputs: z.array(z.string()) }),
  description: 'merge videos',
  kind: 'exec-local',
  permission: { danger: true, resourceTemplate: 'ffmpeg', summaryTemplate: 'merge' },
};

function makeDispatcher(outcome: ActionOutcome) {
  const calls: DispatchContext[] = [];
  const dispatcher: ActionDispatcher = {
    dispatch: async (_name: string, ctx: DispatchContext) => {
      calls.push(ctx);
      return outcome;
    },
  };
  return { dispatcher, calls };
}

describe('gatedHandler', () => {
  it('builds DispatchContext from resolved params + permission and emits started then result', async () => {
    const { dispatcher, calls } = makeDispatcher({ status: 'settled', result: 'ok' });
    const events: ActionLifecycleEvent[] = [];
    const handler = gatedHandler({
      actionName: 'merge',
      def,
      dispatcher,
      getStateSnapshot: () => ({ inputs: ['a.mp4', 'b.mp4'] }),
      emitLifecycle: (e) => events.push(e),
    });

    await handler({ inputs: ['a.mp4', 'b.mp4'] }, 'btn-merge');

    expect(calls[0]).toMatchObject({
      actionName: 'merge',
      actionKind: 'exec-local',
      permission: def.permission,
      resolvedParams: { inputs: ['a.mp4', 'b.mp4'] },
      elementKey: 'btn-merge',
    });
    expect(events.map((e) => e.phase)).toEqual(['started', 'result']);
    // canonical union: the result variant carries `result`, not a flat `detail`
    expect(events[1]).toMatchObject({ phase: 'result', result: 'ok' });
  });

  it('emits an error event carrying a RuntimeFault on a failed outcome', async () => {
    const fault = { actionKey: 'merge', exitCode: 1, stderrExcerpt: 'boom' };
    const { dispatcher } = makeDispatcher({ status: 'failed', fault });
    const events: ActionLifecycleEvent[] = [];
    const handler = gatedHandler({
      actionName: 'merge',
      def,
      dispatcher,
      getStateSnapshot: () => ({}),
      emitLifecycle: (e) => events.push(e),
    });
    await handler({ inputs: [] }, 'btn-merge');
    expect(events.map((e) => e.phase)).toEqual(['started', 'error']);
    // canonical union: the error variant carries `fault: RuntimeFault`
    expect(events[1]).toMatchObject({ phase: 'error', fault });
  });

  it('synthesizes a RuntimeFault for a denied outcome (deny is surfaced as an error event)', async () => {
    const { dispatcher } = makeDispatcher({ status: 'denied', reason: 'user said no' });
    const events: ActionLifecycleEvent[] = [];
    const handler = gatedHandler({
      actionName: 'merge',
      def,
      dispatcher,
      getStateSnapshot: () => ({}),
      emitLifecycle: (e) => events.push(e),
    });
    await handler({ inputs: [] }, 'btn-merge');
    expect(events.map((e) => e.phase)).toEqual(['started', 'error']);
    expect(events[1]).toMatchObject({ phase: 'error', fault: { stderrExcerpt: 'user said no' } });
  });

  it('maps an awaiting outcome to the first-class `awaiting` phase carrying requestId', async () => {
    const { dispatcher } = makeDispatcher({ status: 'awaiting', requestId: 'req-7' });
    const events: ActionLifecycleEvent[] = [];
    const handler = gatedHandler({
      actionName: 'merge',
      def,
      dispatcher,
      getStateSnapshot: () => ({}),
      emitLifecycle: (e) => events.push(e),
    });
    await handler({ inputs: [] }, 'btn-merge');
    expect(events.map((e) => e.phase)).toEqual(['started', 'awaiting']);
    // NOT progress: a pending gate is its own phase and carries the requestId, not a fake 0%.
    expect(events[1]).toMatchObject({
      phase: 'awaiting',
      actionName: 'merge',
      elementKey: 'btn-merge',
      requestId: 'req-7',
    });
  });

  it('maps an exec `progress` ExecEvent (ctx.onEvent) to a first-class lifecycle `progress` phase', async () => {
    const events: ActionLifecycleEvent[] = [];
    // a REAL dispatcher that streams an exec progress event through the correlation seam BEFORE
    // it settles — exactly what the composition-root dispatcher does mid-exec. Proves
    // gatedHandler builds ctx.onEvent and maps ExecEvent.progress -> the lifecycle `progress` phase.
    const dispatcher: ActionDispatcher = {
      dispatch: async (_name, ctx) => {
        ctx.onEvent?.({ kind: 'progress', value: 0.5 });
        return { status: 'settled' as const, result: 'ok' };
      },
    };
    const handler = gatedHandler({
      actionName: 'merge',
      def,
      dispatcher,
      getStateSnapshot: () => ({}),
      emitLifecycle: (e) => events.push(e),
    });
    await handler({ inputs: [] }, 'btn-merge');
    expect(events.map((e) => e.phase)).toEqual(['started', 'progress', 'result']);
    expect(events[1]).toMatchObject({
      phase: 'progress',
      actionName: 'merge',
      elementKey: 'btn-merge',
      progress: 0.5,
    });
  });

  it('rejects invalid params BEFORE dispatch — parse-before-execute fails closed', async () => {
    const { dispatcher, calls } = makeDispatcher({ status: 'settled', result: 'ok' });
    const events: ActionLifecycleEvent[] = [];
    const handler = gatedHandler({
      actionName: 'merge',
      def,
      dispatcher,
      getStateSnapshot: () => ({}),
      emitLifecycle: (e) => events.push(e),
    });
    // `inputs` must be string[] per `def.params` — a number fails the schema.
    await handler({ inputs: [1, 2] }, 'btn-merge');
    expect(calls).toHaveLength(0); // dispatcher NEVER called
    expect(events.map((e) => e.phase)).toEqual(['error']); // no 'started' — fails closed before it
    expect(events[0]).toMatchObject({
      phase: 'error',
      actionName: 'merge',
      elementKey: 'btn-merge',
    });
  });
});
