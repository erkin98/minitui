import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  AgentSession,
  EFFORTS,
  createSpecSink,
  createVisibilityChannel,
  isSdkLoopRoute,
  type ModelRoute,
  type ProviderRequest,
  type SdkLoopRoute,
} from '@minitui/agent-core';
import { buildCatalogPrompt, videoMergeCatalog } from '@minitui/catalog';
import type { WidgetCatalogBinding } from '@minitui/renderer-core';
import { noopDiagnostics } from '@minitui/types';
import { composeRegenerationPrompt, composeSystemPrompt } from '../../src/generation.js';
import type { AppGraphDeps, SessionDeps } from '../../src/graph-types.js';
import { DEFAULT_MODEL, cliMain, type CliBootApi } from '../../src/index.js';
import { cleaner, createModelRoute, keyRedactionPolicy } from '../../src/model-route.js';
import { fixedCapabilities, scriptedProvider } from '../../eval/harness/scripted.js';
import { createStepLog, graphDepsFor, runTrial } from '../../eval/harness/trial.js';
import { OUTPUT, recordingDiagnostics } from '../support/fakes.js';

const KEY = 'sk-ant-test-0123456789abcdefghijklmnop';
const ESC = String.fromCharCode(27);
const DIR = '/work/dir';
const EVAL_DIR = fileURLToPath(new URL('../../eval/', import.meta.url));

// Real implementations of the entry's boot seams: an interactive terminal, a log that keeps nothing.
const boot: CliBootApi = {
  detectEnv: () => ({ isInteractive: true, logPath: '/log/minitui.log' }),
  openLogFile: () => ({ write: () => {}, close: () => {} }),
  createFileDiagnostics: () => recordingDiagnostics().diagnostics,
  registerTerminalRestore: () => ({
    restore: () => {},
    markAltScreen: () => {},
    onBeforeExit: () => {},
  }),
};

// The cli's own run up to the graph: the deps it builds and the lines it prints. The graph is never built.
async function cliDeps(failure: Error): Promise<{ built: AppGraphDeps[]; err: string[] }> {
  const built: AppGraphDeps[] = [];
  const err: string[] = [];
  await cliMain(['--effort', 'high', 'merge two clips'], {
    out: () => {},
    err: (line) => err.push(line),
    env: { ANTHROPIC_API_KEY: KEY },
    cwd: DIR,
    boot,
    buildAppGraph: (deps) => {
      built.push(deps);
      return Promise.reject(failure);
    },
  });
  return { built, err };
}

function sdkRoute(route: ModelRoute): SdkLoopRoute {
  if (!isSdkLoopRoute(route)) throw new Error('not an SDK-loop route');
  return route;
}

const componentsOf = (binding: WidgetCatalogBinding): string[] =>
  [...videoMergeCatalog.componentDefs.keys()].filter((name) => binding.resolve(name) !== undefined);

const patternsOf = (deps: AppGraphDeps): string[][] =>
  (deps.redactionPolicy?.extraSecretPatterns ?? []).map((p) => [p.source, p.flags]);

describe('the eval and the cli build the same run', () => {
  it('(a) the eval passes every key the cli passes, the route included, and adds only its four', async () => {
    const { built } = await cliDeps(new Error('the graph is not built here'));
    const cli = built[0];
    if (cli === undefined) throw new Error('the cli built no deps');
    const diagnostics = recordingDiagnostics().diagnostics;
    const redactionPolicy = keyRedactionPolicy(KEY);
    const evalDeps = graphDepsFor({
      route: createModelRoute({
        apiKey: KEY,
        modelId: DEFAULT_MODEL,
        diagnostics,
        redactionPolicy,
      }),
      workingDirectory: DIR,
      effort: 'high',
      diagnostics,
      redactionPolicy,
      stderr: { write: () => {} },
      capabilities: fixedCapabilities([]),
    });

    const cliKeys = Object.keys(cli);
    const evalKeys = Object.keys(evalDeps);
    expect(cliKeys.filter((key) => !evalKeys.includes(key))).toEqual([]);
    expect(evalKeys.filter((key) => !cliKeys.includes(key)).sort()).toEqual([
      'capabilities',
      'createSandbox',
      'renderer',
      'stderr',
    ]);

    const plain = (d: AppGraphDeps) => [d.mode, d.accessible, d.workingDirectory, d.effort];
    expect(plain(evalDeps)).toEqual(plain(cli));
    expect(evalDeps.binding.catalogId).toBe(cli.binding.catalogId);
    expect(componentsOf(evalDeps.binding)).toEqual(componentsOf(cli.binding));
    expect(componentsOf(cli.binding).length).toBeGreaterThan(0);

    const cliRoute = sdkRoute(cli.route);
    const evalRoute = sdkRoute(evalDeps.route);
    expect(evalRoute.provider.id).toBe(cliRoute.provider.id);
    expect(evalRoute.provider.sdkCallOptions({})).toEqual(cliRoute.provider.sdkCallOptions({}));
    for (const effort of EFFORTS) {
      expect(evalRoute.provider.sdkCallOptions({ effort })).toEqual(
        cliRoute.provider.sdkCallOptions({ effort }),
      );
    }
    expect([evalRoute.model.modelId, evalRoute.model.provider]).toEqual([
      cliRoute.model.modelId,
      cliRoute.model.provider,
    ]);

    expect(patternsOf(evalDeps)).toEqual(patternsOf(cli));
    expect(patternsOf(cli)).toHaveLength(1);

    const wiring: SessionDeps = {
      route: cli.route,
      toolDispatch: { dispatch: () => Promise.reject(new Error('no tool runs here')) },
      specSink: createSpecSink(),
      visibility: createVisibilityChannel({}),
      tools: [],
    };
    expect(cli.makeSession(wiring)).toBeInstanceOf(AgentSession);
    expect(evalDeps.makeSession(wiring)).toBeInstanceOf(AgentSession);
    // each run has its own diagnostics: the cli's log, the eval's step log
    expect(evalDeps.diagnostics).not.toBe(cli.diagnostics);
  });

  it('(b) the eval prints a failure as the cli does', async () => {
    const failure = new Error(`could not start ${ESC}[2J with ${KEY}`);
    const { err } = await cliDeps(failure);
    const text = cleaner(KEY).message(failure);
    expect(err).toEqual([`minitui: ${text}`]);
    expect(text).not.toContain(KEY);
    expect(text).not.toContain(ESC);
  });

  it('(c) on the direct route the eval sends the requests the cli would', async () => {
    const intent = 'merge two clips';
    const bogus = `${JSON.stringify({ op: 'add', path: '/root', value: 'go' })}\n${JSON.stringify({
      op: 'add',
      path: '/elements/go',
      value: { type: 'Bogus', props: {} },
    })}\n`;
    const valid = [
      { op: 'add', path: '/root', value: 'go' },
      { op: 'add', path: '/elements/go', value: { type: 'Button', props: { label: 'Merge' } } },
      { op: 'add', path: '/state', value: { output: OUTPUT } },
    ]
      .map((line) => JSON.stringify(line))
      .join('\n')
      .concat('\n');
    const usage = { inputTokens: 1, outputTokens: 1 };
    const requests: ProviderRequest[] = [];
    const provider = scriptedProvider(
      [
        { kind: 'text', text: bogus, usage },
        { kind: 'text', text: valid, usage },
      ],
      (request) => requests.push(request),
    );
    const log = createStepLog(noopDiagnostics);
    const observation = await runTrial({
      intent,
      deps: graphDepsFor({
        route: { provider, model: 'scripted-model' },
        workingDirectory: DIR,
        effort: 'medium',
        diagnostics: log.port,
        redactionPolicy: keyRedactionPolicy(KEY),
        stderr: { write: () => {} },
        capabilities: fixedCapabilities([]),
      }),
      steps: log.steps,
      arm: 'medium',
      timeoutMs: 5000,
      now: () => performance.now(),
      hooks: null,
    });
    expect(observation.stop).toBe('valid');
    expect(requests).toHaveLength(2);
    expect(requests[0]?.messages[0]).toEqual({
      role: 'system',
      content: composeSystemPrompt(buildCatalogPrompt(videoMergeCatalog), DIR),
    });
    expect(requests[0]?.messages.at(-1)).toEqual({ role: 'user', content: intent });
    expect(requests.map((r) => r.config.effort)).toEqual(['medium', 'medium']);
    expect(requests[1]?.messages.at(-1)?.content).toBe(
      composeRegenerationPrompt({
        intent,
        previousText: bogus,
        reprompt: observation.attempts[1]?.reprompt ?? '',
      }),
    );
  });
});

// The names the eval may only import, never write again, and the constructors it must not reach past
// the shared route module.
const DECLARED = [
  'composeSystemPrompt',
  'composeRegenerationPrompt',
  'composeValidation',
  'generate',
  'runApp',
  'cleaner',
  'keyRedactionPolicy',
  'createModelRoute',
];
const NEVER_NAMED = ['composeValidation', 'createAiSdkProvider', 'createAnthropicModel'];

function copiesIn(text: string): string[] {
  const declared = DECLARED.filter((name) =>
    new RegExp(`(?:\\b(?:function\\*?|const|let|var|class)\\s+|\\bas\\s+)${name}\\b`).test(text),
  ).map((name) => `declares ${name}`);
  const named = NEVER_NAMED.filter((name) => new RegExp(`\\b${name}\\b`).test(text)).map(
    (name) => `names ${name}`,
  );
  return [...declared, ...named];
}

function evalFiles(): string[] {
  return readdirSync(EVAL_DIR, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => join(entry.parentPath, entry.name))
    .filter((path) => !path.startsWith(join(EVAL_DIR, 'results')));
}

describe('(d) the eval holds no copy of the cli', () => {
  it('flags a planted declaration and a planted constructor call', () => {
    expect(copiesIn('export function composeSystemPrompt(): string {\n  return "";\n}\n')).toEqual([
      'declares composeSystemPrompt',
    ]);
    expect(copiesIn("const model = createAnthropicModel('m');\n")).toEqual([
      'names createAnthropicModel',
    ]);
  });

  it('finds no copy in any eval file, and the imports of the graph and the run', () => {
    const files = evalFiles();
    expect(files.map((path) => path.slice(EVAL_DIR.length)).sort()).toEqual(
      expect.arrayContaining(['harness/scripted.ts', 'harness/trial.ts']),
    );
    const texts = files.map((path) => [path, readFileSync(path, 'utf8')] as const);
    expect(texts.flatMap(([path, text]) => copiesIn(text).map((c) => `${path}: ${c}`))).toEqual([]);
    const all = texts.map(([, text]) => text).join('\n');
    expect(all).toMatch(/import \{[^}]*\bbuildAppGraph\b[^}]*\} from '\.\.\/\.\.\/src\/graph\.js'/);
    expect(all).toMatch(/import \{[^}]*\brunApp\b[^}]*\} from '\.\.\/\.\.\/src\/run-app\.js'/);
  });
});
