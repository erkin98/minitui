import { describe, it, expect } from 'vitest';
import { checkPathRules, type PathRule } from '../../src/permission/path-gate.js';

describe('checkPathRules — gitignore-style, last match wins', () => {
  it('defaults to ask when nothing matches', () => {
    expect(checkPathRules('/home/u/a.mp4', [])).toBe('ask');
  });
  it('allows a matched glob', () => {
    const rules: PathRule[] = [{ glob: '/home/u/**', effect: 'allow' }];
    expect(checkPathRules('/home/u/videos/a.mp4', rules)).toBe('allow');
  });
  it('last matching rule wins — re-include after a deny', () => {
    const rules: PathRule[] = [
      { glob: '/home/u/**', effect: 'deny' },
      { glob: '/home/u/public/**', effect: 'allow' },
    ];
    expect(checkPathRules('/home/u/public/a.mp4', rules)).toBe('allow');
    expect(checkPathRules('/home/u/private/a.mp4', rules)).toBe('deny');
  });
  it('single-* matches one segment only', () => {
    const rules: PathRule[] = [{ glob: '/home/*/a.mp4', effect: 'allow' }];
    expect(checkPathRules('/home/u/a.mp4', rules)).toBe('allow');
    expect(checkPathRules('/home/u/sub/a.mp4', rules)).toBe('ask');
  });
  it('normalizes .. traversal before matching — cannot ride an allow or evade a deny via ../', () => {
    // /home/u/../../etc/shadow collapses to /etc/shadow: it no longer rides an allow rooted at
    // /home/u, and it now matches a deny rooted at /etc it would otherwise have slipped past.
    expect(
      checkPathRules('/home/u/../../etc/shadow', [{ glob: '/home/u/**', effect: 'allow' }]),
    ).toBe('ask');
    expect(checkPathRules('/home/u/../../etc/shadow', [{ glob: '/etc/**', effect: 'deny' }])).toBe(
      'deny',
    );
  });
});
