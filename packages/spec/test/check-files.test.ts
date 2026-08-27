import { describe, it, expect } from 'vitest';
import { checkFiles } from '../src/semantic/check-files.js';
import type { CapabilityProvider, FileStat } from '../src/capability-port.js';
import type { Spec } from '../src/spec-types.js';

const capsWith = (stat: (p: string) => FileStat): CapabilityProvider => ({
  listEncoders: async () => [],
  listCodecs: async () => [],
  listFilters: async () => [],
  statFile: async (p) => stat(p),
});

const spec = (inputs: string[]): Spec => ({
  root: 'f',
  elements: {
    f: { type: 'Box', props: {}, children: ['pick'] },
    pick: { type: 'FilePicker', props: { value: { $state: '/inputs' } } },
  },
  state: { inputs },
});

describe('checkFiles', () => {
  it('passes when every picked path is real and readable', async () => {
    const caps = capsWith(() => ({ exists: true, readable: true, isFile: true }));
    expect(await checkFiles(spec(['/a.mp4', '/b.mp4']), caps)).toEqual([]);
  });

  it('flags a missing file and an unreadable file distinctly', async () => {
    const caps = capsWith((p) =>
      p === '/missing.mp4'
        ? { exists: false, readable: false, isFile: false }
        : { exists: true, readable: false, isFile: true },
    );
    const issues = await checkFiles(spec(['/missing.mp4', '/locked.mp4']), caps);
    expect(issues.map((i) => i.code).sort()).toEqual(['missing_file', 'unreadable_file']);
  });

  it('resolves the catalog-canonical $bindState FilePicker binding, not only $state', async () => {
    // The frozen catalog binds FilePicker.value two-way via $bindState (plan 06:2048);
    // the moat must stat that path or it never bites for a real FilePicker.
    const bindStateSpec: Spec = {
      root: 'f',
      elements: {
        f: { type: 'Box', props: {}, children: ['pick'] },
        pick: { type: 'FilePicker', props: { value: { $bindState: '/inputs' } } },
      },
      state: { inputs: ['/missing.mp4'] },
    };
    const caps = capsWith(() => ({ exists: false, readable: false, isFile: false }));
    const issues = await checkFiles(bindStateSpec, caps);
    expect(issues.map((i) => i.code)).toEqual(['missing_file']);
  });

  it('flags a readable directory as not_a_file (neither missing nor unreadable fits)', async () => {
    // A picked path that exists and is readable but is a directory would mislead
    // if reported as missing_file or unreadable_file; the reprompt needs its own code.
    const caps = capsWith(() => ({ exists: true, readable: true, isFile: false }));
    const issues = await checkFiles(spec(['/some/dir']), caps);
    expect(issues.map((i) => i.code)).toEqual(['not_a_file']);
  });
});
