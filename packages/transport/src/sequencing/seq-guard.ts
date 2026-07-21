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
      last = seq ?? last;
    },
    checkDelta(seq) {
      if (!hasBaseline) return { ok: false, reason: 'missed-baseline' };
      if (seq === undefined) return { ok: true };
      if (seq <= last) return { ok: false, reason: 'out-of-order' };
      last = seq;
      return { ok: true };
    },
    reset() {
      hasBaseline = false;
      last = -Infinity;
    },
  };
}
