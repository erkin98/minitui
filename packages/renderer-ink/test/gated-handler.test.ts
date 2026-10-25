import { describe, it, expect } from 'vitest';
import { gatedHandler } from '../src/binder/gated-handler.js';
import type {
  ActionDispatcher,
  DispatchContext,
  ActionOutcome,
  ActionLifecycleEvent,
} from '@minitui/renderer-core';
import type { MinituiActionDef } from '@minitui/catalog';
import type { DiagnosticsPort } from '@minitui/types';
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

  // the progress event a handler emits when the dispatcher reports one progress step
  async function progressEventFor(message: string | undefined): Promise<ActionLifecycleEvent> {
    const events: ActionLifecycleEvent[] = [];
    const dispatcher: ActionDispatcher = {
      dispatch: async (_name, ctx) => {
        ctx.onEvent?.(
          message === undefined
            ? { kind: 'progress', value: 0.5 }
            : { kind: 'progress', value: 0.5, message },
        );
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
    const progress = events.find((e) => e.phase === 'progress');
    if (progress === undefined) throw new Error('no progress event was emitted');
    return progress;
  }

  it('forwards the progress message, sanitised', async () => {
    const event = await progressEventFor(`frame=10${String.fromCharCode(27)}[31m`);
    expect(event).toMatchObject({ phase: 'progress', progress: 0.5, message: 'frame=10' });
  });

  it('a progress event without a message carries no message key', async () => {
    const event = await progressEventFor(undefined);
    expect('message' in event).toBe(false);
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

// ---- a failure after started ends in one terminal event and one report ----

const ESC = String.fromCharCode(27);

function recordingSink() {
  const warnings: Array<{ msg: string; meta: Record<string, unknown> | undefined }> = [];
  const sink: DiagnosticsPort = {
    warn: (msg, meta) => {
      warnings.push({ msg, meta });
    },
    debug() {},
  };
  return { sink, warnings };
}

describe('gatedHandler: a failure after started', () => {
  const failing = (message: string): ActionDispatcher => ({
    dispatch: async () => {
      throw new Error(message);
    },
  });
  const run = async (dispatcher: ActionDispatcher, diagnostics: DiagnosticsPort) => {
    const events: ActionLifecycleEvent[] = [];
    const handler = gatedHandler({
      actionName: 'merge',
      def,
      dispatcher,
      getStateSnapshot: () => ({}),
      emitLifecycle: (e) => events.push(e),
      diagnostics,
    });
    await handler({ inputs: ['a.mp4'] }, 'btn');
    return events;
  };

  it('a rejecting dispatcher: one started, one error, one report with a fixed message', async () => {
    const { sink, warnings } = recordingSink();
    const first = await run(failing('first failure'), sink);
    const second = await run(failing(`second ${ESC}[31mfailure ${'x'.repeat(2000)}`), sink);
    for (const events of [first, second]) {
      expect(events.map((e) => e.phase)).toEqual(['started', 'error']);
    }
    expect(warnings).toHaveLength(2);
    expect(warnings[0]?.msg).toBe(warnings[1]?.msg);
    const meta = JSON.stringify(warnings[1]?.meta);
    expect(meta).not.toContain(ESC);
    expect(String(warnings[1]?.meta?.error).length).toBeLessThanOrEqual(512);
    expect(String(warnings[0]?.meta?.error)).toContain('first failure');
  });

  it('a throwing state thunk after started: the same', async () => {
    const { sink, warnings } = recordingSink();
    const events: ActionLifecycleEvent[] = [];
    const handler = gatedHandler({
      actionName: 'merge',
      def,
      dispatcher: makeDispatcher({ status: 'settled' }).dispatcher,
      getStateSnapshot: () => {
        throw new Error(`state is gone ${ESC}[2J`);
      },
      emitLifecycle: (e) => events.push(e),
      diagnostics: sink,
    });
    await handler({ inputs: ['a.mp4'] }, 'btn');
    expect(events.map((e) => e.phase)).toEqual(['started', 'error']);
    expect(warnings).toHaveLength(1);
    expect(JSON.stringify(warnings[0]?.meta)).not.toContain(ESC);
  });

  it('progress after the terminal event emits nothing', async () => {
    const captured: DispatchContext[] = [];
    const dispatcher: ActionDispatcher = {
      dispatch: async (_name, ctx) => {
        captured.push(ctx);
        return { status: 'settled', result: 'ok' };
      },
    };
    const events: ActionLifecycleEvent[] = [];
    const handler = gatedHandler({
      actionName: 'merge',
      def,
      dispatcher,
      getStateSnapshot: () => ({}),
      emitLifecycle: (e) => events.push(e),
    });
    await handler({ inputs: ['a.mp4'] }, 'btn');
    expect(events.map((e) => e.phase)).toEqual(['started', 'result']);
    captured[0]?.onEvent?.({ kind: 'progress', value: 0.5 });
    expect(events.map((e) => e.phase)).toEqual(['started', 'result']);
  });

  it('control: progress during the run is emitted', async () => {
    const events: ActionLifecycleEvent[] = [];
    const dispatcher: ActionDispatcher = {
      dispatch: async (_name, ctx) => {
        ctx.onEvent?.({ kind: 'progress', value: 0.25 });
        return { status: 'settled', result: 'ok' };
      },
    };
    const handler = gatedHandler({
      actionName: 'merge',
      def,
      dispatcher,
      getStateSnapshot: () => ({}),
      emitLifecycle: (e) => events.push(e),
    });
    await handler({ inputs: ['a.mp4'] }, 'btn');
    expect(events.map((e) => e.phase)).toEqual(['started', 'progress', 'result']);
  });

  it('a sink that throws, and a sink that returns a rejected promise, change nothing', async () => {
    const throwing: DiagnosticsPort = {
      warn: () => {
        throw new Error('sink down');
      },
      debug() {},
    };
    const rejecting: DiagnosticsPort = {
      warn: async () => {
        throw new Error('sink rejected');
      },
      debug() {},
    };
    for (const sink of [throwing, rejecting]) {
      const events = await run(failing('boom'), sink);
      expect(events.map((e) => e.phase)).toEqual(['started', 'error']);
    }
    await afterTurn();
  });
});

// let a rejected promise from a sink surface (vitest fails the run on an unhandled rejection)
const afterTurn = (): Promise<void> => new Promise((r) => setTimeout(r, 20));

// ---- the fault text of a denied action and of invalid params is bounded and clean ----

// a control character other than CR, TAB and LF, which the shared sanitiser keeps
const hasStrippedControl = (text: string): boolean =>
  [...text].some((char) => {
    const code = char.codePointAt(0) ?? 0;
    if (code === 0x09 || code === 0x0a || code === 0x0d) return false;
    return code < 0x20 || (code >= 0x7f && code <= 0x9f);
  });

describe('gatedHandler: fault text', () => {
  const faultOf = (events: ActionLifecycleEvent[]): string => {
    const last = events.at(-1);
    return last?.phase === 'error' ? last.fault.stderrExcerpt : '';
  };

  it('a denial reason with an escape sequence and 5,000 characters is cleaned and cut to 512', async () => {
    const reason = `denied ${ESC}[31mred${ESC}[0m ${'z'.repeat(5000)}`;
    const { dispatcher } = makeDispatcher({ status: 'denied', reason });
    const events: ActionLifecycleEvent[] = [];
    const handler = gatedHandler({
      actionName: 'merge',
      def,
      dispatcher,
      getStateSnapshot: () => ({}),
      emitLifecycle: (e) => events.push(e),
    });
    await handler({ inputs: ['a.mp4'] }, 'btn');
    const text = faultOf(events);
    expect(text).toContain('denied');
    expect(text).not.toContain(ESC);
    expect(text.length).toBeLessThanOrEqual(512);
  });

  it('invalid params with a long schema message start with invalid params: and are cut to 512', async () => {
    const { dispatcher, calls } = makeDispatcher({ status: 'settled' });
    const events: ActionLifecycleEvent[] = [];
    const handler = gatedHandler({
      actionName: 'merge',
      def,
      dispatcher,
      getStateSnapshot: () => ({}),
      emitLifecycle: (e) => events.push(e),
    });
    await handler({ inputs: Array.from({ length: 200 }, () => 5) }, 'btn');
    const text = faultOf(events);
    expect(calls).toEqual([]);
    expect(text.startsWith('invalid params:')).toBe(true);
    expect(hasStrippedControl(text)).toBe(false);
    expect(text.length).toBeLessThanOrEqual(512);
  });

  it('control: a short plain reason passes through unchanged', async () => {
    const { dispatcher } = makeDispatcher({ status: 'denied', reason: 'user said no' });
    const events: ActionLifecycleEvent[] = [];
    const handler = gatedHandler({
      actionName: 'merge',
      def,
      dispatcher,
      getStateSnapshot: () => ({}),
      emitLifecycle: (e) => events.push(e),
    });
    await handler({ inputs: ['a.mp4'] }, 'btn');
    expect(faultOf(events)).toBe('user said no');
  });
});
