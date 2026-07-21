import { describe, it, expect } from 'vitest';
import { createSeqGuard } from '../src/sequencing/seq-guard.js';

describe('seq-guard', () => {
  it('flags a delta arriving before any snapshot baseline', () => {
    const g = createSeqGuard();
    expect(g.checkDelta(1)).toEqual({ ok: false, reason: 'missed-baseline' });
  });

  it('accepts deltas after a baseline', () => {
    const g = createSeqGuard();
    g.onSnapshot(0);
    expect(g.checkDelta(1)).toEqual({ ok: true });
    expect(g.checkDelta(2)).toEqual({ ok: true });
  });

  it('flags an out-of-order (non-increasing) sequence', () => {
    const g = createSeqGuard();
    g.onSnapshot(0);
    expect(g.checkDelta(1)).toEqual({ ok: true });
    expect(g.checkDelta(1)).toEqual({ ok: false, reason: 'out-of-order' });
  });

  it('accepts seq-less deltas once a baseline exists', () => {
    const g = createSeqGuard();
    g.onSnapshot();
    expect(g.checkDelta()).toEqual({ ok: true });
  });

  it('reset returns to the missed-baseline state', () => {
    const g = createSeqGuard();
    g.onSnapshot(0);
    g.reset();
    expect(g.checkDelta(1)).toEqual({ ok: false, reason: 'missed-baseline' });
  });
});
