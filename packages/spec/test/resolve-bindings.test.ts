import { describe, it, expect } from 'vitest';
import { resolveBindings } from '../src/semantic/resolve-bindings.js';
import type { Spec } from '../src/spec-types.js';

const base = (state: Record<string, unknown>): Spec => ({
  root: 'f',
  elements: {
    f: { type: 'Box', props: {}, children: ['sel'] },
    sel: { type: 'Select', props: { value: { $state: '/codec' } } },
  },
  state,
});

describe('resolveBindings', () => {
  it('passes when every bound pointer resolves against spec.state', () => {
    expect(resolveBindings(base({ codec: 'h264' }))).toEqual([]);
  });

  it('flags a binding that wires to nothing', () => {
    const issues = resolveBindings(base({}));
    expect(issues).toHaveLength(1);
    // noUncheckedIndexedAccess: destructure + optional-chain (sibling-test convention)
    const [issue] = issues;
    expect(issue?.code).toBe('unresolved_binding');
    expect(issue?.pointer).toBe('/codec');
    expect(issue?.elementKey).toBe('sel');
  });
});
