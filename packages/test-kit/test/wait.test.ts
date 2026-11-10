import { describe, it, expect } from 'vitest';
import { until, waitFor } from '../src/render/wait.js';

describe('until', () => {
  it('resolves once the condition holds', async () => {
    let polls = 0;
    await until(() => ++polls >= 3, 'the third poll');
    expect(polls).toBe(3);
  });

  it('gives up after the given number of attempts and names what it waited for', async () => {
    await expect(until(() => false, 'a frame that never comes', 2)).rejects.toThrow(
      'timed out waiting for a frame that never comes',
    );
  });
});

describe('waitFor', () => {
  it('resolves after the condition holds and the effects have flushed', async () => {
    let effects = 0;
    setImmediate(() => setImmediate(() => effects++));
    await waitFor(() => true, 'an immediate condition');
    expect(effects).toBe(1);
  });
});
