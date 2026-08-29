import { describe, it, expect } from 'vitest';
import { createConversation } from '../src/session/conversation.js';

describe('conversation', () => {
  it('append returns a NEW conversation and never mutates the old one', () => {
    const a = createConversation([{ role: 'system', content: 'sys' }]);
    const b = a.append({ role: 'user', content: 'merge these' });
    expect(a.messages).toEqual([{ role: 'system', content: 'sys' }]);
    expect(b.messages).toEqual([
      { role: 'system', content: 'sys' },
      { role: 'user', content: 'merge these' },
    ]);
    expect(b).not.toBe(a);
  });

  it('snapshot returns a frozen copy', () => {
    const c = createConversation().append({ role: 'user', content: 'hi' });
    const snap = c.snapshot();
    expect(snap).toEqual([{ role: 'user', content: 'hi' }]);
    expect(Object.isFrozen(snap)).toBe(true);
  });
});
