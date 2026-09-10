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

  // A non-finite sequence must never become the watermark because every later
  // finite comparison would be false and bypass the guard.
  it('rejects a non-finite delta sequence without poisoning the watermark', () => {
    const g = createSeqGuard();
    g.onSnapshot(1);
    expect(g.checkDelta(NaN)).toEqual({ ok: false, reason: 'out-of-order' });
    expect(g.checkDelta(Infinity)).toEqual({ ok: false, reason: 'out-of-order' });
    // watermark still 1: a regression is still caught, a valid advance still passes
    expect(g.checkDelta(0)).toEqual({ ok: false, reason: 'out-of-order' });
    expect(g.checkDelta(2)).toEqual({ ok: true });
  });

  // A fresh snapshot is a full re-baseline (a resync rebuilds the baseline):
  // its delta watermark must reset, never retain the PREVIOUS baseline's high-water mark.
  it('resets the delta watermark on a seq-less re-baseline (no stale high-water mark)', () => {
    const g = createSeqGuard();
    g.onSnapshot();
    expect(g.checkDelta(10)).toEqual({ ok: true }); // advances watermark to 10
    g.onSnapshot(); // re-baseline with no seq — watermark must drop back, not stay 10
    expect(g.checkDelta(3)).toEqual({ ok: true }); // 3 is valid against the fresh baseline
  });
});
