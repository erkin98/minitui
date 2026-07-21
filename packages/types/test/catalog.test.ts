import { describe, it, expect } from 'vitest';
import { ACTION_KINDS, ActionKindSchema, assertNever, type ActionKind } from '../src/catalog.js';

describe('ActionKind', () => {
  it('is exactly the four kinds in stable order', () => {
    expect(ACTION_KINDS).toEqual(['render-local', 'exec-local', 'exec-mcp', 'agent-callback']);
  });
  it('parses a valid kind and rejects an unknown one', () => {
    const k: ActionKind = ActionKindSchema.parse('exec-local');
    expect(k).toBe('exec-local');
    expect(ActionKindSchema.safeParse('exec-remote').success).toBe(false);
  });
  it('assertNever throws the exact context-tagged message (§Z44/§Z47 exhaustiveness guard)', () => {
    // `as never` is REQUIRED here (not gap-masking): assertNever's param is typed `never` by
    // design, so exercising its runtime throw forces an impossible value in — the canonical test.
    // Exact message locked (was a loose /unhandled/) so any format drift from the shipped shape
    // is gate-visible (C25). NOTE: ledger §Z44's illustrative literal (`unhandled: ${context}...`)
    // differs from this shipped+plan-02 format and needs a main-thread reconcile.
    expect(() => assertNever('surprise' as never, 'ActionKind')).toThrow(
      /^unhandled ActionKind: "surprise"$/,
    );
    expect(() => assertNever('x' as never)).toThrow(/^unhandled: "x"$/);
  });
});
