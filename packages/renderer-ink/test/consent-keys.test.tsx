import { describe, expect, it } from 'vitest';
import type { AppSpec } from '@minitui/types';
import type { ActionDispatcher } from '@minitui/renderer-core';
import { mountInk } from '../src/mount.js';
import { createInkBinding } from '../src/widgets/bindings.js';
import type { ConsentDecision } from '../src/widgets/consent-overlay.js';
import { makeCatalog } from './support/make-catalog.js';
import { controlledIo } from './support/store-io.js';
import { makeController, makeRequest } from './support/controllers.js';
import { FakeStdin, FakeStdout, asReadStream, asWriteStream } from './support/fake-streams.js';
import { afterEffects, awaitFocusOn, lastOf, until } from './support/focus-waits.js';

const catalog = makeCatalog({
  id: 'consent-keys',
  components: { Button: { trustTier: 'interactive' } },
});
const ok: ActionDispatcher = { dispatch: async () => ({ status: 'settled' as const }) };
const spec: AppSpec = {
  root: 'go',
  elements: { go: { type: 'Button', props: { label: 'Go' } } },
};

// A fresh mount with a consent box open, the keys written, and the first decision read. A key waits for
// what it depends on: the focus marker of the app while no request is pending (once a request is
// pending the app is hidden and draws no marker), then the box, then the effects that attach its
// listener.
async function decisionsAfter(
  keys: (stdin: FakeStdin) => Promise<void> | void,
): Promise<readonly ConsentDecision[]> {
  const controller = makeController([]);
  const stdin = new FakeStdin();
  const stdout = new FakeStdout();
  const handle = mountInk({
    spec,
    catalog,
    binding: createInkBinding(catalog),
    dispatcher: ok,
    store: controlledIo({}),
    consent: controller,
    io: { stdin: asReadStream(stdin), stdout: asWriteStream(stdout), debug: true },
  });
  const frame = lastOf(stdout);
  await awaitFocusOn(frame, 'Go');
  controller.open(makeRequest());
  await until(() => frame().includes('Allow?'), 'the consent box');
  await afterEffects();
  await keys(stdin);
  await until(() => controller.decisions.length > 0, 'a decision');
  const seen = [...controller.decisions];
  handle.unmount();
  return seen;
}

// A chunk that must decide nothing: it is followed by a plain n, the key that does decide, so its
// absence is asserted only after a key that proves the box was listening.
const thenDeny =
  (chunk: string) =>
  async (stdin: FakeStdin): Promise<void> => {
    stdin.write(chunk);
    await afterEffects();
    stdin.write('n');
  };

// one key, written once the box is listening
const press =
  (key: string) =>
  (stdin: FakeStdin): void => {
    stdin.write(key);
  };

describe('the approval keys are plain keys', () => {
  it.each(['\x19', '\x01', '\x1by', '\x1ba'])('the chord %j decides nothing', async (chord) => {
    expect(await decisionsAfter(thenDeny(chord))).toEqual([{ kind: 'deny' }]);
  });

  it.each(['yy', 'ya', 'yes', 'ay', 'y\r'])(
    'the pasted chunk %j decides nothing',
    async (chunk) => {
      expect(await decisionsAfter(thenDeny(chunk))).toEqual([{ kind: 'deny' }]);
    },
  );

  it('a plain y still allows and a plain A still grants', async () => {
    expect(await decisionsAfter(press('y'))).toEqual([{ kind: 'allow' }]);
    expect(await decisionsAfter(press('A'))).toEqual([{ kind: 'always', cascade: false }]);
  });

  it.each(['n', '\x1b', '\x0e'])('the key %j denies, with or without Ctrl', async (key) => {
    expect(await decisionsAfter(press(key))).toEqual([{ kind: 'deny' }]);
  });
});
