import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { createMockProvider, createSpecSink, createVisibilityChannel } from '@minitui/agent-core';
import type { AppGraphDeps, CliGraph } from '../src/graph-types.js';
import { createGenerationContext } from '../src/generation.js';
import { DEFAULT_MODEL, VERSION, cliMain, type CliBootApi, type CliDeps } from '../src/index.js';
import { recordingDiagnostics } from './support/fakes.js';

const KEY = 'sk-ant-test-0123456789abcdefghijklmnop';
const CSI = String.fromCharCode(0x9b);
const ESC = String.fromCharCode(27);

interface Harness {
  deps: CliDeps;
  out: string[];
  err: string[];
  events: string[];
  built: AppGraphDeps[];
  logLines: string[];
  scrub: () => (line: string) => string;
  formatCrash: () => (text: string) => string;
  cancelHook: () => (() => void) | undefined;
}

// Real implementations of the entry's seams: a boot API that records what the entry does with the terminal
// and the log, a light graph and an injected run.
function harness(
  over: {
    interactive?: boolean;
    env?: NodeJS.ProcessEnv;
    run?: CliDeps['runApp'];
    notice?: string;
    dispose?: () => Promise<void>;
  } = {},
): Harness {
  const out: string[] = [];
  const err: string[] = [];
  const events: string[] = [];
  const built: AppGraphDeps[] = [];
  const logLines: string[] = [];
  let scrub: (line: string) => string = (line) => line;
  let formatCrash: (text: string) => string = (text) => text;
  let hook: (() => void) | undefined;
  const diag = recordingDiagnostics();
  const boot: CliBootApi = {
    detectEnv: () => ({ isInteractive: over.interactive ?? true, logPath: '/log/minitui.log' }),
    openLogFile: () => ({
      write: (line) => {
        logLines.push(line);
      },
      close: () => {
        events.push('log.close');
      },
    }),
    createFileDiagnostics: (_log, given) => {
      if (given !== undefined) scrub = given;
      return diag.diagnostics;
    },
    registerTerminalRestore: (options) => {
      formatCrash = options.formatCrash;
      return {
        restore: () => {
          events.push('restore');
        },
        markAltScreen: () => {},
        onBeforeExit: (next) => {
          hook = next;
        },
      };
    },
  };
  const graph: CliGraph = {
    host: { mount: () => Promise.reject(new Error('not mounted here')) },
    agentPort: {
      run: () => {
        throw new Error('not run here');
      },
    },
    session: { emitSpec: (spec) => ({ type: 'ACTIVITY_SNAPSHOT', spec }) },
    mountStatus: () => ({ update: () => {}, unmount: () => {} }),
    validate: () => Promise.reject(new Error('not validated here')),
    diagnostics: diag.diagnostics,
    stderr: { write: () => {} },
    cancelled: () => false,
    bindHostSession: () => {},
    generation: createGenerationContext(),
    cancel: () => {
      events.push('cancel');
    },
    sandboxNotice: over.notice,
    dispose:
      over.dispose ??
      (() => {
        events.push('dispose');
        return Promise.resolve();
      }),
  };
  const deps: CliDeps = {
    out: (line) => out.push(line),
    err: (line) => err.push(line),
    env: over.env ?? { ANTHROPIC_API_KEY: KEY },
    boot,
    buildAppGraph: (given) => {
      built.push(given);
      return Promise.resolve(graph);
    },
    runApp: over.run ?? (() => Promise.resolve(0)),
  };
  return {
    deps,
    out,
    err,
    events,
    built,
    logLines,
    scrub: () => scrub,
    formatCrash: () => formatCrash,
    cancelHook: () => hook,
  };
}

describe('cliMain: the ways out before anything is built', () => {
  it('--version prints the version and exits 0 without touching the terminal, the log or the graph', async () => {
    const h = harness();
    expect(await cliMain(['--version'], h.deps)).toBe(0);
    expect(h.out).toEqual([VERSION]);
    expect(h.built).toEqual([]);
    expect(h.events).toEqual([]);
  });

  it('the version is the one in the manifest', () => {
    const manifest: unknown = JSON.parse(
      readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
    );
    const declared =
      typeof manifest === 'object' && manifest !== null
        ? Reflect.get(manifest, 'version')
        : undefined;
    expect(VERSION).toBe(declared);
    expect(VERSION).toMatch(/^\d+\.\d+\.\d+/);
  });

  it('--help prints the usage and exits 0', async () => {
    const h = harness();
    expect(await cliMain(['--help'], h.deps)).toBe(0);
    expect(h.out.join('\n')).toContain('usage: minitui');
    expect(h.out.join('\n')).toContain(DEFAULT_MODEL);
    expect(h.built).toEqual([]);
  });

  it('an unknown flag is a usage error: exit 2 with the usage, nothing built', async () => {
    const h = harness();
    expect(await cliMain(['--accesible', 'merge'], h.deps)).toBe(2);
    expect(h.err.join('\n')).toContain('--accesible');
    expect(h.err.join('\n')).toContain('usage: minitui');
    expect(h.built).toEqual([]);
  });

  it('a missing API key fails closed with exit 1 before anything is built', async () => {
    const h = harness({ env: {} });
    expect(await cliMain(['merge'], h.deps)).toBe(1);
    expect(h.err.join('\n')).toContain('ANTHROPIC_API_KEY is not set');
    expect(h.built).toEqual([]);
    expect(h.events).toEqual([]);
  });

  it('an empty API key counts as missing', async () => {
    const h = harness({ env: { ANTHROPIC_API_KEY: '' } });
    expect(await cliMain(['merge'], h.deps)).toBe(1);
    expect(h.built).toEqual([]);
  });

  it('a session without a terminal fails with exit 1 before the log is opened or anything is built', async () => {
    const h = harness({ interactive: false });
    expect(await cliMain(['merge'], h.deps)).toBe(1);
    expect(h.err.join('\n')).toContain('requires an interactive terminal');
    expect(h.built).toEqual([]);
    expect(h.events).toEqual([]);
  });
});

describe('cliMain: a run', () => {
  it('builds the graph from the arguments, runs it and returns the code of the run', async () => {
    const h = harness({ run: () => Promise.resolve(130) });
    expect(await cliMain(['--yolo', '--accessible', 'merge'], h.deps)).toBe(130);
    expect(h.built).toHaveLength(1);
    expect(h.built[0]).toMatchObject({ mode: 'yolo', accessible: true });
  });

  it('hands the run the parsed arguments and the graph it built', async () => {
    let seen: { intent: string } | undefined;
    const h = harness({
      run: (args) => {
        seen = args;
        return Promise.resolve(0);
      },
    });
    await cliMain(['merge', 'my', 'clips'], h.deps);
    expect(seen?.intent).toBe('merge my clips');
  });

  it('tears down in order: cancel the run, wait for the sandbox, restore the terminal, close the log', async () => {
    const h = harness();
    await cliMain(['merge'], h.deps);
    expect(h.events).toEqual(['cancel', 'dispose', 'restore', 'log.close']);
  });

  it('wires the run graph cancel to the terminal restore, so a signal stops the run first', async () => {
    const h = harness();
    await cliMain(['merge'], h.deps);
    h.events.length = 0;
    h.cancelHook()?.();
    expect(h.events).toEqual(['cancel']);
  });

  it('announces an inactive sandbox once, in one line', async () => {
    const h = harness({ notice: 'gated actions are unavailable: no bubblewrap' });
    await cliMain(['merge'], h.deps);
    expect(h.err).toEqual(['minitui: gated actions are unavailable: no bubblewrap']);
  });

  it('says nothing about the sandbox when it is active', async () => {
    const h = harness();
    await cliMain(['merge'], h.deps);
    expect(h.err).toEqual([]);
  });

  it('an error in the run is shown cleaned, logged, and ends in exit 1 after the full teardown', async () => {
    const h = harness({
      run: () => Promise.reject(new Error(`boom ${CSI}2J with ${KEY}`)),
    });
    expect(await cliMain(['merge'], h.deps)).toBe(1);
    const shown = h.err.join('\n');
    expect(shown).toContain('boom');
    expect(shown).not.toContain(CSI);
    expect(shown).not.toContain(KEY);
    expect(h.events).toEqual(['cancel', 'dispose', 'restore', 'log.close']);
  });

  it('a failing sandbox release does not change the exit code', async () => {
    const h = harness({ dispose: () => Promise.reject(new Error('release failed')) });
    expect(await cliMain(['merge'], h.deps)).toBe(0);
    expect(h.events).toEqual(['cancel', 'restore', 'log.close']);
  });
});

describe('cliMain: the model', () => {
  const modelOf = (h: Harness): unknown => Reflect.get(h.built[0]?.model ?? {}, 'modelId');

  it('is the default, the environment variable or the flag, in that order of precedence', async () => {
    const plain = harness();
    await cliMain(['merge'], plain.deps);
    expect(modelOf(plain)).toBe(DEFAULT_MODEL);
    const env = harness({ env: { ANTHROPIC_API_KEY: KEY, MINITUI_MODEL: 'from-env' } });
    await cliMain(['merge'], env.deps);
    expect(modelOf(env)).toBe('from-env');
    const flag = harness({ env: { ANTHROPIC_API_KEY: KEY, MINITUI_MODEL: 'from-env' } });
    await cliMain(['--model', 'from-flag', 'merge'], flag.deps);
    expect(modelOf(flag)).toBe('from-flag');
  });

  it('hands the graph the working directory, the process one unless a test passes another', async () => {
    const given = harness();
    await cliMain(['merge'], { ...given.deps, cwd: '/home/u/clips' });
    expect(given.built[0]?.workingDirectory).toBe('/home/u/clips');
    const plain = harness();
    await cliMain(['merge'], plain.deps);
    expect(plain.built[0]?.workingDirectory).toBe(process.cwd());
  });

  it('defaults to the current Sonnet, so a fresh run never names a retiring model', async () => {
    const plain = harness();
    await cliMain(['merge'], plain.deps);
    expect(modelOf(plain)).toBe('claude-sonnet-5-5');
  });
});

describe('cliMain: the API key stays out of everything it writes', () => {
  it('is removed from every line the log sink writes, and the control character with it', async () => {
    const h = harness();
    await cliMain(['merge'], h.deps);
    const scrubbed = h.scrub()(`{"msg":"x","detail":"Bearer ${KEY} ${CSI}2J"}`);
    expect(scrubbed).not.toContain(KEY);
    expect(scrubbed).not.toContain(CSI);
  });

  it('is removed from the text of a crash before it reaches the terminal', async () => {
    const h = harness();
    await cliMain(['merge'], h.deps);
    const shown = h.formatCrash()(`Error: bad ${ESC}[2J ${KEY} ${'x'.repeat(10_000)}`);
    expect(shown).not.toContain(KEY);
    expect(shown).not.toContain(ESC);
    expect(shown.length).toBeLessThanOrEqual(4000);
  });

  it('is in the redaction policy the session and the provider are built with', async () => {
    const h = harness();
    await cliMain(['merge'], h.deps);
    const patterns = h.built[0]?.redactionPolicy?.extraSecretPatterns ?? [];
    const text = `request failed for ${KEY}`;
    const cleaned = patterns.reduce(
      (acc, p) => acc.replace(new RegExp(p.source, p.flags), 'X'),
      text,
    );
    expect(cleaned).not.toContain(KEY);
  });

  it('an API key with regular-expression characters still matches exactly', async () => {
    const odd = 'sk-a.b*c+d(e)[f]';
    const h = harness({ env: { ANTHROPIC_API_KEY: odd } });
    await cliMain(['merge'], h.deps);
    const patterns = h.built[0]?.redactionPolicy?.extraSecretPatterns ?? [];
    const cleaned = patterns.reduce(
      (acc, p) => acc.replace(new RegExp(p.source, p.flags), 'X'),
      `with ${odd} and sk-aXbYc`,
    );
    expect(cleaned).toBe('with X and sk-aXbYc');
  });
});

describe('cliMain: the session', () => {
  it('is built by the factory it hands the graph, on the wiring the graph gives it', async () => {
    const h = harness();
    await cliMain(['merge'], h.deps);
    const session = h.built[0]?.makeSession({
      provider: createMockProvider({ script: [] }),
      toolDispatch: { dispatch: () => Promise.reject(new Error('not used')) },
      specSink: createSpecSink(),
      visibility: createVisibilityChannel({}),
      tools: [],
      model: 'test-model',
    });
    expect(typeof session?.submit).toBe('function');
    expect(typeof session?.cancel).toBe('function');
  });
});
