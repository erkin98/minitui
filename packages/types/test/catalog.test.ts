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
  it('assertNever throws on an unhandled discriminant (§Z47 exhaustiveness guard)', () => {
    // `as never` is REQUIRED here (not gap-masking): assertNever's param is typed `never` by
    // design, so exercising its runtime throw forces an impossible value in — the canonical test.
    expect(() => assertNever('surprise' as never, 'ActionKind')).toThrow(/unhandled/);
  });
});
