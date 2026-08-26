import { describe, it, expect } from 'vitest';
import { validateSemantics } from '../src/semantic/semantic-validator.js';
import type { CapabilityProvider } from '../src/capability-port.js';
import type { Spec } from '../src/spec-types.js';

const caps: CapabilityProvider = {
  listEncoders: async () => ['libx264'],
  listCodecs: async () => ['h264'],
  listFilters: async () => ['scale'],
  statFile: async () => ({ exists: false, readable: false, isFile: false }),
};

const spec: Spec = {
  root: 'f',
  elements: {
    f: { type: 'Box', props: {}, children: ['pick', 'enc'] },
    pick: { type: 'FilePicker', props: { value: { $state: '/inputs' } } },
    enc: { type: 'Select', props: { encoder: 'libvpx-vp99' } },
  },
  state: { inputs: ['/nope.mp4'] }, // /inputs resolves; file is missing; encoder unsupported
};

describe('validateSemantics', () => {
  it('aggregates binding + capability + file issues and reports invalid', async () => {
    const r = await validateSemantics(spec, caps);
    expect(r.valid).toBe(false);
    expect(r.issues.map((i) => i.code).sort()).toEqual(['missing_capability', 'missing_file']);
  });

  it('reports valid for a clean spec', async () => {
    const clean: Spec = {
      root: 'f',
      elements: { f: { type: 'Box', props: {} } },
      state: {},
    };
    const r = await validateSemantics(clean, caps);
    expect(r).toEqual({ valid: true, issues: [] });
  });
});
