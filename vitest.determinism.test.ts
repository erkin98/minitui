// vitest.determinism.test.ts
import { describe, it, expect } from 'vitest';
import { FROZEN_EPOCH_MS } from './vitest.determinism.setup';

describe('ansi-determinism setup', () => {
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
    expect(new Date(0).getUTCHours()).toBe(0);
    expect(process.env.TZ).toBe('UTC');
  });
});
