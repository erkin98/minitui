import { describe, it, expect } from 'vitest';
import type { ActionOutcome } from '../src/dispatch/outcome.js';

describe('ActionOutcome', () => {
  it('discriminates on status across all four states', () => {
    const settled: ActionOutcome = { status: 'settled', result: { ok: true } };
    const denied: ActionOutcome = { status: 'denied', reason: 'hard-floor: rm of $HOME' };
    const failed: ActionOutcome = {
      status: 'failed',
      fault: { actionKey: 'merge', exitCode: 1, stderrExcerpt: 'codec not found' },
    };
    const awaiting: ActionOutcome = { status: 'awaiting', requestId: 'req-1' };

    expect(settled.status).toBe('settled');
    expect(denied.status === 'denied' && denied.reason).toContain('hard-floor');
    expect(failed.status === 'failed' && failed.fault.actionKey).toBe('merge');
    expect(awaiting.status === 'awaiting' && awaiting.requestId).toBe('req-1');
  });

  it('settled.result is optional', () => {
    const bare: ActionOutcome = { status: 'settled' };
    expect(bare.status).toBe('settled');
  });
});
