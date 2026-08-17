export type SeqVerdict = { ok: true } | { ok: false; reason: 'missed-baseline' | 'out-of-order' };

export interface SeqGuard {
  onSnapshot(seq?: number): void;
  checkDelta(seq?: number): SeqVerdict;
  reset(): void;
}

export function createSeqGuard(): SeqGuard {
  let hasBaseline = false;
  let last = -Infinity;
  return {
    onSnapshot(seq) {
      hasBaseline = true;
      // A snapshot is a full re-baseline: the watermark resets to the snapshot's own seq
      // (when finite) or to -Infinity, never RETAINING the previous baseline's stale mark.
      last = typeof seq === 'number' && Number.isFinite(seq) ? seq : -Infinity;
    },
    checkDelta(seq) {
      if (!hasBaseline) return { ok: false, reason: 'missed-baseline' };
      if (seq === undefined) return { ok: true };
      // Reject a non-finite seq (NaN/±Infinity): it can never satisfy strict ordering and,
      // if stored as `last`, would disable every later check (NaN <= x is always false).
      if (!Number.isFinite(seq) || seq <= last) return { ok: false, reason: 'out-of-order' };
      last = seq;
      return { ok: true };
    },
    reset() {
      hasBaseline = false;
      last = -Infinity;
    },
  };
}
