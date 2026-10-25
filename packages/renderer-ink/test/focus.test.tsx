import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import type { AppSpec } from '@minitui/types';
import type { ActionDispatcher, DispatchContext } from '@minitui/renderer-core';
import { mountInk } from '../src/mount.js';
import { createInkBinding } from '../src/widgets/bindings.js';
import type { ConsentController } from '../src/widgets/consent-overlay.js';
import { makeCatalog } from './support/make-catalog.js';
import { controlledIo } from './support/store-io.js';
import { makeController, makeRequest } from './support/controllers.js';
import { FakeStdin, FakeStdout, asReadStream, asWriteStream } from './support/fake-streams.js';
import { afterEffects, awaitFocusOn, lastOf, until } from './support/focus-waits.js';

// Tab moves the focus ring across widgets only with the patch that keeps the focus effect's
// dependencies of @json-render/ink stable. These rows drive the real mounted tree with real key
// bytes ('\t' is Tab, ESC [ Z is Shift+Tab) and wait for what each key depends on, never for a time.

const TAB = '\t';
const SHIFT_TAB = String.fromCharCode(27) + '[Z';

const catalog = makeCatalog({
  id: 'focus',
  components: {
    Box: { trustTier: 'display' },
    Button: { trustTier: 'interactive' },
    Select: { trustTier: 'interactive' },
  },
  actions: {
    go: {
      kind: 'exec-local',
      params: z.object({}),
      permission: { danger: false, resourceTemplate: 'go', summaryTemplate: 'go' },
    },
  },
});

const button = (label: string) => ({
  type: 'Button' as const,
  props: { label },
  on: { press: { action: 'go', params: {} } },
});

function mount(spec: AppSpec, consent?: ConsentController) {
  const dispatched: DispatchContext[] = [];
  const dispatcher: ActionDispatcher = {
    dispatch: async (_name, ctx) => {
      dispatched.push(ctx);
      return { status: 'settled', result: 'ok' } as const;
    },
  };
  const stdin = new FakeStdin();
  const stdout = new FakeStdout();
  const controller = consent ?? makeController([]);
  const handle = mountInk({
    spec,
    catalog,
    binding: createInkBinding(catalog),
    dispatcher,
    store: controlledIo({}),
    consent: controller,
    io: { stdin: asReadStream(stdin), stdout: asWriteStream(stdout), debug: true },
  });
  return { dispatched, stdin, handle, frame: lastOf(stdout), controller };
}

const three: AppSpec = {
  root: 'col',
  elements: {
    col: { type: 'Box', props: { flexDirection: 'column' }, children: ['a', 'b', 'c'] },
    a: button('Alpha'),
    b: button('Bravo'),
    c: button('Charlie'),
  },
};

describe('focus traversal on the real tree', () => {
  it('three widgets: Tab, Tab reaches the third, Shift+Tab goes back; a key acts on the focused widget only', async () => {
    const { dispatched, stdin, handle, frame } = mount(three);
    await awaitFocusOn(frame, 'Alpha');
    stdin.write(TAB);
    await awaitFocusOn(frame, 'Bravo');
    stdin.write(TAB);
    await awaitFocusOn(frame, 'Charlie');
    stdin.write('\r');
    await until(() => dispatched.length === 1, 'the dispatch from the third widget');
    stdin.write(SHIFT_TAB);
    await awaitFocusOn(frame, 'Bravo');
    stdin.write('\r');
    await until(() => dispatched.length === 2, 'the dispatch from the second widget');
    expect(dispatched.map((d) => d.elementKey)).toEqual(['c', 'b']);
    handle.unmount();
  });

  it('focus survives a consent modal: the same widget holds it after the request is resolved', async () => {
    const controller = makeController([]);
    const { dispatched, stdin, handle, frame } = mount(three, controller);
    await awaitFocusOn(frame, 'Alpha');
    stdin.write(TAB);
    await awaitFocusOn(frame, 'Bravo');
    controller.open(makeRequest());
    await until(() => frame().includes('Allow?'), 'the consent box'); // the app is not drawn now
    await afterEffects();
    controller.resolve({ kind: 'deny' });
    await awaitFocusOn(frame, 'Bravo'); // the app is drawn again, focus on the second widget
    stdin.write('\r');
    await until(() => dispatched.length === 1, 'the dispatch from the second widget');
    expect(dispatched.map((d) => d.elementKey)).toEqual(['b']);
    handle.unmount();
  });

  it('a custom Button, a standard Select, then a second Button: Tab walks all three', async () => {
    const mixed: AppSpec = {
      root: 'col',
      elements: {
        col: {
          type: 'Box',
          props: { flexDirection: 'column' },
          children: ['first', 'pick', 'second'],
        },
        first: button('First'),
        pick: {
          type: 'Select',
          props: {
            label: 'Codec',
            options: [
              { label: 'H264', value: 'h264' },
              { label: 'VP9', value: 'vp9' },
            ],
          },
        },
        second: button('Second'),
      },
    };
    const { dispatched, stdin, handle, frame } = mount(mixed);
    const buttonLines = (): string[] =>
      frame()
        .split('\n')
        .filter((line) => line.includes('First') || line.includes('Second'));
    await awaitFocusOn(frame, 'First');
    stdin.write(TAB);
    // the Select draws no '> ' marker, so the proof that focus left the first Button is that no
    // Button line holds one
    await until(() => buttonLines().every((line) => !line.includes('> ')), 'focus on the Select');
    await afterEffects();
    stdin.write(TAB);
    await awaitFocusOn(frame, 'Second');
    stdin.write('\r');
    await until(() => dispatched.length === 1, 'the dispatch from the second Button');
    expect(dispatched.map((d) => d.elementKey)).toEqual(['second']);
    handle.unmount();
  });
});
