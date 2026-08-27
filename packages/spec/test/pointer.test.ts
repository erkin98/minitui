import { describe, it, expect } from 'vitest';
import { collectBoundPointers, getByPath } from '../src/pointer.js';
import { resolveBindings } from '../src/semantic/resolve-bindings.js';
import type { Spec } from '../src/spec-types.js';

const spec: Spec = {
  root: 'form',
  elements: {
    form: { type: 'Box', props: {}, children: ['codecSel', 'list'] },
    codecSel: {
      type: 'Select',
      props: { value: { $state: '/codec' } },
      watch: { '/codec': { action: 'onCodecChange' } },
    },
    list: { type: 'OrderList', props: {}, repeat: { statePath: '/inputs' } },
  },
  state: { codec: 'h264', inputs: [] },
};

describe('collectBoundPointers', () => {
  it('collects $state props, repeat statePath, and watch keys with provenance', () => {
    const bound = collectBoundPointers(spec);
    const pairs = bound.map((b) => [b.pointer, b.source]).sort();
    expect(pairs).toEqual([
      ['/codec', 'prop'],
      ['/codec', 'watch'],
      ['/inputs', 'repeat'],
    ]);
  });

  it('re-exports getByPath for RFC-6901 reads', () => {
    expect(getByPath({ a: { b: 1 } }, '/a/b')).toBe(1);
  });

  it('collects a $bindState prop pointer so a mistyped two-way bind is caught', () => {
    // FilePicker/Select bind their value two-way with $bindState; both $state and
    // $bindState hold a JSON-Pointer into state, so both must be collected or an
    // unresolved $bindState pointer renders blank and never errors at runtime.
    const s: Spec = {
      root: 'r',
      elements: { r: { type: 'Select', props: { items: { $bindState: '/inptus' } } } },
      state: { inputs: [] },
    };
    expect(collectBoundPointers(s).map((b) => b.pointer)).toContain('/inptus');
    const issues = resolveBindings(s);
    expect(issues.some((i) => i.code === 'unresolved_binding' && i.pointer === '/inptus')).toBe(
      true,
    );
  });

  it('walks $state/$bindState nested inside objects and arrays', () => {
    const s: Spec = {
      root: 'r',
      elements: {
        r: {
          type: 'Box',
          props: {
            cfg: { deep: { $bindState: '/a/missing' } },
            rows: [{ label: { $state: '/b/missing' } }],
          },
        },
      },
      state: {},
    };
    const ptrs = collectBoundPointers(s)
      .map((b) => b.pointer)
      .sort();
    expect(ptrs).toEqual(['/a/missing', '/b/missing']);
  });
});
