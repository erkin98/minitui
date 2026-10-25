import type { FakeStdout } from './fake-streams.js';

// A key written before the mount effects have run reaches no handler: the widget has not
// registered with the focus ring yet, so the press is dropped. Wait for what the key depends
// on, not for a fixed time. The clock is frozen in tests, so count attempts instead of reading it.
export async function until(cond: () => boolean, what: string, attempts = 1000): Promise<void> {
  for (let i = 0; !cond(); i++) {
    if (i >= attempts) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 5));
  }
}

// React commits the frame first and flushes the effects (listener attach) on the next immediates.
export const afterEffects = (): Promise<void> =>
  new Promise((r) => setImmediate(() => setImmediate(r)));

export const lastOf =
  (out: FakeStdout): (() => string) =>
  () =>
    out.frames.at(-1) ?? '';

// A display-only tree renders an empty frame, so "mounted" means a frame was written.
export const awaitMounted = async (out: FakeStdout): Promise<void> => {
  await until(() => out.frames.length > 0, 'the first frame');
  await afterEffects();
};

// Every focusable widget prints '> ' while it holds focus and two spaces otherwise.
export const awaitFocus = async (frame: () => string): Promise<void> => {
  await until(() => frame().includes('> '), 'a focused widget in the frame');
  await afterEffects();
};

// Wait until the line of the frame that holds `label` also holds the focus marker. Focus moves
// through scheduled renders and effects, so the key after a Tab waits for this, never for a fixed time.
export const awaitFocusOn = async (frame: () => string, label: string): Promise<void> => {
  const focused = (): boolean =>
    frame()
      .split('\n')
      .some((line) => line.includes(label) && line.includes('> '));
  await until(focused, `focus on ${label}`);
  await afterEffects();
};

// Wait until the stream has stopped receiving writes: three polls in a row (40 ms apart, beyond the
// renderer's throttle window) see the same count. Counted in attempts; the clock is frozen in tests.
export async function settled(out: FakeStdout, attempts = 200): Promise<void> {
  let stable = 0;
  let seen = out.frames.length;
  for (let i = 0; stable < 3; i++) {
    if (i >= attempts) throw new Error('timed out waiting for the output to settle');
    await new Promise((r) => setTimeout(r, 40));
    if (out.frames.length === seen) stable++;
    else {
      stable = 0;
      seen = out.frames.length;
    }
  }
}
