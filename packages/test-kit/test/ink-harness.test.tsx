import { describe, it, expect } from 'vitest';
import React, { useState } from 'react';
import { Text, useInput } from 'ink';
import { mountHarness } from '../src/render/ink-harness.js';
import { KEYS } from '../src/render/keys.js';

function Counter(): React.JSX.Element {
  const [n, setN] = useState(0);
  useInput((_input, key) => {
    if (key.upArrow) setN((c) => c + 1);
    if (key.return) setN(0);
  });
  return <Text>Count: {n}</Text>;
}

// A key written before the input listener is attached is dropped, so every key first waits for the
// frame it depends on (the harness's waitFor also lets the mount effects run).
describe('mountHarness', () => {
  it('renders the initial frame', async () => {
    const h = mountHarness(<Counter />);
    await h.waitFor(() => h.frame() === 'Count: 0', 'the first frame');
    expect(h.frame()).toBe('Count: 0');
    h.unmount();
  });

  it('press() reaches useInput by key name', async () => {
    const h = mountHarness(<Counter />);
    await h.waitFor(() => h.frame() === 'Count: 0', 'the first frame');
    await h.press('up');
    await h.waitFor(() => h.frame() === 'Count: 1', 'one press');
    await h.press('up');
    await h.waitFor(() => h.frame() === 'Count: 2', 'two presses');
    await h.press('enter');
    await h.waitFor(() => h.frame() === 'Count: 0', 'the reset');
    expect(h.frame()).toBe('Count: 0');
    h.unmount();
  });

  it('frames() keeps the frame history', async () => {
    const h = mountHarness(<Counter />);
    await h.waitFor(() => h.frame() === 'Count: 0', 'the first frame');
    await h.press('up');
    await h.waitFor(() => h.frame() === 'Count: 1', 'one press');
    expect(h.frames()).toContain('Count: 0');
    expect(h.frames()).toContain('Count: 1');
    h.unmount();
  });

  it('press() accepts a raw escape sequence as well as a key name', async () => {
    const h = mountHarness(<Counter />);
    await h.waitFor(() => h.frame() === 'Count: 0', 'the first frame');
    await h.press(KEYS.up);
    await h.waitFor(() => h.frame() === 'Count: 1', 'one press');
    expect(h.frame()).toBe('Count: 1');
    h.unmount();
  });
});
