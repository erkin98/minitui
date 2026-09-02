import { describe, it, expect } from 'vitest';
import { RENDER_LOCAL_ALLOWLIST, isRenderLocalAllowed } from '../src/binder/render-local.js';

describe('render-local STATE-ONLY allowlist', () => {
  it('allows the three state mutators', () => {
    expect(isRenderLocalAllowed('setState')).toBe(true);
    expect(isRenderLocalAllowed('pushState')).toBe(true);
    expect(isRenderLocalAllowed('removeState')).toBe(true);
  });
  it('rejects log (raw console bypasses sanitizer) and exit (kills process)', () => {
    expect(isRenderLocalAllowed('log')).toBe(false);
    expect(isRenderLocalAllowed('exit')).toBe(false);
  });
  it('rejects unknown built-ins', () => {
    expect(isRenderLocalAllowed('navigate')).toBe(false);
    expect(isRenderLocalAllowed('')).toBe(false);
  });
  it('the allowlist is exactly the three state mutators', () => {
    expect([...RENDER_LOCAL_ALLOWLIST].sort()).toEqual(['pushState', 'removeState', 'setState']);
  });
});
