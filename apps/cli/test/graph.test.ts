import { describe, it, expect } from 'vitest';
import { createMockProvider } from '@minitui/agent-core';
import { videoMergeCatalog } from '@minitui/catalog';
import type { ActionDispatcher, RendererPort } from '@minitui/renderer-core';
import { createInkBinding } from '@minitui/renderer-ink';
import type { RuntimeFault } from '@minitui/types';
import type { MiniAppSpec } from '@minitui/spec';
import type { DispatchContext } from '@minitui/renderer-core';
import { buildRunAgentInput } from '@minitui/transport';
import { buildAppGraph, MAX_OUTPUT_TOKENS } from '../src/graph.js';
import type { AppGraphDeps, SessionDeps } from '../src/graph-types.js';
import {
  OUTPUT,
  VALID_SPEC_LINES,
  capableHost,
  fakeSandbox,
  fakeSession,
  recordingDiagnostics,
  textTurn,
  until,
} from './support/fakes.js';

function streamOf(...chunks: string[]): AsyncIterable<string> {
  return {
    [Symbol.asyncIterator]() {
      let index = 0;
      return {
        next: () => {
          const value = chunks[index];
          index += 1;
          return Promise.resolve(
            value === undefined
              ? { done: true as const, value: undefined }
              : { done: false as const, value },
          );
        },
      };
    },
  };
}

const fault: RuntimeFault = {
  actionKey: 'merge',
  exitCode: 1,
  stderrExcerpt: 'codec libvpx-vp9 not found',
};

// Builds a graph on real ports: a real sandbox handle (active or not), a real capability provider and
// a scripted session. The wiring the session was handed is kept for inspection.
async function build(
  over: {
    active?: boolean;
    mode?: AppGraphDeps['mode'];
    session?: ReturnType<typeof fakeSession>;
    redactionPolicy?: AppGraphDeps['redactionPolicy'];
    renderer?: RendererPort;
  } = {},
) {
  const sandbox = fakeSandbox(
    over.active ?? true,
    over.active === false ? ['no sandbox here'] : [],
  );
  const session = over.session ?? fakeSession();
  const log = recordingDiagnostics();
  const stderr: string[] = [];
  let wiring: SessionDeps | undefined;
  const graph = await buildAppGraph({
    mode: over.mode ?? 'default',
    accessible: false,
    binding: createInkBinding(videoMergeCatalog),
    provider: createMockProvider({ script: [] }),
    model: 'test-model',
    workingDirectory: '/work/dir',
    makeSession: (w) => {
      wiring = w;
      return session;
    },
    diagnostics: log.diagnostics,
    stderr: { write: (s) => stderr.push(s) },
    createSandbox: () => Promise.resolve(sandbox.handle),
    capabilities: capableHost,
    ...(over.redactionPolicy !== undefined ? { redactionPolicy: over.redactionPolicy } : {}),
    ...(over.renderer !== undefined ? { renderer: over.renderer } : {}),
  });
  return { graph, sandbox, session, log, stderr, wiring: () => wiring };
}

describe('buildAppGraph: the session', () => {
  it('is built on real ports and the catalog prompt', async () => {
    const { graph, wiring, log } = await build();
    const w = wiring();
    expect(typeof w?.toolDispatch.dispatch).toBe('function');
    expect(typeof w?.specSink.emit).toBe('function');
    expect(w?.tools).toEqual([]);
    expect(w?.model).toBe('test-model');
    expect(w?.config?.system).toBe(graph.systemPrompt);
    expect(w?.config?.maxOutputTokens).toBe(MAX_OUTPUT_TOKENS);
    expect(w?.diagnostics).toBe(log.diagnostics);
  });

  it('tells the model the working directory, so it can write the absolute paths the host requires', async () => {
    const { wiring } = await build();
    expect(wiring()?.config?.system).toContain('"/work/dir"');
  });

  it('leaves the model room to think before it writes the spec', async () => {
    // The thinking of the default model counts against this cap, and a reply cut by it ends the run.
    const { wiring } = await build();
    expect(wiring()?.config?.maxOutputTokens).toBe(64_000);
  });

  it('hands the session the redaction policy it was given', async () => {
    const policy = { extraSecretPatterns: [/TOPSECRET\d+/] };
    const { wiring } = await build({ redactionPolicy: policy });
    expect(wiring()?.config?.redactionPolicy).toBe(policy);
  });

  it('the agent port feeds the session with the intent and the abort signal', async () => {
    const session = fakeSession();
    const { graph } = await build({ session });
    const handle = graph.agentPort.run(
      buildRunAgentInput({ threadId: 't1', runId: 'r1', userText: 'merge my clips' }),
    );
    await handle.events.next();
    expect(session.submits).toHaveLength(1);
    expect(session.submits[0]?.intent).toBe('merge my clips');
    expect(session.submits[0]?.signal).toBeInstanceOf(AbortSignal);
  });
});

describe('buildAppGraph: sandbox and teardown', () => {
  it('reports nothing for an active sandbox and a notice for an inactive one', async () => {
    expect((await build({ active: true })).graph.sandboxNotice).toBeUndefined();
    expect((await build({ active: false })).graph.sandboxNotice).toContain('no sandbox here');
  });

  it('dispose releases the sandbox handle', async () => {
    const { graph, sandbox } = await build();
    await graph.dispose();
    expect(sandbox.disposals()).toBe(1);
  });

  it('cancel stops the session and stays cancelled', async () => {
    let cancels = 0;
    const session = fakeSession({
      onCancel: () => {
        cancels += 1;
      },
    });
    const { graph } = await build({ session });
    expect(graph.cancelled()).toBe(false);
    graph.cancel();
    expect(graph.cancelled()).toBe(true);
    expect(cancels).toBe(1);
  });
});

describe('buildAppGraph: cancel and the exec in flight', () => {
  it('cancel makes the router refuse later work as cancelled', async () => {
    const { graph } = await build({ mode: 'yolo' });
    graph.cancel();
    const permission = videoMergeCatalog.permissionOf('merge');
    const outcome = await graph.dispatcher.dispatch('merge', {
      actionName: 'merge',
      actionKind: 'exec-local',
      ...(permission !== undefined ? { permission } : {}),
      resolvedParams: { inputs: ['/abs/a.mp4', '/abs/b.mp4'], codec: 'h264', output: OUTPUT },
      stateSnapshot: {},
      elementKey: 'go',
    });
    expect(outcome).toMatchObject({
      status: 'failed',
      fault: { stderrExcerpt: 'cancelled before start' },
    });
  });
});

describe('buildAppGraph: the host', () => {
  it('refuses the model a client-only action and never reaches the sandbox', async () => {
    const { graph, sandbox } = await build();
    const outcome = await graph.host.dispatchFromModel('merge', {
      actionName: 'merge',
      actionKind: 'exec-local',
      resolvedParams: {},
      stateSnapshot: {},
      elementKey: '',
    });
    expect(outcome).toEqual({ status: 'denied', reason: 'action is not callable by the model' });
    expect(sandbox.wraps()).toBe(0);
  });

  it('observeDenied logs the refusal and starts no turn', async () => {
    const { graph, log, session } = await build();
    graph.observeDenied({ actionKey: 'merge', reason: 'the person said no' });
    expect(log.records).toContainEqual({
      level: 'warn',
      msg: 'gated action refused',
      meta: { actionKey: 'merge', reason: 'the person said no' },
    });
    expect(session.submits).toEqual([]);
  });
});

describe('buildAppGraph: the repair of a failed action', () => {
  it('re-asks with the fault, the intent and the loop reprompt, and applies nothing invalid', async () => {
    const prompts: string[] = [];
    const session = fakeSession({
      submit: (prompt) => {
        prompts.push(prompt);
        return textTurn('{"op":"add","path":"/root","value":"r"}');
      },
    });
    const { graph, log } = await build({ session });
    const applied: MiniAppSpec[] = [];
    graph.bindHostSession({ updateSpec: (s) => applied.push(s) });
    graph.generation.intent = 'merge two clips';
    graph.observeFault(fault);
    await until(
      () => log.records.some((r) => r.msg === 'post-mount repair produced no valid spec'),
      'the repair to give up',
    );
    expect(prompts[0]).toContain('codec libvpx-vp9 not found');
    expect(prompts[0]).toContain('merge two clips');
    expect(prompts).toHaveLength(6);
    expect(applied).toEqual([]);
    expect(
      log.records.find((r) => r.msg === 'post-mount repair produced no valid spec')?.meta,
    ).toMatchObject({
      attempts: 6,
    });
  });

  it('applies a repair that passed the same validation as the first generation', async () => {
    const session = fakeSession({ submit: () => textTurn(VALID_SPEC_LINES) });
    const { graph } = await build({ session });
    const applied: MiniAppSpec[] = [];
    graph.bindHostSession({ updateSpec: (s) => applied.push(s) });
    graph.observeFault(fault);
    await until(() => applied.length === 1, 'the repair to be applied');
    expect(applied[0]?.root).toBe('go');
  });

  it('starts no new turn after a cancel: the regeneration of the repair ends', async () => {
    const prompts: string[] = [];
    const session = fakeSession({
      submit: (prompt) => {
        prompts.push(prompt);
        return textTurn('not a spec');
      },
    });
    const { graph, log } = await build({ session });
    graph.cancel();
    graph.observeFault(fault);
    await until(
      () => log.records.some((r) => r.msg === 'post-mount repair produced no valid spec'),
      'the repair to give up',
    );
    expect(prompts).toHaveLength(1);
  });

  it('a turn that throws is logged and does not escape as an unhandled rejection', async () => {
    const session = fakeSession({
      // eslint-disable-next-line require-yield -- a turn that fails before it yields anything
      submit: async function* () {
        await Promise.resolve();
        throw new Error('provider is down');
      },
    });
    const { graph, log } = await build({ session });
    graph.observeFault(fault);
    await until(
      () => log.records.some((r) => r.msg === 'reprompt turn failed'),
      'the failure to be logged',
    );
    const record = log.records.find((r) => r.msg === 'reprompt turn failed');
    expect(String(record?.meta?.error)).toContain('provider is down');
  });

  it('applies nothing after the mounted session is released', async () => {
    const session = fakeSession({ submit: () => textTurn(VALID_SPEC_LINES) });
    const { graph } = await build({ session });
    const applied: MiniAppSpec[] = [];
    graph.bindHostSession({ updateSpec: (s) => applied.push(s) });
    graph.bindHostSession(undefined);
    graph.observeFault(fault);
    await until(() => session.submits.length > 0, 'the repair turn');
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(applied).toEqual([]);
  });

  it('starts no repair when the sandbox is inactive, and says why', async () => {
    const { graph, session, log } = await build({ active: false });
    graph.observeFault(fault);
    expect(session.submits).toEqual([]);
    expect(log.records).toContainEqual({
      level: 'warn',
      msg: 'gated action failed with the sandbox unavailable',
      meta: { actionKey: 'merge' },
    });
  });

  it('redacts the fault text with the host policy before it reaches the model', async () => {
    const prompts: string[] = [];
    const session = fakeSession({
      submit: (prompt) => {
        prompts.push(prompt);
        return textTurn('');
      },
    });
    const { graph } = await build({
      session,
      redactionPolicy: { extraSecretPatterns: [/TOPSECRET\d+/] },
    });
    graph.observeFault({ ...fault, stderrExcerpt: 'failed with TOPSECRET123 set' });
    await until(() => prompts.length > 0, 'the first repair prompt');
    expect(prompts[0]).not.toContain('TOPSECRET123');
    expect(prompts[0]).toContain('[redacted-secret]');
  });

  it('without a host policy the same text reaches the model: the row above can fail', async () => {
    const prompts: string[] = [];
    const session = fakeSession({
      submit: (prompt) => {
        prompts.push(prompt);
        return textTurn('');
      },
    });
    const { graph } = await build({ session });
    graph.observeFault({ ...fault, stderrExcerpt: 'failed with TOPSECRET123 set' });
    await until(() => prompts.length > 0, 'the first repair prompt');
    expect(prompts[0]).toContain('TOPSECRET123');
  });
});

// A real renderer port that mounts nothing and keeps the dispatcher the host gave it: the same object a
// widget press goes through, so a test can raise an action as a renderer would.
function recordingRenderer(): { renderer: RendererPort; dispatcher: () => ActionDispatcher } {
  let captured: ActionDispatcher | undefined;
  return {
    renderer: {
      mount: (args) => {
        captured = args.dispatcher;
        return Promise.resolve({
          update: () => {},
          applyStatePatch: () => {},
          onAction: () => () => {},
          unmount: () => {},
        });
      },
    },
    dispatcher: () => {
      if (captured === undefined) throw new Error('nothing was mounted');
      return captured;
    },
  };
}

describe('buildAppGraph: what the host lets through from a renderer', () => {
  const validParams = {
    inputs: ['/abs/a.mp4', '/abs/b.mp4'],
    codec: 'h264',
    output: OUTPUT,
  };
  const ctxFor = (name: string, over: Partial<DispatchContext> = {}): DispatchContext => ({
    actionName: name,
    actionKind: 'exec-local',
    resolvedParams: validParams,
    stateSnapshot: {},
    elementKey: 'go',
    ...over,
  });

  async function mounted() {
    const rec = recordingRenderer();
    const built = await build({ renderer: rec.renderer });
    const checked = await built.graph.validate(streamOf(VALID_SPEC_LINES), () => streamOf(''));
    if (!checked.ok) throw new Error('the fixture spec did not validate');
    const app = await built.graph.host.mount(checked.spec);
    return { ...built, app, dispatcher: rec.dispatcher() };
  }

  it('a refused merge is logged and changes no app state: the renderer draws the refusal row', async () => {
    const { dispatcher, app, sandbox, log } = await mounted();
    // The host lays the live state over the renderer's params, so the relative name goes into the state,
    // as the real model's spec put it there.
    app.state.setState('/inputs', ['a.mp4', '/abs/b.mp4']);
    const before = app.state.getIn('/merge/status');
    const outcome = await dispatcher.dispatch('merge', ctxFor('merge'));
    expect(outcome).toEqual({ status: 'denied', reason: 'resolved path must be absolute' });
    expect(app.state.getIn('/merge/status')).toBe(before);
    expect(log.records).toContainEqual({
      level: 'warn',
      msg: 'gated action refused',
      meta: { actionKey: 'merge', reason: 'resolved path must be absolute' },
    });
    expect(sandbox.wraps()).toBe(0);
  });

  it('refuses a key the action does not declare, before exec, and logs the refusal', async () => {
    const { dispatcher, sandbox, log } = await mounted();
    const outcome = await dispatcher.dispatch(
      'merge',
      ctxFor('merge', { resolvedParams: { ...validParams, mode: 'copy' } }),
    );
    expect(outcome).toEqual({
      status: 'denied',
      reason: 'action parameters do not match the catalog after host resolution',
    });
    expect(sandbox.wraps()).toBe(0);
    expect(log.records).toContainEqual({
      level: 'warn',
      msg: 'gated action refused',
      meta: {
        actionKey: 'merge',
        reason: 'action parameters do not match the catalog after host resolution',
      },
    });
  });

  it('does not refuse the same call without the extra key: the row above can fail', async () => {
    const { dispatcher } = await mounted();
    const first = await Promise.race([
      dispatcher.dispatch('merge', ctxFor('merge')),
      new Promise<string>((resolve) => setTimeout(() => resolve('waiting for consent'), 50)),
    ]);
    expect(first).toBe('waiting for consent');
  });

  it('refuses a context whose kind is not the catalog kind of the action', async () => {
    const { dispatcher } = await mounted();
    const outcome = await dispatcher.dispatch(
      'merge',
      ctxFor('merge', { actionKind: 'render-local' }),
    );
    expect(outcome).toEqual({
      status: 'denied',
      reason: 'action context does not match the catalog',
    });
  });

  it('refuses an action the catalog does not have', async () => {
    const { dispatcher } = await mounted();
    const outcome = await dispatcher.dispatch('wipe-disk', ctxFor('wipe-disk'));
    expect(outcome).toEqual({ status: 'denied', reason: 'action is not in the catalog' });
  });
});
