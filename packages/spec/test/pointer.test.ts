import { describe, it, expect } from 'vitest';
import { collectBoundPointers, getByPath } from '../src/pointer.js';
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
});
