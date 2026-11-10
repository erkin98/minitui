import { basename, join } from 'node:path';
import {
  AgentSession,
  catalogVisibilityToChannel,
  createSpecSink,
  createVisibilityChannel,
  type AgentConfig,
  type ModelProvider,
} from '@minitui/agent-core';
import { videoMergeCatalog } from '@minitui/catalog';
import {
  buildPermissionRequest,
  createActionRouter,
  createPermissionEngine,
  type LocalRunner,
  type RunSpec,
} from '@minitui/exec';
import { composeValidation, type CapabilityProvider } from '@minitui/spec';
import { createTestConsentController, specPatchText, waitFor } from '@minitui/test-kit';
import { buildRunAgentInput, createLocalAgentPort } from '@minitui/transport';
import { describe, expect, it } from 'vitest';
import {
  inTempDir,
  mergeAppWithState,
  passThroughSandbox,
} from '../security/support/host-over-exec.js';
import { inkUnderHost } from './support/ink-under-host.js';

// One row through the pieces production composes, each from its own package: the model loop of the
// SDK, transport's local agent port, the validation loop, the runtime host over the real Ink renderer,
// the exec router with the real blocking engine, and the consent box. The model call, the process spawn
// and the output file are doubles behind their own seams. The cli's own wiring of these pieces is proven
// by the cli's tests; this row proves the pieces fit.
const capabilities: CapabilityProvider = {
  listCodecs: () => Promise.resolve(['h264']),
  listEncoders: () => Promise.resolve(['libx264']),
  listFilters: () => Promise.resolve(['concat']),
  statFile: () => Promise.resolve({ exists: true, readable: true, isFile: true }),
};

async function* neverAsked(): AsyncGenerator<string> {
  yield* [];
  throw new Error('the loop asked for a regeneration');
}

describe('the production composition', () => {
  it('a reply from the SDK loop is mounted, asks with host values, and runs once on yes', async () => {
    await inTempDir(async (dir) => {
      const inputs = [join(dir, 'first.mp4'), join(dir, 'second.mp4')];
      const output = join(dir, 'joined.mp4');
      const app = mergeAppWithState({ inputs, codec: 'copy', output });

      const streamTextImpl: NonNullable<AgentConfig['streamTextImpl']> = () => ({
        fullStream: (async function* () {
          yield { type: 'text-delta', text: specPatchText(app) };
          yield { type: 'finish', finishReason: 'stop' };
        })(),
      });
      const provider: ModelProvider = {
        id: 'sdk-loop',
        usesSdkLoop: true,
        streamChat: () => {
          throw new Error('the session took the scripted loop');
        },
      };
      const session = new AgentSession({
        provider,
        toolDispatch: {
          dispatch: (req) => Promise.reject(new Error(`the model called a tool: ${req.toolName}`)),
        },
        specSink: createSpecSink(),
        visibility: createVisibilityChannel(catalogVisibilityToChannel(videoMergeCatalog)),
        tools: [],
        model: 'sdk-loop',
        config: { system: 'merge videos', streamTextImpl },
      });
      const agent = createLocalAgentPort((_input, signal) =>
        session.submit('merge two clips', { signal }),
      );
      const run = agent.run(
        buildRunAgentInput({ threadId: 'thread', runId: 'run', userText: 'merge two clips' }),
      );
      let text = '';
      for await (const event of run.events) if (event.kind === 'text-delta') text += event.delta;

      const result = await composeValidation({
        stream: (async function* () {
          yield text;
        })(),
        catalog: videoMergeCatalog,
        capabilities,
        regenerate: () => neverAsked(),
      });
      if (!result.ok) throw new Error('the validation loop refused the reply');

      const engine = await createPermissionEngine({ mode: 'default' });
      const runs: RunSpec[] = [];
      const runner: LocalRunner = {
        run: (spec) => {
          runs.push(spec);
          return (async function* () {
            yield { kind: 'exit' as const, code: 0, signal: null };
          })();
        },
      };
      const router = createActionRouter({
        engine,
        execLocal: {
          runner,
          sandbox: passThroughSandbox(),
          checkPath: () => Promise.resolve({ kind: 'allow' }),
          onEvent: () => undefined,
          buildFfmpegRun: (merge) => ({
            run: {
              command: 'ffmpeg',
              args: [...merge.inputs.flatMap((input) => ['-i', input]), merge.output],
              cwd: dir,
              sandboxPolicy: { allowWrite: [merge.output], allowEgress: [] },
            },
            writeList: () => Promise.resolve(),
            cleanup: () => Promise.resolve(),
          }),
          ensureOutputFile: () => Promise.resolve(),
        },
        callback: { allowlist: new Set(), emit: () => undefined },
        buildPermissionRequest,
        signal: new AbortController().signal,
      });
      const ui = await inkUnderHost({
        spec: result.spec,
        dispatcher: router,
        consent: createTestConsentController(engine),
      });
      try {
        await ui.focusMerge();
        await ui.press('enter');
        await waitFor(
          () => ui.frame().includes('Allow? [a]lways / [y]es / [n]o'),
          'the consent box',
        );
        const box = ui.frame();
        expect(box).toContain(basename(output));
        expect(box).toContain(basename(dir));
        expect(box).toContain('first.mp4');
        expect(box).not.toContain('${');
        expect(runs).toHaveLength(0);
        await ui.press('y');
        await waitFor(() => runs.length > 0, 'the run');
        expect(runs).toHaveLength(1);
        expect(runs[0]?.args).toEqual([...inputs.flatMap((input) => ['-i', input]), output]);
      } finally {
        ui.session.dispose();
        engine.disposeAll('the row ended');
      }
    });
  });
});
