// vitest.determinism.test.ts
import { describe, it, expect } from 'vitest';
import { FROZEN_EPOCH_MS } from './vitest.determinism.constants';

describe('ansi-determinism setup', () => {
  it('loads the determinism setup via setupFiles, not a test import', () => {
    // The sentinel is set only by vitest.determinism.setup.ts. This test imports the
    // frozen epoch from the side-effect-free constants module, so if the sentinel is
    // present the setup must have run through setupFiles — remove that line from
    // vitest.shared.ts and this assertion reds.
    expect(globalThis.__MINITUI_DET_SETUP__).toBe(true);
  });

  it('freezes Date.now to the fixed epoch', () => {
    expect(Date.now()).toBe(FROZEN_EPOCH_MS);
    expect(new Date().getTime()).toBe(FROZEN_EPOCH_MS);
  });

  it('makes Math.random deterministic and stable', () => {
    const a = Math.random();
    const b = Math.random();
    expect(a).toBeGreaterThanOrEqual(0);
    expect(a).toBeLessThan(1);
    // Assert the EXACT seeded sequence, not just the range: mulberry32(0x1234abcd)'s first two
    // draws. `a ∈ [0,1)` alone is a vacuous gate (LO-09) — native un-seeded Math.random passes
    // it, so removing the seed would leave the check green. These literals only reproduce under
    // the frozen seed, so de-seeding the setup reds this test.
    expect(a).toBe(0.10277144517749548);
    expect(b).toBe(0.5144855019170791);
    expect(a).not.toBe(b);
  });

  it('locks the timezone to UTC', () => {
    // getHours()/getTimezoneOffset() are LOCAL — they honor process.env.TZ, unlike
    // getUTCHours() which returns UTC regardless of the lock (so the old getUTCHours()===0
    // assert was a tautology). At epoch 0 (1970-01-01T00:00:00Z) local hours are 0 and the
    // offset is 0 ONLY because TZ=UTC; any other zone shifts both, so this tests the lock.
    expect(new Date(0).getHours()).toBe(0);
    expect(new Date(0).getTimezoneOffset()).toBe(0);
    expect(process.env.TZ).toBe('UTC');
  });
});
