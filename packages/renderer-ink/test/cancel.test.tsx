import { describe, expect, it } from 'vitest';
import { render } from 'ink';
import { sanitize } from '@minitui/sanitizer';
import type { AppSpec } from '@minitui/types';
import type { ActionDispatcher } from '@minitui/renderer-core';
import { mountInk } from '../src/mount.js';
import { createInkRenderer } from '../src/ink-renderer-port.js';
import { createInkBinding } from '../src/widgets/bindings.js';
import type { ConsentDecision } from '../src/widgets/consent-overlay.js';
import { makeCatalog } from './support/make-catalog.js';
import { controlledIo } from './support/store-io.js';
import { makeController, makeRequest, type TestController } from './support/controllers.js';
import { FakeStdin, FakeStdout, asReadStream, asWriteStream } from './support/fake-streams.js';
import { afterEffects, awaitFocusOn, lastOf, until } from './support/focus-waits.js';

const catalog = makeCatalog({
  id: 'cancel',
  components: {
    Button: { trustTier: 'interactive' },
    FilePicker: { trustTier: 'interactive', capturesText: true },
  },
});
const ok: ActionDispatcher = { dispatch: async () => ({ status: 'settled' as const }) };

const buttonSpec: AppSpec = {
  root: 'go',
  elements: { go: { type: 'Button', props: { label: 'Go' } } },
};
const pickerSpec: AppSpec = {
  root: 'fp',
  elements: {
    fp: { type: 'FilePicker', props: { label: 'out', value: { $bindState: '/out' } } },
  },
};

// a real wrapping render: it records the options it is given and then calls ink's render
function recordingRender() {
  const seen: Array<Record<string, unknown>> = [];
  const wrapped: typeof render = (tree, options) => {
    seen.push({ ...options });
    return render(tree, options);
  };
  return { seen, wrapped };
}

const fakeIo = () => ({
  stdin: asReadStream(new FakeStdin()),
  stdout: asWriteStream(new FakeStdout()),
  debug: true,
});

// a mount whose consent controller and cancel outlet write to one list, so the order of the two is
// visible
function mountWithOrder(spec: AppSpec) {
  const order: string[] = [];
  const inner = makeController([]);
  const controller: TestController = {
    decisions: inner.decisions,
    get request() {
      return inner.request;
    },
    subscribe: (listener) => inner.subscribe(listener),
    open: (request) => {
      inner.open(request);
    },
    listenerCount: () => inner.listenerCount(),
    resolve(decision: ConsentDecision) {
      order.push(`resolve:${decision.kind}`);
      inner.resolve(decision);
    },
  };
  const stdin = new FakeStdin();
  const stdout = new FakeStdout();
  const handle = mountInk({
    spec,
    catalog,
    binding: createInkBinding(catalog),
    dispatcher: ok,
    store: controlledIo({ out: '' }),
    consent: controller,
    onCancel: () => {
      order.push('cancel');
    },
    io: { stdin: asReadStream(stdin), stdout: asWriteStream(stdout), debug: true },
  });
  return { order, controller, stdin, stdout, handle };
}

// the consent box is up and its listeners are attached
async function openBox(controller: TestController, frame: () => string): Promise<void> {
  controller.open(makeRequest());
  await until(() => frame().includes('Allow?'), 'the consent box');
  await afterEffects();
}

describe('the ink exit option', () => {
  it('the port mount hands ink exitOnCtrlC false', async () => {
    const { seen, wrapped } = recordingRender();
    const port = createInkRenderer({
      catalog,
      store: controlledIo({}),
      consent: makeController([]),
      io: fakeIo(),
      renderInk: wrapped,
    });
    const handle = await port.mount({
      spec: buttonSpec,
      binding: createInkBinding(catalog),
      dispatcher: ok,
    });
    handle.unmount();
    expect(seen[0]?.exitOnCtrlC).toBe(false);
  });

  it('mountInk passes exitOnCtrlC true when asked', () => {
    const { seen, wrapped } = recordingRender();
    const handle = mountInk({
      spec: buttonSpec,
      catalog,
      binding: createInkBinding(catalog),
      dispatcher: ok,
      store: controlledIo({}),
      consent: makeController([]),
      exitOnCtrlC: true,
      renderInk: wrapped,
      io: fakeIo(),
    });
    handle.unmount();
    expect(seen[0]?.exitOnCtrlC).toBe(true);
  });
});

describe('Ctrl-C is cancel', () => {
  it('Ctrl-C with a request pending denies it and then cancels', async () => {
    const { order, controller, stdin, stdout, handle } = mountWithOrder(buttonSpec);
    const frame = lastOf(stdout);
    await awaitFocusOn(frame, 'Go');
    await openBox(controller, frame);
    stdin.write('\x03');
    await until(() => order.length === 2, 'the deny and the cancel');
    expect(order).toEqual(['resolve:deny', 'cancel']);
    expect(controller.request).toBeUndefined();
    handle.unmount();
  });

  it('Ctrl-C with no request pending cancels and decides nothing', async () => {
    const { order, controller, stdin, stdout, handle } = mountWithOrder(buttonSpec);
    await awaitFocusOn(lastOf(stdout), 'Go');
    stdin.write('\x03');
    await until(() => order.length === 1, 'the cancel');
    expect(order).toEqual(['cancel']);
    expect(controller.decisions).toEqual([]);
    handle.unmount();
  });

  it('a focused file picker ignores Ctrl and Alt chords', async () => {
    const { stdin, stdout, handle } = mountWithOrder(pickerSpec);
    const frame = lastOf(stdout);
    await awaitFocusOn(frame, 'out');
    stdin.write('x');
    stdin.write('\x03'); // Ctrl-C
    stdin.write('\x01'); // Ctrl-A
    stdin.write('\x1bz'); // Alt-z
    // a plain key after the chords is the positive event: the draft is exactly xy, so no chord
    // letter (c, a, z) was appended between them
    stdin.write('y');
    await until(() => sanitize(frame()).includes('> xy'), 'the draft xy');
    handle.unmount();
  });

  it('Ctrl-Z leaves a pending request pending and does not exit', async () => {
    const { order, controller, stdin, stdout, handle } = mountWithOrder(buttonSpec);
    const frame = lastOf(stdout);
    await awaitFocusOn(frame, 'Go');
    await openBox(controller, frame);
    stdin.write('\x1a');
    await afterEffects();
    // a plain n decides: the request was still pending, so Ctrl-Z decided nothing and ink did not exit
    stdin.write('n');
    await until(() => controller.decisions.length > 0, 'the deny');
    expect(controller.decisions).toEqual([{ kind: 'deny' }]);
    expect(order).toEqual(['resolve:deny']);
    handle.unmount();
  });
});
