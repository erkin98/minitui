import { describe, it, expect } from 'vitest';
import { repeatedToolCallDetector } from '../src/guards/loop-guard.js';

// Build the minimal step-ish shape the detector reads: each step's toolCalls.
function step(calls: Array<{ toolName: string; input: unknown }>) {
  return { toolCalls: calls.map((c) => ({ toolName: c.toolName, input: c.input })) };
}

describe('repeatedToolCallDetector', () => {
  it('does NOT stop while calls differ', async () => {
    const stop = repeatedToolCallDetector(3);
    const steps = [
      step([{ toolName: 'ffmpeg', input: { a: 1 } }]),
      step([{ toolName: 'ffmpeg', input: { a: 2 } }]),
    ];
    expect(await stop({ steps })).toBe(false);
  });

  it('stops when the SAME tool+input repeats `limit` times in a row', async () => {
    const stop = repeatedToolCallDetector(3);
    const same = { toolName: 'probe', input: { f: '/v.mp4' } };
    const steps = [step([same]), step([same]), step([same])];
    expect(await stop({ steps })).toBe(true);
  });

  it('resets the run length when a different call breaks the streak', async () => {
    const stop = repeatedToolCallDetector(3);
    const same = { toolName: 'probe', input: { f: '/v.mp4' } };
    const other = { toolName: 'probe', input: { f: '/w.mp4' } };
    const steps = [step([same]), step([same]), step([other]), step([same])];
    expect(await stop({ steps })).toBe(false);
  });
});
