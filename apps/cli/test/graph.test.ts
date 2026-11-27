import { describe, it, expect } from 'vitest';
import { createMockProvider, type MinituiEvent } from '@minitui/agent-core';
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

// Two valid replies that differ only in the button label, so a prompt shows which one it quotes.
const VALID_SPEC_A = VALID_SPEC_LINES.replace('"label":"Merge"', '"label":"Merge A"');
const VALID_SPEC_B = VALID_SPEC_LINES.replace('"label":"Merge"', '"label":"Merge B"');

const GAVE_UP = 'post-mount repair produced no valid spec';
const tick = (): Promise<void> => new Promise<void>((resolve) => setImmediate(resolve));
const giveUps = (log: ReturnType<typeof recordingDiagnostics>): number =>
  log.records.filter((r) => r.msg === GAVE_UP).length;
const skipped = (msg: string) => ({ level: 'warn', msg, meta: { actionKey: 'merge' } });

// A gate a turn waits on until the row opens it.
function opened(): { wait: Promise<void>; open: () => void } {
  let open = (): void => {};
  const wait = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { wait, open };
}

async function* gatedTurn(wait: Promise<void>, text: string): AsyncGenerator<MinituiEvent> {
  await wait;
  yield* textTurn(text);
}

// eslint-disable-next-line require-yield -- a turn that fails before it yields anything
async function* throwingTurn(): AsyncGenerator<MinituiEvent> {
  await Promise.resolve();
  throw new Error('provider is down');
}

// Three repairs, each left to give up before the next fault, so none is dropped as running.
async function threeGiveUps(
  graph: { observeFault: (f: RuntimeFault) => void },
  log: ReturnType<typeof recordingDiagnostics>,
): Promise<void> {
  for (let n = 1; n <= 3; n += 1) {
    graph.observeFault(fault);
    await until(() => giveUps(log) === n, `repair ${String(n)} to give up`);
    await tick();
  }
}

// Builds a graph on real ports: a real sandbox handle (active or not), a real capability provider and
// a scripted session. The wiring the session was handed is kept for inspection.
async function build(
  over: {
    active?: boolean;
    mode?: AppGraphDeps['mode'];
    session?: ReturnType<typeof fakeSession>;
    redactionPolicy?: AppGraphDeps['redactionPolicy'];
    effort?: AppGraphDeps['effort'];
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
    route: { provider: createMockProvider({ script: [] }), model: 'test-model' },
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
    ...(over.effort !== undefined ? { effort: over.effort } : {}),
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
    expect(w?.route.model).toBe('test-model');
    expect(w?.config?.system).toBe(graph.systemPrompt);
    expect(w?.config?.maxOutputTokens).toBe(MAX_OUTPUT_TOKENS);
    expect(w?.diagnostics).toBe(log.diagnostics);
  });

  it('passes a chosen effort to the session, and none when unset', async () => {
    const chosen = await build({ effort: 'high' });
    expect(chosen.wiring()?.config?.effort).toBe('high');
    const unset = await build();
    expect(Object.hasOwn(unset.wiring()?.config ?? {}, 'effort')).toBe(false);
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

  it('starts no turn after a cancel, and says why', async () => {
    const { graph, session, log } = await build({ session: fakeSession() });
    graph.bindHostSession({ updateSpec: () => {} });
    graph.cancel();
    graph.observeFault(fault);
    await tick();
    expect(session.submits).toEqual([]);
    expect(log.records).toContainEqual(skipped('repair skipped: the run was cancelled'));
  });

  it('starts no turn while no app is mounted, and says why', async () => {
    const { graph, session, log } = await build({ session: fakeSession() });
    graph.observeFault(fault);
    await tick();
    expect(session.submits).toEqual([]);
    expect(log.records).toContainEqual(skipped('repair skipped: no app is mounted'));
  });

  it('names the cancel first when the run is cancelled and no app is mounted', async () => {
    const { graph, session, log } = await build({ session: fakeSession() });
    graph.cancel();
    graph.observeFault(fault);
    await tick();
    expect(session.submits).toEqual([]);
    expect(log.records).toContainEqual(skipped('repair skipped: the run was cancelled'));
    expect(log.records).not.toContainEqual(skipped('repair skipped: no app is mounted'));
  });

  it('drops a fault that arrives while a repair runs, and says why', async () => {
    const gate = opened();
    let calls = 0;
    const session = fakeSession({
      submit: () => {
        calls += 1;
        return calls === 1 ? gatedTurn(gate.wait, 'not a spec') : textTurn('not a spec');
      },
    });
    const { graph, log } = await build({ session });
    graph.bindHostSession({ updateSpec: () => {} });
    graph.observeFault(fault);
    graph.observeFault(fault);
    await tick();
    expect(session.submits).toHaveLength(1);
    expect(log.records).toContainEqual(skipped('repair skipped: a repair is already running'));
    gate.open();
    await until(() => giveUps(log) === 1, 'the repair to give up');
  });

  it('starts no fourth repair in one app session, and says why', async () => {
    const session = fakeSession({ submit: () => textTurn('not a spec') });
    const { graph, log } = await build({ session });
    graph.bindHostSession({ updateSpec: () => {} });
    await threeGiveUps(graph, log);
    const before = session.submits.length;
    graph.observeFault(fault);
    await tick();
    expect(session.submits).toHaveLength(before);
    expect(log.records).toContainEqual(skipped('repair skipped: the repair budget is spent'));
  });

  it('a released app session gives the next app its own three repairs', async () => {
    const session = fakeSession({ submit: () => textTurn('not a spec') });
    const { graph, log } = await build({ session });
    graph.bindHostSession({ updateSpec: () => {} });
    await threeGiveUps(graph, log);
    graph.bindHostSession(undefined);
    graph.bindHostSession({ updateSpec: () => {} });
    graph.observeFault(fault);
    await until(() => giveUps(log) === 4, 'a fourth repair to give up');
  });

  it('a repair whose turn throws leaves the bridge free for the next fault', async () => {
    let calls = 0;
    const session = fakeSession({
      submit: () => {
        calls += 1;
        return calls === 1 ? throwingTurn() : textTurn('not a spec');
      },
    });
    const { graph, log } = await build({ session });
    graph.bindHostSession({ updateSpec: () => {} });
    graph.observeFault(fault);
    await until(() => log.records.some((r) => r.msg === 'reprompt turn failed'), 'the throw');
    graph.observeFault(fault);
    await until(() => giveUps(log) === 1, 'the second repair to give up');
  });

  it("drops the fault a refused repaired spec raises, and keeps the mounted spec's text", async () => {
    let calls = 0;
    const session = fakeSession({
      submit: () => {
        calls += 1;
        return textTurn(calls === 1 ? VALID_SPEC_A : VALID_SPEC_B);
      },
    });
    const { graph, log } = await build({ session });
    const applied: MiniAppSpec[] = [];
    graph.generation.previousText = 'MOUNTED-TEXT';
    graph.bindHostSession({
      updateSpec: (s) => {
        applied.push(s);
        // the host's own refusal of the first repaired spec: it reports a fault inside the apply
        if (applied.length === 1) graph.observeFault(fault);
      },
    });
    graph.observeFault(fault);
    await until(() => applied.length >= 1, 'the first apply');
    await tick();
    expect(applied).toHaveLength(1);
    expect(log.records).toContainEqual(skipped('repair skipped: the repaired spec was refused'));
    graph.observeFault(fault);
    await until(() => applied.length === 2, 'the second apply');
    await tick();
    expect(session.submits[1]?.intent).toContain('MOUNTED-TEXT');
    expect(session.submits[1]?.intent).not.toContain('Merge A');
    graph.observeFault(fault);
    await until(() => session.submits.length === 3, 'the third repair');
    expect(session.submits[2]?.intent).toContain('Merge B');
  });

  it('an apply that throws leaves the bridge free for the next fault', async () => {
    let applies = 0;
    const session = fakeSession({ submit: () => textTurn(VALID_SPEC_A) });
    const { graph, log } = await build({ session });
    graph.bindHostSession({
      updateSpec: () => {
        applies += 1;
        if (applies === 1) throw new Error('the app was built wrong');
      },
    });
    graph.observeFault(fault);
    await until(() => log.records.some((r) => r.msg === 'reprompt turn failed'), 'the throw');
    graph.observeFault(fault);
    await until(() => applies === 2, 'the second apply');
  });

  it("each repair's first prompt quotes the mounted spec, its regenerations its own last reply", async () => {
    const session = fakeSession({ submit: () => textTurn('REPLY-A') });
    const { graph, log } = await build({ session });
    graph.generation.previousText = 'MOUNTED-TEXT';
    graph.bindHostSession({ updateSpec: () => {} });
    graph.observeFault(fault);
    await until(() => giveUps(log) === 1, 'the first repair to give up');
    expect(session.submits[1]?.intent).toContain('REPLY-A');
    const firstOfSecond = session.submits.length;
    graph.observeFault(fault);
    await until(() => session.submits.length > firstOfSecond, 'the second repair');
    expect(session.submits[firstOfSecond]?.intent).toContain('MOUNTED-TEXT');
    expect(session.submits[firstOfSecond]?.intent).not.toContain('REPLY-A');
  });

  it('an applied repair becomes the mounted text the next repair quotes', async () => {
    const session = fakeSession({ submit: () => textTurn(VALID_SPEC_A) });
    const { graph } = await build({ session });
    const applied: MiniAppSpec[] = [];
    graph.generation.previousText = 'MOUNTED-TEXT';
    graph.bindHostSession({ updateSpec: (s) => applied.push(s) });
    graph.observeFault(fault);
    await until(() => applied.length === 1, 'the apply');
    await tick();
    graph.observeFault(fault);
    await until(() => session.submits.length === 2, 'the second repair');
    expect(session.submits[1]?.intent).toContain('Merge A');
    expect(session.submits[1]?.intent).not.toContain('MOUNTED-TEXT');
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
    graph.bindHostSession({ updateSpec: () => {} });
    graph.observeFault(fault);
    await until(
      () => log.records.some((r) => r.msg === 'reprompt turn failed'),
      'the failure to be logged',
    );
    const record = log.records.find((r) => r.msg === 'reprompt turn failed');
    expect(String(record?.meta?.error)).toContain('provider is down');
  });

  it('applies nothing when the mounted session is released while the repair runs', async () => {
    const gate = opened();
    const session = fakeSession({ submit: () => gatedTurn(gate.wait, VALID_SPEC_LINES) });
    const { graph } = await build({ session });
    const applied: MiniAppSpec[] = [];
    graph.bindHostSession({ updateSpec: (s) => applied.push(s) });
    graph.observeFault(fault);
    await until(() => session.submits.length > 0, 'the repair turn');
    graph.bindHostSession(undefined);
    gate.open();
    await tick();
    expect(applied).toEqual([]);
  });

  it('applies the repair when nothing is released: the row above can fail', async () => {
    const gate = opened();
    const session = fakeSession({ submit: () => gatedTurn(gate.wait, VALID_SPEC_LINES) });
    const { graph } = await build({ session });
    const applied: MiniAppSpec[] = [];
    graph.bindHostSession({ updateSpec: (s) => applied.push(s) });
    graph.observeFault(fault);
    await until(() => session.submits.length > 0, 'the repair turn');
    gate.open();
    await until(() => applied.length === 1, 'the apply');
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
    graph.bindHostSession({ updateSpec: () => {} });
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
    graph.bindHostSession({ updateSpec: () => {} });
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
