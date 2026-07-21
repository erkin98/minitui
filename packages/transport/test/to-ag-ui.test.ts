import { describe, it, expect } from 'vitest';
import { EventType } from '@ag-ui/core';
import { toAgUiEvent } from '../src/agent/to-ag-ui.js';

describe('toAgUiEvent (minitui -> AG-UI field synthesis, ledger §L, Slice-2+ remote-BFF adapter)', () => {
  const ctx = { threadId: 't1', runId: 'r1', messageId: 'm1' };

  it('synthesizes messageId onto TEXT_MESSAGE_CONTENT (minitui never carries one)', () => {
    const ev = toAgUiEvent(
      { type: EventType.TEXT_MESSAGE_CONTENT, delta: 'hi' },
      ctx,
    ) as unknown as Record<string, unknown>;
    expect(ev.messageId).toBe('m1');
    expect(ev.delta).toBe('hi');
  });

  it('passes threadId/runId through untouched — RUN_STARTED already carries them natively (ledger §N)', () => {
    const ev = toAgUiEvent(
      { type: EventType.RUN_STARTED, threadId: 'own-thread', runId: 'own-run' },
      ctx,
    ) as unknown as Record<string, unknown>;
    expect(ev.threadId).toBe('own-thread');
    expect(ev.runId).toBe('own-run');
  });

  it('nests the minitui { spec } payload into ACTIVITY_SNAPSHOT { activityType, content } (real AG-UI schema)', () => {
    const spec = { root: 'r', elements: {} };
    const ev = toAgUiEvent({ type: EventType.ACTIVITY_SNAPSHOT, spec }, ctx) as unknown as Record<
      string,
      unknown
    >;
    expect(ev.messageId).toBe('m1');
    expect(typeof ev.activityType).toBe('string');
    expect(ev.content).toEqual(spec);
    expect(ev.spec).toBeUndefined(); // reshaped, not just tacked on
  });
});
