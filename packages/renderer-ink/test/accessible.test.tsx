import { describe, expect, it } from 'vitest';
import { render } from 'ink';
import type { AppSpec } from '@minitui/types';
import type { ActionDispatcher } from '@minitui/renderer-core';
import { createInkRenderer } from '../src/ink-renderer-port.js';
import { createInkBinding } from '../src/widgets/bindings.js';
import { makeCatalog } from './support/make-catalog.js';
import { controlledIo } from './support/store-io.js';
import { makeController } from './support/controllers.js';
import { FakeStdin, FakeStdout, asReadStream, asWriteStream } from './support/fake-streams.js';

const catalog = makeCatalog({ id: 'a11y', components: { Text: { trustTier: 'display' } } });
const ok: ActionDispatcher = { dispatch: async () => ({ status: 'settled' as const }) };
const spec: AppSpec = { root: 't', elements: { t: { type: 'Text', props: { text: 'x' } } } };

// a real wrapping render: it records the options it is given and then calls ink's render
function recordingRender() {
  const seen: Array<Record<string, unknown>> = [];
  const wrapped: typeof render = (tree, options) => {
    seen.push({ ...options });
    return render(tree, options);
  };
  return { seen, wrapped };
}

async function optionsFor(accessible: boolean | undefined): Promise<Record<string, unknown>> {
  const { seen, wrapped } = recordingRender();
  const port = createInkRenderer({
    catalog,
    store: controlledIo({}),
    consent: makeController([]),
    io: {
      stdin: asReadStream(new FakeStdin()),
      stdout: asWriteStream(new FakeStdout()),
      debug: true,
    },
    renderInk: wrapped,
  });
  const handle = await port.mount({
    spec,
    binding: createInkBinding(catalog),
    dispatcher: ok,
    ...(accessible !== undefined ? { accessible } : {}),
  });
  handle.unmount();
  const options = seen[0];
  if (options === undefined) throw new Error('the render seam was not used');
  return options;
}

describe('the accessibility options reach ink', () => {
  it('accessible true sets the screen-reader flag and console patching stays off', async () => {
    const options = await optionsFor(true);
    expect(options.isScreenReaderEnabled).toBe(true);
    expect(options.patchConsole).toBe(false);
  });

  it('control: accessible omitted leaves the flag out, so the environment default holds', async () => {
    const options = await optionsFor(undefined);
    expect('isScreenReaderEnabled' in options).toBe(false);
    expect(options.patchConsole).toBe(false);
  });
});
