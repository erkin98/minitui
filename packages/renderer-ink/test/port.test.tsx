import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import type { AppSpec } from '@minitui/types';
import type { ActionDispatcher, RenderHandle, RendererPort } from '@minitui/renderer-core';
import { createInkRenderer, inkMount } from '../src/ink-renderer-port.js';
import { createInkBinding } from '../src/widgets/bindings.js';
import { makeCatalog } from './support/make-catalog.js';
import { controlledIo } from './support/store-io.js';
import { makeController } from './support/controllers.js';
import { FakeStdin, FakeStdout, asReadStream, asWriteStream } from './support/fake-streams.js';
import { afterEffects, awaitFocus, awaitMounted, lastOf, until } from './support/focus-waits.js';

const catalog = makeCatalog({
  id: 'port',
  components: {
    Box: { trustTier: 'display' },
    Text: { trustTier: 'display' },
    Button: { trustTier: 'interactive' },
    Ghost: { trustTier: 'display' },
  },
  actions: {
    go: {
      kind: 'exec-local',
      params: z.object({ n: z.number() }),
      permission: { danger: false, resourceTemplate: 'go', summaryTemplate: 'go' },
    },
  },
});

const ok: ActionDispatcher = { dispatch: async () => ({ status: 'settled', result: 'ok' }) };

function renderer() {
  const stdin = new FakeStdin();
  const stdout = new FakeStdout();
  const port = createInkRenderer({
    catalog,
    store: controlledIo({}),
    consent: makeController([]),
    io: { stdin: asReadStream(stdin), stdout: asWriteStream(stdout), debug: true },
  });
  return { port, stdin, stdout, frame: lastOf(stdout) };
}

const text = (value: string): AppSpec => ({
  root: 't',
  elements: { t: { type: 'Text', props: { text: value } } },
});

function refusalOf(error: unknown): { code: unknown; message: string } {
  if (!(error instanceof Error)) return { code: undefined, message: '' };
  return { code: (error as { code?: unknown }).code, message: error.message };
}

async function rejection(
  run: () => Promise<RenderHandle>,
): Promise<{ code: unknown; message: string }> {
  try {
    const handle = await run();
    handle.unmount();
  } catch (error) {
    return refusalOf(error);
  }
  return { code: undefined, message: '' };
}

describe('the renderer port, driven through createInkRenderer', () => {
  it('a frame is observed after mount', async () => {
    const { port, stdout, frame } = renderer();
    const handle = await port.mount({
      spec: text('FIRST-TEXT'),
      binding: createInkBinding(catalog),
      dispatcher: ok,
    });
    await awaitMounted(stdout);
    expect(frame()).toContain('FIRST-TEXT');
    handle.unmount();
  });

  it('a frame is observed after update with changed text', async () => {
    const { port, stdout, frame } = renderer();
    const handle = await port.mount({
      spec: text('BEFORE'),
      binding: createInkBinding(catalog),
      dispatcher: ok,
    });
    await awaitMounted(stdout);
    handle.update(text('AFTER'));
    await until(() => frame().includes('AFTER'), 'the updated text');
    expect(frame()).not.toContain('BEFORE');
    handle.unmount();
  });

  it('a real keypress on a bound Button reaches an onAction subscriber', async () => {
    const { port, stdin, frame } = renderer();
    const spec: AppSpec = {
      root: 'b',
      elements: {
        b: {
          type: 'Button',
          props: { label: 'Go' },
          on: { press: { action: 'go', params: { n: 2 } } },
        },
      },
    };
    const handle = await port.mount({ spec, binding: createInkBinding(catalog), dispatcher: ok });
    const seen: Array<{ actionName: string; elementKey: string; params: unknown }> = [];
    handle.onAction((request) => seen.push(request));
    await awaitFocus(frame);
    stdin.write('\r');
    await until(() => seen.length > 0, 'the action request');
    expect(seen).toEqual([{ actionName: 'go', elementKey: 'b', params: { n: 2 } }]);
    handle.unmount();
  });

  it('q calls onQuit and Escape calls onCancel', async () => {
    const { port, stdin, stdout } = renderer();
    let quit = 0;
    let cancel = 0;
    const handle = await port.mount({
      spec: text('x'),
      binding: createInkBinding(catalog),
      dispatcher: ok,
      onQuit: () => {
        quit++;
      },
      onCancel: () => {
        cancel++;
      },
    });
    await awaitMounted(stdout);
    stdin.write('q');
    await until(() => quit === 1, 'the quit');
    stdin.write(String.fromCharCode(27));
    await until(() => cancel === 1, 'the cancel');
    handle.unmount();
  });

  it('a component the binding cannot resolve is refused at mount and at update, naming it and the catalog', async () => {
    const { port } = renderer();
    const binding = createInkBinding(catalog);
    const spec: AppSpec = { root: 'g', elements: { g: { type: 'Ghost', props: {} } } };
    const atMount = await rejection(() => port.mount({ spec, binding, dispatcher: ok }));
    expect(atMount.code).toBe('unbound-component');
    expect(atMount.message).toContain('Ghost');
    expect(atMount.message).toContain('port');
    const handle = await port.mount({ spec: text('x'), binding, dispatcher: ok });
    let atUpdate = { code: undefined as unknown, message: '' };
    try {
      handle.update(spec);
    } catch (error) {
      atUpdate = refusalOf(error);
    }
    expect(atUpdate.code).toBe('unbound-component');
    expect(atUpdate.message).toContain('Ghost');
    handle.unmount();
  });

  it('a defined initialState is refused, null included; undefined mounts', async () => {
    const { port } = renderer();
    const binding = createInkBinding(catalog);
    const wanted = 'the Ink renderer does not accept initialState: its store is controlled';
    for (const initialState of [{ a: 1 }, null]) {
      const result = await rejection(() =>
        port.mount({ spec: text('x'), binding, dispatcher: ok, initialState }),
      );
      expect(result).toEqual({ code: 'initial-state-unsupported', message: wanted });
    }
    const handle = await port.mount({
      spec: text('x'),
      binding,
      dispatcher: ok,
      initialState: undefined,
    });
    await afterEffects();
    handle.unmount();
  });

  it('the implementation accepts the port argument type unchanged (strict, no cast)', () => {
    // An arrow-function target is compared with strict parameter types, so a narrower argument type on
    // the implementation would not compile here. The port interface declares a method, which TypeScript
    // compares loosely, and that is why the witness is not stated against the port itself.
    const deps = {
      catalog,
      store: controlledIo({}),
      consent: makeController([]),
    };
    const strict: (args: Parameters<RendererPort['mount']>[0]) => Promise<RenderHandle> =
      inkMount(deps);
    expect(typeof strict).toBe('function');
  });
});
