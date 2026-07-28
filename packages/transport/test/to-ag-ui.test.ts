import { describe, it, expect } from 'vitest';
import { EventType } from '@ag-ui/core';
import { toAgUiEvent } from '../src/agent/to-ag-ui.js';

describe('toAgUiEvent minitui-to-AG-UI field synthesis', () => {
  const ctx = { threadId: 't1', runId: 'r1', messageId: 'm1' };

  it('synthesizes messageId onto TEXT_MESSAGE_CONTENT (minitui never carries one)', () => {
    const ev = toAgUiEvent({ type: EventType.TEXT_MESSAGE_CONTENT, delta: 'hi' }, ctx);
    expect(ev).toMatchObject({ messageId: 'm1', delta: 'hi' });
  });

  it('passes native RUN_STARTED threadId and runId through untouched', () => {
    const ev = toAgUiEvent(
      { type: EventType.RUN_STARTED, threadId: 'own-thread', runId: 'own-run' },
      ctx,
    );
    expect(ev).toMatchObject({ threadId: 'own-thread', runId: 'own-run' });
  });

  it('nests the minitui { spec } payload into ACTIVITY_SNAPSHOT { activityType, content } (real AG-UI schema)', () => {
    const spec = { root: 'r', elements: {} };
    const ev = toAgUiEvent({ type: EventType.ACTIVITY_SNAPSHOT, spec }, ctx);
    expect(ev).toMatchObject({ messageId: 'm1', activityType: 'mini-app-spec', content: spec });
    expect(ev).not.toHaveProperty('spec');
  });
});
