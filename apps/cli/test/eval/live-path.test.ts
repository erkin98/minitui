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
import { MAX_OUTPUT_TOKENS } from '../../src/graph.js';
import { DEFAULT_MODEL, cliMain, type CliBootApi } from '../../src/index.js';
import { cleaner, createModelRoute, keyRedactionPolicy } from '../../src/model-route.js';
import { fixedCapabilities, scriptedProvider } from '../../eval/harness/scripted.js';
import { createSpendMeter, trialMeter } from '../../eval/harness/spend.js';
import { createStepLog, graphDepsFor, runTrial } from '../../eval/harness/trial.js';
import { anthropicEntry } from '../../eval/providers/anthropic.js';
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

// An app the catalog refuses, then a valid one: the loop's "invalid, then valid".
const BOGUS = `${JSON.stringify({ op: 'add', path: '/root', value: 'go' })}\n${JSON.stringify({
  op: 'add',
  path: '/elements/go',
  value: { type: 'Bogus', props: {} },
})}\n`;
const VALID = [
  { op: 'add', path: '/root', value: 'go' },
  { op: 'add', path: '/elements/go', value: { type: 'Button', props: { label: 'Merge' } } },
  { op: 'add', path: '/state', value: { output: OUTPUT } },
]
  .map((line) => JSON.stringify(line))
  .join('\n')
  .concat('\n');

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);
const fieldOf = (value: unknown, name: string): unknown =>
  isRecord(value) ? value[name] : undefined;
// The text of a list of text parts, joined; undefined for anything that is not a list.
const partsText = (value: unknown): string | undefined =>
  Array.isArray(value)
    ? value
        .map((part) => fieldOf(part, 'text'))
        .filter((text) => typeof text === 'string')
        .join('')
    : undefined;
const messagesOf = (body: unknown): Array<{ role: unknown; text: string | undefined }> => {
  const messages = fieldOf(body, 'messages');
  return Array.isArray(messages)
    ? messages.map((m) => ({ role: fieldOf(m, 'role'), text: partsText(fieldOf(m, 'content')) }))
    : [];
};

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
    const usage = { inputTokens: 1, outputTokens: 1 };
    const requests: ProviderRequest[] = [];
    const provider = scriptedProvider(
      [
        { kind: 'text', text: BOGUS, usage },
        { kind: 'text', text: VALID, usage },
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
        previousText: BOGUS,
        reprompt: observation.attempts[1]?.reprompt ?? '',
      }),
    );
  });

  it('(e) on the replay route the eval sends the requests a paid run sends', async () => {
    const intent = 'merge two clips';
    const usage = { inputTokens: 100, outputTokens: 50 };
    const bodies: unknown[] = [];
    const access = anthropicEntry.replay(KEY);
    const log = createStepLog(noopDiagnostics);
    // The paid lane's meter, under a cap that holds two worst cases: the trial fits whether the first attempt
    // finishes with its usage or is cut at its bad line and settles at its worst case.
    const meter = trialMeter(
      createSpendMeter({
        capUsd: 1e12,
        prices: { input: 1e6, cacheWrite: 1e6, cacheRead: 5e5, output: 2e6 },
        maxOutputTokens: MAX_OUTPUT_TOKENS,
      }),
      'e',
    );
    const route = access.route({
      model: DEFAULT_MODEL,
      meter: meter.wrap,
      diagnostics: log.port,
      replies: [
        { text: BOGUS, modelId: DEFAULT_MODEL, usage },
        { text: VALID, modelId: DEFAULT_MODEL, usage },
      ],
      onRequest: (request) => bodies.push(request.body),
    });
    const observation = await runTrial({
      intent,
      deps: graphDepsFor({
        route,
        workingDirectory: DIR,
        effort: 'high',
        diagnostics: log.port,
        redactionPolicy: access.redactionPolicy,
        stderr: { write: () => {} },
        capabilities: fixedCapabilities([]),
      }),
      steps: log.steps,
      arm: 'high',
      timeoutMs: 10_000,
      now: () => 0,
      hooks: meter.hooks,
    });
    expect(observation.stop).toBe('valid');
    expect(bodies).toHaveLength(2);
    const [first, second] = bodies;
    expect(Array.isArray(fieldOf(first, 'system'))).toBe(true);
    expect(partsText(fieldOf(first, 'system'))).toBe(
      composeSystemPrompt(buildCatalogPrompt(videoMergeCatalog), DIR),
    );
    expect(fieldOf(first, 'max_tokens')).toBe(MAX_OUTPUT_TOKENS);
    expect(messagesOf(first)).toEqual([{ role: 'user', text: intent }]);
    expect(messagesOf(second).at(-1)).toEqual({
      role: 'user',
      text: composeRegenerationPrompt({
        intent,
        previousText: BOGUS,
        reprompt: observation.attempts[1]?.reprompt ?? '',
      }),
    });
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
      expect.arrayContaining([
        'harness/scripted.ts',
        'harness/trial.ts',
        'providers/anthropic.ts',
        'providers/index.ts',
      ]),
    );
    const texts = files.map((path) => [path, readFileSync(path, 'utf8')] as const);
    expect(texts.flatMap(([path, text]) => copiesIn(text).map((c) => `${path}: ${c}`))).toEqual([]);
    const all = texts.map(([, text]) => text).join('\n');
    expect(all).toMatch(/import \{[^}]*\bbuildAppGraph\b[^}]*\} from '\.\.\/\.\.\/src\/graph\.js'/);
    expect(all).toMatch(/import \{[^}]*\brunApp\b[^}]*\} from '\.\.\/\.\.\/src\/run-app\.js'/);
    const entry = texts.find(([path]) => path === join(EVAL_DIR, 'providers', 'anthropic.ts'));
    expect(entry?.[1]).toMatch(
      /import \{[^}]*\bcreateModelRoute\b[^}]*\} from '\.\.\/\.\.\/src\/model-route\.js'/,
    );
  });
});
