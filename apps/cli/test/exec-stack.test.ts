import { describe, it, expect } from 'vitest';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Decision, PermissionRequest } from '@minitui/types';
import { buildExecStack, makeCheckPathDecision } from '../src/exec-stack.js';
import { videoMergeCatalog } from '@minitui/catalog';
import { OUTPUT, fakeSandbox, recordingDiagnostics } from './support/fakes.js';

function recordingEngine(answer: Decision): {
  engine: { check(req: PermissionRequest): Promise<Decision> };
  requests: PermissionRequest[];
} {
  const requests: PermissionRequest[] = [];
  return {
    requests,
    engine: {
      check: (req) => {
        requests.push(req);
        return Promise.resolve(answer);
      },
    },
  };
}

describe('makeCheckPathDecision', () => {
  it('allows a path under the temporary directory without asking', async () => {
    const { engine, requests } = recordingEngine({ kind: 'deny', reason: 'never asked' });
    const decide = makeCheckPathDecision(engine);
    expect(await decide(join(tmpdir(), 'minitui', 'list.txt'))).toEqual({ kind: 'allow' });
    expect(requests).toEqual([]);
  });

  it('asks the engine about any other path, naming the path in the request', async () => {
    const { engine, requests } = recordingEngine({ kind: 'allow' });
    const decide = makeCheckPathDecision(engine);
    expect(await decide('/srv/data/out.mp4')).toEqual({ kind: 'allow' });
    expect(requests).toHaveLength(1);
    expect(requests[0]?.resolvedPaths).toEqual(['/srv/data/out.mp4']);
  });

  it('gives each question its own id', async () => {
    const { engine, requests } = recordingEngine({ kind: 'allow' });
    const decide = makeCheckPathDecision(engine);
    await decide('/srv/a');
    await decide('/srv/b');
    expect(requests[0]?.id).not.toBe(requests[1]?.id);
  });

  it('passes a denial through', async () => {
    const { engine } = recordingEngine({ kind: 'deny', reason: 'no' });
    expect(await makeCheckPathDecision(engine)('/srv/x')).toEqual({ kind: 'deny', reason: 'no' });
  });

  it('turns an unresolved ask into a denial, so the handler only sees allow or deny', async () => {
    const pending: PermissionRequest = {
      id: 'r',
      descriptor: { danger: false, resourceTemplate: 'x', summaryTemplate: 'x' },
      resolvedCommand: '',
      resolvedPaths: [],
    };
    const { engine } = recordingEngine({ kind: 'ask', request: pending });
    expect(await makeCheckPathDecision(engine)('/srv/x')).toEqual({
      kind: 'deny',
      reason: 'write path approval did not resolve',
    });
  });
});

describe('buildExecStack', () => {
  it('builds on the sandbox it was given and reports nothing when that sandbox is active', async () => {
    const sandbox = fakeSandbox(true);
    const { diagnostics } = recordingDiagnostics();
    const stack = await buildExecStack({
      mode: 'default',
      diagnostics,
      onExecEvent: () => {},
      createSandbox: () => Promise.resolve(sandbox.handle),
    });
    expect(stack.sandbox).toBe(sandbox.handle);
    expect(stack.sandboxNotice).toBeUndefined();
  });

  it('reports an inactive sandbox with the probe text, once, cleaned and bounded', async () => {
    const hostile = `no bubblewrap ${String.fromCharCode(0x9b)}2J ${'x'.repeat(2000)}`;
    const sandbox = fakeSandbox(false, [hostile]);
    const { diagnostics } = recordingDiagnostics();
    const stack = await buildExecStack({
      mode: 'default',
      diagnostics,
      onExecEvent: () => {},
      createSandbox: () => Promise.resolve(sandbox.handle),
    });
    const notice = stack.sandboxNotice ?? '';
    expect(notice).toContain('gated actions are unavailable');
    expect(notice).toContain('no bubblewrap');
    expect(notice).not.toContain(String.fromCharCode(0x9b));
    expect(notice.length).toBeLessThanOrEqual(500);
  });

  it('falls back to a fixed reason when the probe gave none', async () => {
    const sandbox = fakeSandbox(false, []);
    const { diagnostics } = recordingDiagnostics();
    const stack = await buildExecStack({
      mode: 'default',
      diagnostics,
      onExecEvent: () => {},
      createSandbox: () => Promise.resolve(sandbox.handle),
    });
    expect(stack.sandboxNotice).toContain('the sandbox is not available');
  });
});

describe('ExecStack.abort', () => {
  async function dispatchMerge(abort: boolean) {
    const sandbox = fakeSandbox(true);
    const { diagnostics } = recordingDiagnostics();
    // yolo lifts the ask, so the call reaches the point where the router checks its signal
    const stack = await buildExecStack({
      mode: 'yolo',
      diagnostics,
      onExecEvent: () => {},
      createSandbox: () => Promise.resolve(sandbox.handle),
    });
    if (abort) stack.abort();
    const permission = videoMergeCatalog.permissionOf('merge');
    return stack.dispatcher.dispatch('merge', {
      actionName: 'merge',
      actionKind: 'exec-local',
      ...(permission !== undefined ? { permission } : {}),
      resolvedParams: { inputs: ['/abs/a.mp4', '/abs/b.mp4'], codec: 'h264', output: OUTPUT },
      stateSnapshot: {},
      elementKey: 'go',
    });
  }

  it('makes the router refuse later work as cancelled', async () => {
    expect(await dispatchMerge(true)).toMatchObject({
      status: 'failed',
      fault: { stderrExcerpt: 'cancelled before start' },
    });
  });

  it('the same call is not cancelled without the abort: the row above can fail', async () => {
    const outcome = await dispatchMerge(false);
    expect(JSON.stringify(outcome)).not.toContain('cancelled before start');
  });
});
