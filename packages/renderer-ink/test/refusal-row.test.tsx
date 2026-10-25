import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import type { AppSpec } from '@minitui/types';
import type { ActionDispatcher, ActionOutcome } from '@minitui/renderer-core';
import { mountInk } from '../src/mount.js';
import { createInkBinding } from '../src/widgets/bindings.js';
import { makeCatalog } from './support/make-catalog.js';
import { controlledIo } from './support/store-io.js';
import { makeController, makeRequest } from './support/controllers.js';
import { FakeStdin, FakeStdout, asReadStream, asWriteStream } from './support/fake-streams.js';
import { awaitFocusOn, lastOf, until } from './support/focus-waits.js';

const RLO = String.fromCharCode(0x202e); // right-to-left override
const ESC = String.fromCharCode(27);
const BEL = String.fromCharCode(7);

const catalog = makeCatalog({
  id: 'refusal',
  components: { Button: { trustTier: 'interactive' } },
  actions: {
    merge: {
      kind: 'exec-local',
      params: z.object({}),
      permission: { danger: false, resourceTemplate: 'merge', summaryTemplate: 'merge' },
    },
  },
});

const spec: AppSpec = {
  root: 'btn',
  elements: {
    btn: {
      type: 'Button',
      props: { label: 'Merge' },
      on: { press: { action: 'merge', params: {} } },
    },
  },
};

const failed = (stderrExcerpt: string): ActionOutcome => ({
  status: 'failed',
  fault: { actionKey: 'merge', exitCode: 1, stderrExcerpt },
});

// A mount whose dispatcher returns the scripted outcomes in order, and whose lifecycle sink records
// the phase of every event.
function harness(outcomes: readonly ActionOutcome[], columns = 80) {
  const queue = [...outcomes];
  const lifecycle: string[] = [];
  const dispatcher: ActionDispatcher = {
    dispatch: async () => queue.shift() ?? { status: 'settled' },
  };
  const stdin = new FakeStdin();
  const stdout = new FakeStdout({ columns });
  const controller = makeController([]);
  const handle = mountInk({
    spec,
    catalog,
    binding: createInkBinding(catalog),
    dispatcher,
    store: controlledIo({}),
    consent: controller,
    onLifecycle: { emit: (e) => lifecycle.push(e.phase) },
    io: { stdin: asReadStream(stdin), stdout: asWriteStream(stdout), debug: true },
  });
  return { handle, stdin, controller, lifecycle, frame: lastOf(stdout) };
}

// Enter on the focused button, then the line the refusal draws
async function pressMerge(run: ReturnType<typeof harness>): Promise<void> {
  await awaitFocusOn(run.frame, 'Merge');
  run.stdin.write('\r');
}

describe('the refusal row under the app', () => {
  it('a denied gated action draws one line under the app with the reason', async () => {
    const run = harness([{ status: 'denied', reason: 'no grant for ffmpeg' }]);
    await pressMerge(run);
    await until(() => run.frame().includes('did not complete'), 'the refusal line');
    expect(run.frame()).toContain('Action "merge" did not complete: no grant for ffmpeg');
    run.handle.unmount();
  });

  it('a failed action shows the excerpt on one line without carriage returns or format characters', async () => {
    const run = harness([failed(`boom\r\nline2${RLO}x\tend`)]);
    await pressMerge(run);
    await until(() => run.frame().includes('did not complete'), 'the refusal line');
    expect(run.frame()).toContain('did not complete: boom line2x end');
    expect(run.frame()).not.toContain(RLO);
    run.handle.unmount();
  });

  it('a terminal control in a failed excerpt never reaches the line', async () => {
    const run = harness([failed(`a${ESC}[31mb${ESC}]52;c;x${BEL}c`)]);
    await pressMerge(run);
    await until(() => run.frame().includes('did not complete'), 'the refusal line');
    expect(run.frame()).toContain('did not complete: abc');
    expect(run.frame()).not.toContain(BEL);
    // the only escape sequences in the frame are the ones ink writes for colour and cursor
    expect(run.frame()).not.toContain(`${ESC}]52`);
    run.handle.unmount();
  });

  it('the reason is cut to 160 characters', async () => {
    const run = harness([{ status: 'denied', reason: 'x'.repeat(1000) }], 300);
    await pressMerge(run);
    await until(() => run.frame().includes('did not complete'), 'the refusal line');
    expect(run.frame()).toContain(`${'x'.repeat(160)}…`);
    expect(run.frame()).not.toContain('x'.repeat(161));
    run.handle.unmount();
  });

  it('the line clears when the next gated action starts', async () => {
    const run = harness([{ status: 'denied', reason: 'no grant' }, { status: 'settled' }]);
    await pressMerge(run);
    await until(() => run.frame().includes('did not complete'), 'the refusal line');
    await pressMerge(run);
    // the sink recorded the second run, so the second Enter was handled
    await until(() => run.lifecycle.length === 4, 'the second run');
    await until(() => !run.frame().includes('did not complete'), 'the line to clear');
    run.handle.unmount();
  });

  it('the line is hidden while a request is pending', async () => {
    const run = harness([{ status: 'denied', reason: 'no grant' }]);
    await pressMerge(run);
    await until(() => run.frame().includes('did not complete'), 'the refusal line');
    run.controller.open(makeRequest());
    await until(() => run.frame().includes('Allow?'), 'the consent box');
    expect(run.frame()).not.toContain('did not complete');
    run.controller.resolve({ kind: 'deny' });
    await until(() => run.frame().includes('did not complete'), 'the line to come back');
    run.handle.unmount();
  });

  it('the lifecycle sink still receives every event', async () => {
    const run = harness([{ status: 'denied', reason: 'no grant' }]);
    await pressMerge(run);
    await until(() => run.lifecycle.length === 2, 'the two events');
    expect(run.lifecycle).toEqual(['started', 'error']);
    run.handle.unmount();
  });
});
