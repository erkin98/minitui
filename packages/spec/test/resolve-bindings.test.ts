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

describe('resolveBindings: own properties and strict indices', () => {
  const rows = { rows: ['a', 'b'] };
  const bound = (pointer: string, state: Record<string, unknown> = rows): Spec => {
    const built: Spec = JSON.parse(
      `{"root":"f","elements":{"f":{"type":"Box","props":{"v":{"$state":${JSON.stringify(pointer)}}}}},"state":{}}`,
    );
    return { ...built, state };
  };
  const repeating = (statePath: string, state: Record<string, unknown>): Spec => {
    const built: Spec = JSON.parse(
      `{"root":"f","elements":{"f":{"type":"Box","props":{},"repeat":{"statePath":${JSON.stringify(statePath)}}}},"state":{}}`,
    );
    return { ...built, state };
  };

  it.each(['/toString', '/constructor', '/hasOwnProperty', '/rows/01', '/rows/1e0', '/rows/ 0'])(
    'the pointer %s does not resolve',
    (pointer) => {
      const issues = resolveBindings(bound(pointer));
      expect(issues.map((i) => [i.code, i.pointer])).toEqual([['unresolved_binding', pointer]]);
    },
  );

  it.each(['/rows/1', '/rows'])('control: the pointer %s resolves', (pointer) => {
    expect(resolveBindings(bound(pointer))).toEqual([]);
  });

  it('a repeat target that is a string is unresolved', () => {
    const issues = resolveBindings(repeating('/codec', { codec: 'h264' }));
    expect(issues.map((i) => [i.code, i.pointer])).toEqual([['unresolved_binding', '/codec']]);
  });

  it('a repeat target that is an array resolves', () => {
    expect(resolveBindings(repeating('/inputs', { inputs: [] }))).toEqual([]);
  });

  it('a repeat target through the prototype is unresolved', () => {
    expect(resolveBindings(repeating('/toString', {})).map((i) => i.code)).toEqual([
      'unresolved_binding',
    ]);
  });
});
