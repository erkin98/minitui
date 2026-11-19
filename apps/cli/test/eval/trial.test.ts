import { describe, it, expect } from 'vitest';
import { AgentSession, type ProviderRequest, type DirectProvider } from '@minitui/agent-core';
import type { RendererPort } from '@minitui/renderer-core';
import {
  REPAIR_HEADER,
  SEMANTIC_HEADER,
  type CapabilityProvider,
  type MiniAppSpec,
} from '@minitui/spec';
import { MAX_GEN_ATTEMPTS } from '../../src/generation.js';
import type { AppGraphDeps, MountedApp } from '../../src/graph-types.js';
import { keyRedactionPolicy } from '../../src/model-route.js';
import {
  fixedCapabilities,
  scriptedProvider,
  type ScriptedReply,
} from '../../eval/harness/scripted.js';
import {
  NON_OUTCOME_STOPS,
  RunAbort,
  TURN_DEADLINE_MESSAGE,
  createStepLog,
  graphDepsFor,
  recordingHost,
  runTrial,
  type AttemptHooks,
  type Usage,
} from '../../eval/harness/trial.js';
import { OUTPUT, recordingDiagnostics } from '../support/fakes.js';

const INTENT = 'merge two clips into one file';
const DIR = '/work/dir';
const USAGE: Usage = { inputTokens: 100, outputTokens: 20 };

const reply = (text: string, usage: Usage = USAGE): ScriptedReply => ({
  kind: 'text',
  text,
  usage,
});

// The patch lines of a merge app; each option breaks it in one way the loop reads as one class.
function mergeApp(over: { type?: string; codec?: string; extraKey?: string } = {}): string {
  const press = {
    action: 'merge',
    params: {
      inputs: { $state: '/inputs' },
      codec: { $state: '/codec' },
      output: { $state: '/output' },
    },
    ...(over.extraKey !== undefined ? { [over.extraKey]: 1 } : {}),
  };
  return [
    { op: 'add', path: '/root', value: 'go' },
    {
      op: 'add',
      path: '/elements/go',
      value: { type: over.type ?? 'Button', props: { label: 'Merge' }, on: { press } },
    },
    {
      op: 'add',
      path: '/state',
      value: {
        inputs: ['/abs/a.mp4', '/abs/b.mp4'],
        codec: over.codec ?? 'h264',
        output: OUTPUT,
        merge: { progress: 0, status: '' },
      },
    },
  ]
    .map((line) => JSON.stringify(line))
    .join('\n')
    .concat('\n');
}

const VALID = mergeApp();
// compiles whole (so the run reaches its finish) and has no root
const STRUCTURAL = VALID.split('\n').slice(1).join('\n');
const CATALOG = mergeApp({ type: 'Bogus' });
const SEMANTIC = mergeApp({ codec: 'libvpx-vp99' });

function trialDeps(
  provider: DirectProvider,
  log = createStepLog(recordingDiagnostics().diagnostics),
) {
  const deps = graphDepsFor({
    route: { provider, model: 'scripted-model' },
    workingDirectory: DIR,
    effort: 'high',
    diagnostics: log.port,
    redactionPolicy: keyRedactionPolicy('sk-test-only-key'),
    stderr: { write: () => {} },
    capabilities: fixedCapabilities(['h264']),
  });
  return { deps, log };
}

async function trial(
  replies: readonly ScriptedReply[],
  over: {
    timeoutMs?: number;
    hooks?: AttemptHooks;
    deps?: (deps: AppGraphDeps) => AppGraphDeps;
  } = {},
) {
  const requests: ProviderRequest[] = [];
  const diagnostics = recordingDiagnostics();
  const { deps, log } = trialDeps(
    scriptedProvider(replies, (r) => requests.push(r)),
    createStepLog(diagnostics.diagnostics),
  );
  const observation = await runTrial({
    intent: INTENT,
    deps: over.deps?.(deps) ?? deps,
    steps: log.steps,
    arm: 'high',
    timeoutMs: over.timeoutMs ?? 5000,
    now: () => performance.now(),
    hooks: over.hooks ?? null,
  });
  const harnessWarnings = diagnostics.records
    .filter((r) => r.level === 'warn' && r.msg === 'trial harness error')
    .map((r) => r.meta);
  return { observation, requests, harnessWarnings };
}

// Real hooks that note every call, so a row can see the attempt closed.
function notingHooks(refused = false): { hooks: AttemptHooks; calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    hooks: {
      start: (attempt) => {
        calls.push(`start ${attempt}`);
      },
      end: (attempt, usage) => {
        calls.push(`end ${attempt} ${usage?.outputTokens ?? 'none'}`);
        return { requests: 1, refused };
      },
    },
  };
}

describe('runTrial: the outcome of the real loop', () => {
  it('a valid first reply: stop valid, one attempt, the spec kept, its usage recorded', async () => {
    const { observation } = await trial([reply(VALID)]);
    expect(observation.stop).toBe('valid');
    expect(observation.attempts).toHaveLength(1);
    expect(observation.attempts[0]).toMatchObject({
      index: 1,
      reprompt: null,
      reply: VALID,
      failure: null,
      usage: USAGE,
      noUsage: null,
      steps: [],
      requests: 0,
      runError: null,
    });
    expect(observation.spec?.root).toBe('go');
    expect(observation.systemPrompt).toContain(JSON.stringify(DIR));
  });

  it.each([
    ['structural', STRUCTURAL],
    ['catalog', CATALOG],
    ['semantic', SEMANTIC],
  ] as const)(
    'invalid, then valid: two attempts, and the first is read as %s',
    async (failure, invalid) => {
      const second: Usage = { inputTokens: 300, outputTokens: 40 };
      const { observation, requests } = await trial([reply(invalid), reply(VALID, second)]);
      expect(observation.stop).toBe('valid');
      expect(observation.attempts.map((a) => a.failure)).toEqual([failure, null]);
      expect(observation.attempts.map((a) => a.usage)).toEqual([USAGE, second]);
      const reprompt = observation.attempts[1]?.reprompt ?? '';
      expect(reprompt.startsWith(`${REPAIR_HEADER}\n\n`)).toBe(true);
      // the text recorded is the one the loop sent: the regeneration prompt ends with it
      expect(requests[1]?.messages.at(-1)?.content.endsWith(reprompt)).toBe(true);
    },
  );

  it('a structural failure whose issue line quotes a key that spells the semantic header is structural', async () => {
    const { observation } = await trial([
      reply(mergeApp({ extraKey: SEMANTIC_HEADER })),
      reply(VALID),
    ]);
    const reprompt = observation.attempts[1]?.reprompt ?? '';
    expect(reprompt).toContain(`unexpected key "${SEMANTIC_HEADER}"`);
    expect(observation.attempts[0]?.failure).toBe('structural');
  });

  it('a structural failure on a key that holds the semantic header between blank lines is structural', async () => {
    const key = `\n\n${SEMANTIC_HEADER}\n`;
    expect(key.length).toBeLessThan(64);
    const { observation } = await trial([reply(mergeApp({ extraKey: key })), reply(VALID)]);
    const reprompt = observation.attempts[1]?.reprompt ?? '';
    expect(reprompt).toContain(`unexpected key "${key}"`);
    expect(observation.attempts[0]?.failure).toBe('structural');
  });

  it('six invalid replies: every attempt is used, stop exhausted, the last class from the last envelope', async () => {
    const replies = [...Array<string>(5).fill(STRUCTURAL), SEMANTIC].map((text) => reply(text));
    const { observation } = await trial(replies);
    expect(observation.attempts).toHaveLength(MAX_GEN_ATTEMPTS);
    expect(observation.stop).toBe('exhausted');
    expect(observation.attempts.map((a) => a.failure)).toEqual([
      ...Array<string>(5).fill('structural'),
      'semantic',
    ]);
    expect(observation.spec).toBeNull();
  });

  it('a finish that reports no usage: usage null, noUsage unreported', async () => {
    const { observation } = await trial([{ kind: 'text', text: VALID, usage: null }]);
    expect(observation.stop).toBe('valid');
    expect(observation.attempts[0]).toMatchObject({ usage: null, noUsage: 'unreported' });
  });

  it('a non-retriable error chunk: stop provider-error, the message recorded', async () => {
    const { observation } = await trial([
      { kind: 'error', message: 'the model is overloaded', retriable: false },
    ]);
    expect(observation.stop).toBe('provider-error');
    expect(observation.attempts).toHaveLength(1);
    expect(observation.attempts[0]).toMatchObject({
      failure: null,
      usage: null,
      noUsage: 'run-error',
      runError: { message: 'the model is overloaded', code: 'non-retriable', retriable: false },
    });
  });

  it('a reply that never ends, past a 50 ms trial limit: stop timeout, the attempt closed', async () => {
    const { hooks, calls } = notingHooks();
    const { observation } = await trial([{ kind: 'never-ends' }], { timeoutMs: 50, hooks });
    expect(observation.stop).toBe('timeout');
    // the end call is the close itself: the fields below are also what an unclosed attempt holds
    expect(calls).toEqual(['start 1', 'end 1 none']);
    expect(observation.attempts).toHaveLength(1);
    expect(observation.attempts[0]).toMatchObject({
      failure: null,
      usage: null,
      noUsage: 'consumer-closed',
    });
  });

  // Only the session's own deadline is shortened, through the graph's own seam; the deps the cli check
  // compares are untouched. Both rows share it: wide enough for the in-time turn on a loaded machine,
  // short enough that the deadline row waits half a second.
  const SHORT_TURN_MS = 500;
  const shortTurn = (deps: AppGraphDeps): AppGraphDeps => ({
    ...deps,
    makeSession: (w) =>
      new AgentSession({ ...w, config: { ...w.config, turnTimeoutMs: SHORT_TURN_MS } }),
  });

  it("a reply that never ends, past the session's own turn deadline: stop turn-deadline, a fail", async () => {
    const { observation } = await trial([{ kind: 'never-ends' }], {
      timeoutMs: 5000,
      deps: shortTurn,
    });
    expect(observation.stop).toBe('turn-deadline');
    expect(NON_OUTCOME_STOPS).not.toContain('turn-deadline');
    expect(observation.attempts[0]).toMatchObject({
      usage: null,
      noUsage: 'deadline',
      runError: { message: TURN_DEADLINE_MESSAGE, retriable: false },
    });
  });

  it('the same short turn with the reply in time: stop valid', async () => {
    const { observation } = await trial([reply(VALID)], { timeoutMs: 5000, deps: shortTurn });
    expect(observation.stop).toBe('valid');
  });

  it('an attempt the meter refused: stop spend-cap, the hooks called around the attempt', async () => {
    const { hooks, calls } = notingHooks(true);
    const { observation } = await trial([reply(VALID)], { hooks });
    expect(observation.stop).toBe('spend-cap');
    expect(calls).toEqual(['start 1', 'end 1 20']);
    expect(observation.attempts[0]?.requests).toBe(1);
  });
});

describe('runTrial: a failure of the harness, not of the model', () => {
  it('a host probe that fails: stop harness-error', async () => {
    const broken: CapabilityProvider = {
      listEncoders: () => Promise.reject(new Error('the probe failed')),
      listCodecs: () => Promise.reject(new Error('the probe failed')),
      listFilters: () => Promise.reject(new Error('the probe failed')),
      statFile: () => Promise.reject(new Error('the probe failed')),
    };
    const { observation, harnessWarnings } = await trial([reply(VALID)], {
      deps: (deps) => ({ ...deps, capabilities: broken }),
    });
    expect(observation.stop).toBe('harness-error');
    expect(observation.attempts).toHaveLength(1);
    expect(observation.spec).toBeNull();
    expect(harnessWarnings).toEqual([{ stage: 'run', message: 'the probe failed' }]);
  });

  // The graph's own sandbox seam, failing as a real one can: the build rejects before any attempt.
  const failingBuild =
    (error: Error) =>
    (deps: AppGraphDeps): AppGraphDeps => ({
      ...deps,
      createSandbox: () => Promise.reject(error),
    });

  it('a graph that cannot be built: stop harness-error, and no request is sent', async () => {
    const { observation, requests, harnessWarnings } = await trial([reply(VALID)], {
      deps: failingBuild(new Error('the sandbox could not be built')),
    });
    expect(harnessWarnings).toEqual([
      { stage: 'build', message: 'the sandbox could not be built' },
    ]);
    expect(observation).toMatchObject({
      stop: 'harness-error',
      attempts: [],
      spec: null,
      systemPrompt: '',
    });
    expect(requests).toHaveLength(0);
  });

  it('a run abort thrown while the graph is built still ends the whole run', async () => {
    await expect(
      trial([reply(VALID)], { deps: failingBuild(new RunAbort('the spend guard tripped')) }),
    ).rejects.toBeInstanceOf(RunAbort);
  });
});

describe('runTrial: a run abort from the spend hooks', () => {
  // One abort object, so a row can tell the run's own error from a copy.
  const abort = new RunAbort('the spend guard tripped');
  const throwingFrom = (where: 'start' | 'end'): AttemptHooks => ({
    start: () => {
      if (where === 'start') throw abort;
    },
    end: () => {
      if (where === 'end') throw abort;
      return { requests: 1, refused: false };
    },
  });

  // The trial's promise and the requests the model has seen: both stay readable when the trial rejects.
  function startTrial(replies: readonly ScriptedReply[], hooks: AttemptHooks, timeoutMs = 5000) {
    const requests: ProviderRequest[] = [];
    const { deps, log } = trialDeps(scriptedProvider(replies, (r) => requests.push(r)));
    const result = runTrial({
      intent: INTENT,
      deps,
      steps: log.steps,
      arm: 'high',
      timeoutMs,
      now: () => performance.now(),
      hooks,
    });
    return { result, requests };
  }

  it('thrown by end on a trial the timeout cancels: the trial rejects with that abort, not a timeout', async () => {
    const { result, requests } = startTrial([{ kind: 'never-ends' }], throwingFrom('end'), 50);
    await expect(result).rejects.toBe(abort);
    expect(requests).toHaveLength(1);
  });

  it('thrown by end on a run that is not cancelled: the run ends there, before its next attempt', async () => {
    const { result, requests } = startTrial([reply(STRUCTURAL), reply(VALID)], throwingFrom('end'));
    await expect(result).rejects.toBe(abort);
    expect(requests).toHaveLength(1);
  });

  it('thrown by start: the trial rejects with that abort, and the attempt never reaches the model', async () => {
    const { result, requests } = startTrial([reply(VALID)], throwingFrom('start'));
    await expect(result).rejects.toBe(abort);
    expect(requests).toHaveLength(0);
  });

  it('the control: hooks that throw nothing end the same trials with their own stops, run to the end', async () => {
    const cancelled = startTrial([{ kind: 'never-ends' }], notingHooks().hooks, 50);
    expect((await cancelled.result).stop).toBe('timeout');
    const whole = startTrial([reply(STRUCTURAL), reply(VALID)], notingHooks().hooks);
    expect((await whole.result).stop).toBe('valid');
    expect(whole.requests).toHaveLength(2);
  });

  it('any other error a hook throws is not a run abort: the trial is a harness error', async () => {
    const broken: AttemptHooks = {
      start: () => {},
      end: () => {
        throw new Error('the meter broke');
      },
    };
    const { observation, harnessWarnings } = await trial([reply(VALID)], { hooks: broken });
    expect(observation.stop).toBe('harness-error');
    expect(harnessWarnings).toEqual([{ stage: 'run', message: 'the meter broke' }]);
  });
});

describe('runTrial: what the eval leaves alone', () => {
  it('the sandbox handle is inactive and the renderer is never mounted', async () => {
    let mounts = 0;
    const counted = (deps: AppGraphDeps): AppGraphDeps => {
      const renderer = deps.renderer;
      const counting: RendererPort = {
        mount: (args) => {
          mounts += 1;
          return renderer === undefined
            ? Promise.reject(new Error('no renderer'))
            : renderer.mount(args);
        },
      };
      return { ...deps, renderer: counting };
    };
    const { observation } = await trial([reply(VALID)], { deps: counted });
    expect(observation.stop).toBe('valid');
    expect(mounts).toBe(0);
    const sandbox = await trialDeps(scriptedProvider([])).deps.createSandbox?.();
    expect(sandbox?.active).toBe(false);
    await sandbox?.dispose();
  });

  it('the recording mount is a whole mounted app that ends at once and takes no repair', async () => {
    const spec: MiniAppSpec = { root: 'r', elements: {}, state: {} };
    const kept: MiniAppSpec[] = [];
    const app: MountedApp = await recordingHost((s) => kept.push(s)).mount(spec);
    expect(kept).toEqual([spec]);
    expect(await app.done).toEqual({ status: 'completed', exitCode: 0 });
    expect(() => app.updateSpec(spec)).toThrow('the eval applies no repair');
  });
});

describe('createStepLog', () => {
  it('keeps every model step record and forwards every record', () => {
    const next = recordingDiagnostics();
    const log = createStepLog(next.diagnostics);
    log.port.debug('model step', { effort: 'high', modelId: 'model-a' });
    log.port.debug('other', { effort: 'low', modelId: 'model-b' });
    log.port.warn('model step', { effort: 'low', modelId: 'model-c' });
    log.port.debug('model step', { effort: 1 });
    expect(log.steps()).toEqual([{ effort: 'high', modelId: 'model-a' }]);
    expect(next.records.map((r) => `${r.level} ${r.msg}`)).toEqual([
      'debug model step',
      'debug other',
      'warn model step',
      'debug model step',
    ]);
  });
});
