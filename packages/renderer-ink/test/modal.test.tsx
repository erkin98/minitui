import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import type { AppSpec, DiagnosticsPort } from '@minitui/types';
import type { ActionDispatcher, DispatchContext } from '@minitui/renderer-core';
import { mountInk } from '../src/mount.js';
import { createInkBinding } from '../src/widgets/bindings.js';
import { makeCatalog } from './support/make-catalog.js';
import { controlledIo } from './support/store-io.js';
import { makeController, makeRequest, type TestController } from './support/controllers.js';
import { FakeStdin, FakeStdout, asReadStream, asWriteStream } from './support/fake-streams.js';
import {
  afterEffects,
  awaitFocus,
  awaitMounted,
  lastOf,
  settled,
  until,
} from './support/focus-waits.js';

// While a consent request is pending the keyboard belongs to the overlay. These rows drive the real
// tree with real key bytes and check that nothing reaches a widget or the shell, including a key
// that arrives in the very commit that first shows the prompt.

const catalog = makeCatalog({
  id: 'modal',
  components: {
    Box: { trustTier: 'display' },
    Text: { trustTier: 'display' },
    Button: { trustTier: 'interactive' },
    OrderList: { trustTier: 'interactive' },
    FilePicker: { trustTier: 'interactive', capturesText: true },
  },
  actions: {
    log: { kind: 'render-local', params: z.object({}) },
    exit: { kind: 'render-local', params: z.object({}) },
    go: {
      kind: 'exec-local',
      params: z.object({}),
      permission: { danger: false, resourceTemplate: 'go', summaryTemplate: 'go' },
    },
  },
});

interface Mounted {
  readonly dispatched: DispatchContext[];
  readonly stdin: FakeStdin;
  readonly stdout: FakeStdout;
  readonly store: ReturnType<typeof controlledIo>;
  readonly controller: TestController;
  readonly handle: ReturnType<typeof mountInk>;
  readonly quits: { quit: number; cancel: number };
  readonly frame: () => string;
}

function mount(
  spec: AppSpec,
  controller: TestController,
  seed: Record<string, unknown> = {},
  diagnostics?: DiagnosticsPort,
): Mounted {
  const dispatched: DispatchContext[] = [];
  const dispatcher: ActionDispatcher = {
    dispatch: async (_name, ctx) => {
      dispatched.push(ctx);
      return { status: 'settled', result: 'ok' } as const;
    },
  };
  const quits = { quit: 0, cancel: 0 };
  const stdin = new FakeStdin();
  const stdout = new FakeStdout();
  const store = controlledIo(seed);
  const handle = mountInk({
    spec,
    catalog,
    binding: createInkBinding(catalog),
    dispatcher,
    store,
    consent: controller,
    ...(diagnostics !== undefined ? { diagnostics } : {}),
    onQuit: () => {
      quits.quit++;
    },
    onCancel: () => {
      quits.cancel++;
    },
    io: { stdin: asReadStream(stdin), stdout: asWriteStream(stdout), debug: true },
  });
  return { dispatched, stdin, stdout, store, controller, handle, quits, frame: lastOf(stdout) };
}

// run `act` from the stream's write of the first frame that holds the consent prompt: that write
// happens inside the commit that first shows the box
function onFirstPromptFrame(stdout: FakeStdout, act: () => void): { fired: () => boolean } {
  let fired = false;
  const write = stdout.write;
  stdout.write = (chunk: string): boolean => {
    const ok = write(chunk);
    if (!fired && chunk.includes('Allow?')) {
      fired = true;
      act();
    }
    return ok;
  };
  return { fired: () => fired };
}

const button: AppSpec = {
  root: 'b',
  elements: {
    b: { type: 'Button', props: { label: 'Go' }, on: { press: { action: 'go', params: {} } } },
  },
};

describe('a pending request owns the keyboard', () => {
  it('control: an OrderList first in the ring does not reorder while a request is pending', async () => {
    const list: AppSpec = {
      root: 'ol',
      elements: {
        ol: {
          type: 'OrderList',
          props: { items: { $bindState: '/inputs' } },
          on: { reorder: { action: 'go', params: {} } },
        },
      },
    };
    const app = mount(list, makeController([makeRequest()]), { inputs: ['a.mp4', 'b.mp4'] });
    await awaitMounted(app.stdout);
    app.stdin.write('\x1B[1;2B'); // shift+down
    await afterEffects();
    expect(app.store.getSnapshot()).toEqual({ inputs: ['a.mp4', 'b.mp4'] });
    expect(app.dispatched).toEqual([]);
    app.handle.unmount();
  });

  it('control: a FilePicker first in the ring does not take Enter or text while a request is pending', async () => {
    const picker: AppSpec = {
      root: 'fp',
      elements: {
        fp: {
          type: 'FilePicker',
          props: { label: 'out', value: { $bindState: '/out' } },
          on: { change: { action: 'go', params: {} } },
        },
      },
    };
    const app = mount(picker, makeController([makeRequest()]), { out: '' });
    await awaitMounted(app.stdout);
    app.stdin.write('x');
    // let the draft re-render, so that an Enter written next would write 'x' back if the widget were live
    await settled(app.stdout);
    app.stdin.write('\r');
    await settled(app.stdout);
    expect(app.store.getSnapshot()).toEqual({ out: '' });
    expect(app.dispatched).toEqual([]);
    app.handle.unmount();
  });

  it('a key written in the commit that first shows the prompt dispatches nothing', async () => {
    const controller = makeController([]);
    const app = mount(button, controller);
    await awaitFocus(app.frame);
    const hook = onFirstPromptFrame(app.stdout, () => app.stdin.write('\r'));
    controller.open(makeRequest());
    await until(hook.fired, 'the first frame of the prompt');
    await afterEffects();
    expect(app.dispatched).toEqual([]);
    app.handle.unmount();
  });

  it('control: Escape and q written in the commit that first shows the prompt reach neither the quit nor the cancel outlet', async () => {
    const controller = makeController([]);
    const app = mount(button, controller);
    await awaitFocus(app.frame);
    const hook = onFirstPromptFrame(app.stdout, () => {
      app.stdin.write(String.fromCharCode(27));
      app.stdin.write('q');
    });
    controller.open(makeRequest());
    await until(hook.fired, 'the first frame of the prompt');
    await afterEffects();
    expect(app.quits).toEqual({ quit: 0, cancel: 0 });
    app.handle.unmount();
  });
});

function sink() {
  const warnings: Array<{ msg: string; meta: Record<string, unknown> | undefined }> = [];
  const diagnostics: DiagnosticsPort = {
    warn: (msg, meta) => {
      warnings.push({ msg, meta });
    },
    debug() {},
  };
  return { diagnostics, warnings };
}

describe('failures are contained and reported', () => {
  it('a throwing action subscriber is reported and the action is still dispatched', async () => {
    const { diagnostics, warnings } = sink();
    const app = mount(button, makeController([]), {}, diagnostics);
    app.handle.onAction(() => {
      throw new Error('subscriber failed');
    });
    await awaitFocus(app.frame);
    app.stdin.write('\r');
    await until(() => app.dispatched.length === 1, 'the dispatch');
    expect(warnings).toHaveLength(1);
    app.handle.unmount();
  });

  it('log and exit bound in a spec end without an unhandled rejection and with one report each', async () => {
    const { diagnostics, warnings } = sink();
    const spec: AppSpec = {
      root: 'col',
      elements: {
        col: { type: 'Box', props: {}, children: ['l', 'e'] },
        l: { type: 'Button', props: { label: 'L' }, on: { press: { action: 'log', params: {} } } },
        e: { type: 'Button', props: { label: 'E' }, on: { press: { action: 'exit', params: {} } } },
      },
    };
    const app = mount(spec, makeController([]), {}, diagnostics);
    await awaitMounted(app.stdout);
    await app.handle.fireAction('l', 'press');
    expect(warnings).toHaveLength(1);
    await app.handle.fireAction('e', 'press');
    expect(warnings).toHaveLength(2);
    await afterEffects();
    app.handle.unmount();
  });
});

describe('Escape is exclusive while a request is pending', () => {
  it('one Escape denies the request and does not also cancel the app, after the spec was updated', async () => {
    const controller = makeController([makeRequest()]);
    const app = mount(button, controller);
    await awaitMounted(app.stdout);
    // a re-render registers the listeners again, which is where their order used to matter
    app.handle.update(button);
    await afterEffects();
    app.stdin.write(String.fromCharCode(27));
    // both listeners get the same input event, so once the deny is recorded a wrong cancel has run
    await until(() => controller.decisions.length > 0, 'the deny');
    await afterEffects();
    expect(controller.decisions).toEqual([{ kind: 'deny' }]);
    expect(app.quits.cancel).toBe(0);
    app.handle.unmount();
  });
});
