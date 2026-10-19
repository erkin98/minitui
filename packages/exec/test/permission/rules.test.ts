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

describe('effectFor — a deny written as several words', () => {
  const denyPush = set([{ pattern: 'git push', effect: 'deny', layer: 'user' }]);

  it('matches when an option sits between its words', () => {
    expect(effectFor(denyPush, 'git --no-pager push origin')).toBe('deny');
    expect(effectFor(denyPush, 'git -C repo push')).toBe('deny');
  });
  it('matches an operand equal to one of its words (recorded over-deny)', () => {
    expect(effectFor(denyPush, 'git commit -m push')).toBe('deny');
  });
  it('does not match a word that only starts like one of its own', () => {
    expect(effectFor(denyPush, 'git pushy')).toBeUndefined();
    expect(effectFor(denyPush, 'git status')).toBeUndefined();
  });
  it('is read for a deny only: an allow of several words keeps the contiguous match', () => {
    const allowPush = set([{ pattern: 'git push', effect: 'allow', layer: 'user' }]);
    expect(effectFor(allowPush, 'git push origin')).toBe('allow');
    expect(effectFor(allowPush, 'git --no-pager push origin')).toBeUndefined();
  });
  it('leaves a deny that names an option to the contiguous match', () => {
    const denyForce = set([{ pattern: 'git push --force', effect: 'deny', layer: 'user' }]);
    expect(effectFor(denyForce, 'git push --force origin')).toBe('deny');
    expect(effectFor(denyForce, 'git --no-pager push --force')).toBeUndefined();
  });
});
