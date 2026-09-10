import { describe, it, expect } from 'vitest';
import { effectFor, type RuleSet } from '../../src/permission/rules.js';

const set = (rules: RuleSet['rules']): RuleSet => ({ rules });

describe('effectFor — layered rule resolution', () => {
  it('returns undefined when nothing matches', () => {
    expect(effectFor(set([]), 'ls -la')).toBeUndefined();
  });
  it('matches a user allow', () => {
    expect(effectFor(set([{ pattern: 'ls', effect: 'allow', layer: 'user' }]), 'ls -la')).toBe(
      'allow',
    );
  });
  it('managed deny is final — beats a user allow', () => {
    const r = set([
      { pattern: 'rm', effect: 'allow', layer: 'user' },
      { pattern: 'rm', effect: 'deny', layer: 'managed' },
    ]);
    expect(effectFor(r, 'rm -rf x')).toBe('deny');
  });
  it('within a layer deny beats allow', () => {
    const r = set([
      { pattern: 'git', effect: 'allow', layer: 'user' },
      { pattern: 'git push', effect: 'deny', layer: 'user' },
    ]);
    expect(effectFor(r, 'git push origin')).toBe('deny');
  });
  it('project layer overrides user allow with ask', () => {
    const r = set([
      { pattern: 'ffmpeg', effect: 'allow', layer: 'user' },
      { pattern: 'ffmpeg', effect: 'ask', layer: 'project' },
    ]);
    expect(effectFor(r, 'ffmpeg -i a out')).toBe('ask');
  });
  it('respects trailing-word-boundary (rm rule does not match rmdir)', () => {
    expect(
      effectFor(set([{ pattern: 'rm', effect: 'deny', layer: 'user' }]), 'rmdir x'),
    ).toBeUndefined();
  });
});
