import { describe, it, expect } from 'vitest';
import type { RuntimeFault } from '@minitui/types';
import { toRuntimeRepair } from '../src/runtime/runtime-correction.js';
import type { RuntimeError } from '../src/runtime/runtime-error.js';

describe('toRuntimeRepair', () => {
  it('wraps a non-zero exit into a fixable RUNTIME_ERROR reprompt', () => {
    const err: RuntimeError = {
      exitCode: 1,
      stderrExcerpt: "Unknown encoder 'libvpx-vp99'",
      actionKey: 'merge',
    };
    const repair = toRuntimeRepair(err);
    expect(repair.code).toBe('RUNTIME_ERROR');
    expect(repair.fixable).toBe(true);
    expect(repair.actionKey).toBe('merge');
    expect(repair.reprompt).toContain('libvpx-vp99');
    expect(repair.reprompt).toContain('merge');
  });

  it('appends the injected catalog-domain wording when provided (ledger §Z3 chain)', () => {
    const repair = toRuntimeRepair(
      { exitCode: 1, stderrExcerpt: "Unknown encoder 'libvpx-vp99'", actionKey: 'merge' },
      'Adjust the action parameters, codecs, filters, or file paths so the action can succeed.',
    );
    expect(repair.reprompt).toContain('codecs');
    // omitting wording falls back to a generic remedy line — the builder stands alone
    const generic = toRuntimeRepair({ exitCode: 1, stderrExcerpt: 'boom', actionKey: 'merge' });
    expect(generic.reprompt).toContain('Regenerate the spec');
  });

  it('marks a zero exit as not fixable (nothing to repair)', () => {
    const repair = toRuntimeRepair({ exitCode: 0, stderrExcerpt: '', actionKey: 'merge' });
    expect(repair.fixable).toBe(false);
    expect(repair.reprompt).toBe('');
  });

  it('accepts the canonical @minitui/types RuntimeFault at the seam (ledger §B1/§Z3)', () => {
    // Every real caller — agent-core routeRuntimeFault, the cli buildRepair adapter
    // (plan 15), the integration suite (plan 17) — holds a RuntimeFault and passes it
    // straight in. RuntimeError aliases RuntimeFault (§B1 — ONE shape, owned by
    // @minitui/types), so this is an exact match, not a structural coincidence.
    const fault: RuntimeFault = { actionKey: 'merge', exitCode: 2, stderrExcerpt: 'boom' };
    expect(toRuntimeRepair(fault).fixable).toBe(true);
  });
});
