import { describe, it, expect } from 'vitest';
import type { ActionLifecycleEvent } from '../src/events/lifecycle.js';
import type { LifecycleEmitter } from '../src/events/emitter.js';

describe('lifecycle', () => {
  it('records started -> progress -> result through a LifecycleEmitter', () => {
    const seen: ActionLifecycleEvent[] = [];
    const emitter: LifecycleEmitter = {
      emit: (e) => {
        seen.push(e);
      },
    };

    emitter.emit({ phase: 'started', actionName: 'merge', elementKey: 'merge-button' });
    emitter.emit({
      phase: 'progress',
      actionName: 'merge',
      elementKey: 'merge-button',
      progress: 0.5,
      message: 'frame 120',
    });
    emitter.emit({
      phase: 'result',
      actionName: 'merge',
      elementKey: 'merge-button',
      result: { out: '/abs/out.mp4' },
    });

    expect(seen.map((e) => e.phase)).toEqual(['started', 'progress', 'result']);
    const prog = seen[1];
    expect(prog?.phase === 'progress' && prog.progress).toBe(0.5);
  });

  it('error carries the locked RuntimeFault fields', () => {
    const seen: ActionLifecycleEvent[] = [];
    const emitter: LifecycleEmitter = {
      emit: (e) => {
        seen.push(e);
      },
    };
    emitter.emit({
      phase: 'error',
      actionName: 'merge',
      elementKey: 'merge-button',
      // RuntimeFault is the LOCKED { actionKey, exitCode, stderrExcerpt } from @minitui/types
      fault: { actionKey: 'merge', exitCode: 1, stderrExcerpt: 'codec not found' },
    });
    const err = seen[0];
    expect(err?.phase).toBe('error');
    // assert the real fault fields so the test fails if the union shape drifts
    expect(err?.phase === 'error' && err.fault.actionKey).toBe('merge');
    expect(err?.phase === 'error' && err.fault.exitCode).toBe(1);
    expect(err?.phase === 'error' && err.fault.stderrExcerpt).toBe('codec not found');
  });

  it('awaiting carries the requestId that correlates the consent reply', () => {
    const seen: ActionLifecycleEvent[] = [];
    const emitter: LifecycleEmitter = {
      emit: (e) => {
        seen.push(e);
      },
    };
    // consent 'ask' is a first-class awaiting phase (ledger §Z10), not smuggled through progress
    emitter.emit({
      phase: 'awaiting',
      actionName: 'merge',
      elementKey: 'merge-button',
      requestId: 'req-1',
    });
    const ev = seen[0];
    expect(ev?.phase).toBe('awaiting');
    // narrow on the discriminant so the test fails closed if the awaiting variant drifts
    expect(ev?.phase === 'awaiting' && ev.requestId).toBe('req-1');
  });
});
