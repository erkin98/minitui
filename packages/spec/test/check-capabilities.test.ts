import { describe, it, expect } from 'vitest';
import { checkCapabilities } from '../src/semantic/check-capabilities.js';
import type { CapabilityProvider, FileStat } from '../src/capability-port.js';
import type { Spec } from '../src/spec-types.js';

const caps: CapabilityProvider = {
  listEncoders: async () => ['libx264', 'libx265'],
  listCodecs: async () => ['h264', 'hevc'],
  listFilters: async () => ['scale', 'overlay'],
  statFile: async (): Promise<FileStat> => ({ exists: true, readable: true, isFile: true }),
};

const spec = (state: Record<string, unknown>): Spec => ({
  root: 'f',
  elements: {
    f: { type: 'Box', props: {}, children: ['enc'] },
    enc: { type: 'Select', props: { encoder: { $state: '/encoder' } } },
  },
  state,
});

describe('checkCapabilities', () => {
  it('accepts an encoder the live ffmpeg supports', async () => {
    expect(await checkCapabilities(spec({ encoder: 'libx264' }), caps)).toEqual([]);
  });

  it('rejects an encoder absent from the live set', async () => {
    const issues = await checkCapabilities(spec({ encoder: 'libvpx-vp99' }), caps);
    expect(issues).toHaveLength(1);
    // noUncheckedIndexedAccess: destructure + optional-chain (sibling-test convention)
    const [issue] = issues;
    expect(issue?.code).toBe('missing_capability');
  });

  it('checks codec + filter props against their own live lists', async () => {
    const filterSpec: Spec = {
      root: 'f',
      elements: {
        f: { type: 'Box', props: {}, children: ['fx'] },
        fx: { type: 'Select', props: { codec: 'h264', filter: 'deshake' } },
      },
      state: {},
    };
    const issues = await checkCapabilities(filterSpec, caps);
    expect(issues).toHaveLength(1); // codec h264 ok; filter "deshake" not live
    const [issue] = issues;
    expect(issue?.code).toBe('missing_capability');
  });

  it("scans a codec carried in an action binding's params, not only element props", async () => {
    // The canonical MERGE_SPEC carries the codec under the merge Button's
    // on.press.params.codec (a $state binding), never an element `codec` prop —
    // scanning props alone would greenlight an unsupported codec (plan-17 gate RED).
    const paramSpec: Spec = {
      root: 'f',
      elements: {
        f: { type: 'Box', props: {}, children: ['merge'] },
        merge: {
          type: 'Button',
          props: { label: 'Merge' },
          on: { press: { action: 'run-merge', params: { codec: { $state: '/codec' } } } },
        },
      },
      state: { codec: 'av99-unreal' },
    };
    const issues = await checkCapabilities(paramSpec, caps);
    expect(issues).toHaveLength(1);
    const [issue] = issues;
    expect(issue?.code).toBe('missing_capability');
  });
});
