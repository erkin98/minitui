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
    pick: { type: 'FilePicker', props: { mode: 'file', value: { $state: '/inputs' } } },
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
    // The frozen catalog binds FilePicker.value two-way via $bindState;
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

describe('checkFiles: a marker whose pointer is not a string', () => {
  const pickerWith = (valueJson: string): Spec => {
    const built: Spec = JSON.parse(
      `{"root":"f","elements":{"f":{"type":"Box","props":{},"children":["pick"]},"pick":{"type":"FilePicker","props":{"value":${valueJson}}}},"state":{"5":["/never.mp4"]}}`,
    );
    return built;
  };

  it.each([['{"$state":5}'], ['{"$bindState":5}']])(
    'follows nothing and never asks the host about a file: %s',
    async (valueJson) => {
      let stats = 0;
      const caps = capsWith(() => {
        stats += 1;
        return { exists: true, readable: true, isFile: true };
      });
      expect(await checkFiles(pickerWith(valueJson), caps)).toEqual([]);
      expect(stats).toBe(0);
    },
  );
});

describe('checkFiles: unpicked values and the picker mode', () => {
  const recording = (stat: FileStat) => {
    const asked: string[] = [];
    const caps: CapabilityProvider = {
      ...capsWith(() => stat),
      statFile: async (path) => {
        asked.push(path);
        return stat;
      },
    };
    return { caps, asked };
  };
  const picker = (propsJson: string, stateJson = '{}'): Spec => {
    const built: Spec = JSON.parse(
      `{"root":"f","elements":{"f":{"type":"Box","props":{},"children":["pick"]},"pick":{"type":"FilePicker","props":${propsJson}}},"state":${stateJson}}`,
    );
    return built;
  };
  const dir: FileStat = { exists: true, readable: true, isFile: false };
  const file: FileStat = { exists: true, readable: true, isFile: true };
  const missing: FileStat = { exists: false, readable: false, isFile: false };
  const codes = async (spec: Spec, stat: FileStat) => {
    const { caps, asked } = recording(stat);
    return { codes: (await checkFiles(spec, caps)).map((i) => i.code), asked };
  };

  it('an empty value is not probed', async () => {
    const result = await codes(picker('{"value":""}'), missing);
    expect(result).toEqual({ codes: [], asked: [] });
  });

  it('a bound value that holds the empty string is not probed', async () => {
    const result = await codes(picker('{"value":{"$bindState":"/src"}}', '{"src":""}'), missing);
    expect(result).toEqual({ codes: [], asked: [] });
  });

  it('an empty member of a bound list is not probed, the others are', async () => {
    const result = await codes(
      picker('{"value":{"$state":"/src"}}', '{"src":["","a.mp4"]}'),
      missing,
    );
    expect(result).toEqual({ codes: ['missing_file'], asked: ['a.mp4'] });
  });

  it('mode dir accepts an existing directory', async () => {
    expect((await codes(picker('{"mode":"dir","value":"d"}'), dir)).codes).toEqual([]);
  });

  it('no mode accepts an existing directory and an existing file', async () => {
    expect((await codes(picker('{"value":"d"}'), dir)).codes).toEqual([]);
    expect((await codes(picker('{"value":"f"}'), file)).codes).toEqual([]);
  });

  it('mode file reports a directory as not_a_file', async () => {
    expect((await codes(picker('{"mode":"file","value":"d"}'), dir)).codes).toEqual(['not_a_file']);
  });

  it.each(['{"mode":"file","value":"x"}', '{"mode":"dir","value":"x"}', '{"value":"x"}'])(
    'a path that does not exist is missing_file whatever the mode: %s',
    async (propsJson) => {
      expect((await codes(picker(propsJson), missing)).codes).toEqual(['missing_file']);
    },
  );

  it('an unreadable path stays unreadable_file in every mode', async () => {
    const locked: FileStat = { exists: true, readable: false, isFile: true };
    for (const propsJson of ['{"mode":"dir","value":"x"}', '{"value":"x"}']) {
      expect((await codes(picker(propsJson), locked)).codes).toEqual(['unreadable_file']);
    }
  });

  it.each(['{"$state":5}', '{"$bindState":5}', '{"$state":null}'])(
    'a marker without a pointer string follows nothing: %s',
    async (valueJson) => {
      const result = await codes(picker(`{"value":${valueJson}}`), missing);
      expect(result).toEqual({ codes: [], asked: [] });
    },
  );
});
