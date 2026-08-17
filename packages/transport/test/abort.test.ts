import { getEventListeners } from 'node:events';
import { describe, expect, it } from 'vitest';
import { createAbort } from '../src/agent/abort.js';

describe('createAbort', () => {
  it('removes its parent listener when the child aborts first', () => {
    const parent = new AbortController();
    const listenerCount = getEventListeners(parent.signal, 'abort').length;
    const child = createAbort(parent.signal);
    expect(getEventListeners(parent.signal, 'abort')).toHaveLength(listenerCount + 1);

    child.controller.abort();

    expect(getEventListeners(parent.signal, 'abort')).toHaveLength(listenerCount);
  });

  it('propagates the parent reason and handles an already-aborted parent', () => {
    const liveParent = new AbortController();
    const liveChild = createAbort(liveParent.signal);
    const reason = new Error('parent stopped');
    liveParent.abort(reason);
    expect(liveChild.signal.aborted).toBe(true);
    expect(liveChild.signal.reason).toBe(reason);

    const stoppedParent = new AbortController();
    stoppedParent.abort(reason);
    const stoppedChild = createAbort(stoppedParent.signal);
    expect(stoppedChild.signal.aborted).toBe(true);
    expect(stoppedChild.signal.reason).toBe(reason);
  });
});
