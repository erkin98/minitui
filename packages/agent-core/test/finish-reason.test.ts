import { describe, it, expect } from 'vitest';
import { isTerminal } from '../src/session/finish-reason.js';

describe('finish-reason', () => {
  it('treats stop / length / content-filter / error / other as terminal', () => {
    for (const r of ['stop', 'length', 'content-filter', 'error', 'other'] as const) {
      expect(isTerminal(r)).toBe(true);
    }
  });
  it('treats tool-calls as NON-terminal (the SDK loop continues)', () => {
    expect(isTerminal('tool-calls')).toBe(false);
  });
});
