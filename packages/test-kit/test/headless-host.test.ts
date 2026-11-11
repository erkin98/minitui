import { describe, it, expect } from 'vitest';
import { videoMergeCatalog } from '@minitui/catalog';
import { createInkBinding } from '@minitui/renderer-ink';
import type { DiagnosticsPort } from '@minitui/types';
import {
  bridgeExecEventToStore,
  createMockDispatcher,
  mountHeadless,
} from '../src/render/headless-host.js';
import { createMockPermissionEngine } from '../src/tools/mock-permission-engine.js';
import { createMockToolRegistry, type ScriptedTool } from '../src/tools/mock-tool-registry.js';
import { MERGE_SPEC, MERGE_TOOL_OK, MERGE_TOOL_FAIL } from '../src/fixtures/merge-task.fixtures.js';

const ctx = {
  actionName: 'merge',
  actionKind: 'exec-local',
  resolvedParams: {},
  stateSnapshot: {},
  elementKey: 'merge',
} as const;

describe('createMockDispatcher (a test double of the action router)', () => {
  it('an allowed exec action routes through the gate to the tool and settles', async () => {
    const dispatcher = createMockDispatcher({
      permission: createMockPermissionEngine({ merge: 'allow' }),
      tools: createMockToolRegistry({ merge: MERGE_TOOL_OK }),
    });
    expect((await dispatcher.dispatch('merge', ctx)).status).toBe('settled');
  });

  it('a denied exec action returns denied and never runs the tool', async () => {
    const seen: string[] = [];
    const dispatcher = createMockDispatcher({
      permission: createMockPermissionEngine({ merge: 'deny' }),
      tools: createMockToolRegistry({ merge: MERGE_TOOL_OK }),
      storeSink: (ev) => seen.push(ev.kind),
    });
    expect((await dispatcher.dispatch('merge', ctx)).status).toBe('denied');
    expect(seen).toEqual([]);
  });

  it('a tool failure maps to a canonical runtime fault, after its stderr and exit events', async () => {
    const seen: string[] = [];
    const dispatcher = createMockDispatcher({
      permission: createMockPermissionEngine({ merge: 'allow' }),
      tools: createMockToolRegistry({ merge: MERGE_TOOL_FAIL }),
      storeSink: (ev) => seen.push(ev.kind),
    });
    const outcome = await dispatcher.dispatch('merge', ctx);
    expect(outcome).toMatchObject({
      status: 'failed',
      fault: { actionKey: 'merge', exitCode: 1 },
    });
    expect(seen).toEqual(['stderr', 'exit']);
  });
});

describe('bridgeExecEventToStore', () => {
  const pointers = { progress: '/merge/progress', status: '/merge/status' };
  const store = (): {
    snap: Record<string, unknown>;
    io: Parameters<typeof bridgeExecEventToStore>[0];
  } => {
    const box = {
      snap: { merge: { progress: 0, status: '' }, other: 1 } as Record<string, unknown>,
    };
    return {
      get snap() {
        return box.snap;
      },
      io: {
        getSnapshot: () => box.snap,
        setSnapshot: (next) => {
          box.snap = next;
        },
        subscribe: () => () => {},
      },
    };
  };

  it("writes progress and the exit status at the action's own pointers", () => {
    const s = store();
    const bridge = bridgeExecEventToStore(s.io, () => pointers);
    bridge({ kind: 'progress', value: 0.5 }, 'merge');
    bridge({ kind: 'exit', code: 0 }, 'merge');
    expect(s.snap).toEqual({ merge: { progress: 0.5, status: 'done' }, other: 1 });
  });

  it('cuts a stderr line at 1,000 characters, as the cli does', () => {
    const s = store();
    bridgeExecEventToStore(s.io, () => pointers)(
      { kind: 'stderr', chunk: 'x'.repeat(5000) },
      'merge',
    );
    expect(s.snap).toMatchObject({ merge: { status: 'x'.repeat(1000) } });
  });

  it('writes nothing for an action whose catalog entry names no pointers', () => {
    const s = store();
    const before = s.snap;
    bridgeExecEventToStore(s.io, () => undefined)({ kind: 'progress', value: 1 }, 'other');
    expect(s.snap).toBe(before);
  });
});

describe('mountHeadless', () => {
  const binding = createInkBinding(videoMergeCatalog);
  const focusedLine = (frame: string): number =>
    frame.split('\n').findIndex((line) => line.includes('> '));

  it('mounts the spec through the real mountInk and exposes frames without a TTY', async () => {
    const host = await mountHeadless({ spec: MERGE_SPEC, catalog: videoMergeCatalog, binding });
    expect(host.frame()).toContain('Merge');
    host.unmount();
  });

  it('press() writes real key bytes: Tab moves the focus to another widget', async () => {
    const host = await mountHeadless({ spec: MERGE_SPEC, catalog: videoMergeCatalog, binding });
    await host.waitFor(() => focusedLine(host.frame()) >= 0, 'a focused widget');
    const before = focusedLine(host.frame());
    await host.press('tab');
    await host.waitFor(() => focusedLine(host.frame()) !== before, 'the focus to move');
    expect(focusedLine(host.frame())).not.toBe(before);
    host.unmount();
  });

  it('dispatch() drives the gated mock dispatcher and records the outcome', async () => {
    const host = await mountHeadless({
      spec: MERGE_SPEC,
      catalog: videoMergeCatalog,
      binding,
      permission: createMockPermissionEngine({ merge: 'allow' }),
      tools: createMockToolRegistry({ merge: MERGE_TOOL_OK }),
    });
    expect((await host.dispatch('merge')).status).toBe('settled');
    expect(host.outcomes()).toHaveLength(1);
    host.unmount();
  });

  it('holds an asked dispatch until the overlay is answered, then runs the tool', async () => {
    const host = await mountHeadless({
      spec: MERGE_SPEC,
      catalog: videoMergeCatalog,
      binding,
      permission: createMockPermissionEngine({ merge: 'ask' }),
      tools: createMockToolRegistry({ merge: MERGE_TOOL_OK }),
    });
    const pending = host.dispatch('merge');
    const box = 'Allow? [a]lways / [y]es / [n]o';
    await host.waitFor(() => host.frame().includes(box), 'the consent box');
    expect(host.outcomes()).toHaveLength(0);
    await host.press('y');
    expect((await pending).status).toBe('settled');
    host.unmount();
  });

  it('drives exec progress into the store so the bound bar fills in a captured frame', async () => {
    const host = await mountHeadless({
      spec: MERGE_SPEC,
      catalog: videoMergeCatalog,
      binding,
      permission: createMockPermissionEngine({ merge: 'allow' }),
      tools: createMockToolRegistry({ merge: MERGE_TOOL_OK }),
    });
    expect(host.frame()).not.toContain('█');
    await host.dispatch('merge');
    await host.waitFor(() => host.frame().includes('█'), 'the filled bar');
    expect(host.frame()).toContain('█');
    host.unmount();
  });

  it('reports a contained failure to the diagnostics it is given', async () => {
    const warned: string[] = [];
    const diagnostics: DiagnosticsPort = {
      warn: (message) => warned.push(message),
      debug: () => {},
    };
    const throwing: ScriptedTool = {
      kind: 'exec-local',
      get lifecycle(): ScriptedTool['lifecycle'] {
        throw new Error('a tool that cannot start');
      },
    };
    const host = await mountHeadless({
      spec: MERGE_SPEC,
      catalog: videoMergeCatalog,
      binding,
      permission: createMockPermissionEngine({ merge: 'allow' }),
      tools: createMockToolRegistry({ merge: throwing }),
      diagnostics,
    });
    // Move the focus to the Merge button one Tab at a time, waiting for each move to render before the
    // next key: a key written before the focus has moved is applied to the wrong widget.
    const onMerge = (): boolean =>
      host.frame().split('\n')[focusedLine(host.frame())]?.includes('Merge') === true;
    await host.waitFor(() => focusedLine(host.frame()) >= 0, 'a focused widget');
    for (let i = 0; i < 6 && !onMerge(); i++) {
      const before = focusedLine(host.frame());
      await host.press('tab');
      await host.waitFor(() => focusedLine(host.frame()) !== before, 'the focus to move');
    }
    await host.waitFor(onMerge, 'focus on the Merge button');
    await host.press('enter');
    await host.waitFor(() => warned.length > 0, 'a reported failure');
    expect(warned.length).toBeGreaterThan(0);
    host.unmount();
  });
});
