import { describe, it, expect } from 'vitest';
import {
  systemClock,
  fixedClock,
  steppingClock,
  createSpecSink,
  type Clock,
  type ToolDispatchPort,
  type ToolCallRequest,
  type ToolCallResult,
  type SpecSinkPort,
} from '../src/ports/index.js';
import type { AppSpec } from '@minitui/types';
import type { MinituiEvent } from '../src/events/index.js';

// MinituiEvent is a discriminated union; the sink returns it union-typed. This narrows to the
// ACTIVITY_SNAPSHOT member so `ev.spec` type-checks, and throws if the sink built the wrong variant.
function asActivitySnapshot(
  ev: MinituiEvent,
): asserts ev is Extract<MinituiEvent, { type: 'ACTIVITY_SNAPSHOT' }> {
  if (ev.type !== 'ACTIVITY_SNAPSHOT')
    throw new Error(`expected ACTIVITY_SNAPSHOT, got ${ev.type}`);
}

describe('Clock', () => {
  it('systemClock returns a positive epoch ms', () => {
    expect(systemClock.now()).toBeGreaterThan(0);
  });
  it('fixedClock is frozen', () => {
    const c: Clock = fixedClock(1000);
    expect(c.now()).toBe(1000);
    expect(c.now()).toBe(1000);
  });
  it('steppingClock advances monotonically by step', () => {
    const c = steppingClock(100, 5);
    expect(c.now()).toBe(100);
    expect(c.now()).toBe(105);
    expect(c.now()).toBe(110);
  });
});

describe('ToolDispatchPort', () => {
  it('is implementable and returns a ToolCallResult carrying toolName', async () => {
    const port: ToolDispatchPort = {
      async dispatch(req: ToolCallRequest): Promise<ToolCallResult> {
        return {
          toolCallId: req.toolCallId,
          toolName: req.toolName,
          ok: true,
          content: `ran ${req.toolName}`,
          isError: false,
        };
      },
    };
    const out = await port.dispatch(
      { toolCallId: 't1', toolName: 'merge', args: { n: 2 } },
      new AbortController().signal,
    );
    expect(out).toEqual({
      toolCallId: 't1',
      toolName: 'merge',
      ok: true,
      content: 'ran merge',
      isError: false,
    });
  });

  it('can express a permission denial distinct from a tool failure', async () => {
    const port: ToolDispatchPort = {
      async dispatch(req: ToolCallRequest): Promise<ToolCallResult> {
        return {
          toolCallId: req.toolCallId,
          toolName: req.toolName,
          ok: false,
          content: '',
          isError: false,
          denied: true,
          error: 'user declined merge of 2 files',
        };
      },
    };
    const out = await port.dispatch(
      { toolCallId: 't2', toolName: 'merge', args: { n: 2 } },
      new AbortController().signal,
    );
    expect(out.denied).toBe(true);
    expect(out.ok).toBe(false);
    expect(out.error).toContain('declined');
  });
});

describe('SpecSinkPort', () => {
  it('the default sink emits an ACTIVITY_SNAPSHOT carrying the spec', () => {
    const sink: SpecSinkPort = createSpecSink();
    // Canonical AppSpec is { root, elements } — the data model lives on the spec's state, never in
    // an AppSpec `data` field.
    const spec: AppSpec = {
      root: 'a',
      elements: { a: { type: 'Box', props: {} } }, // element identity IS the map key — no element-local `key` field
    };
    const ev = sink.emit(spec);
    asActivitySnapshot(ev);
    expect(ev.type).toBe('ACTIVITY_SNAPSHOT');
    expect(ev.spec).toEqual(spec); // payload is { spec } — one shape
  });
});
