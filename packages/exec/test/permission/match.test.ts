import { describe, it, expect } from 'vitest';
import { matchPattern } from '../../src/permission/shell/match.js';

describe('matchPattern', () => {
  it('matches exact root', () => {
    expect(matchPattern('rm', 'rm')).toBe(true);
  });
  it('matches root with args via trailing boundary', () => {
    expect(matchPattern('rm', 'rm -rf /')).toBe(true);
  });
  it('does NOT match a longer word (rm != rmdir)', () => {
    expect(matchPattern('rm', 'rmdir x')).toBe(false);
  });
  it('does NOT match ls against lsof (the canonical glob trap)', () => {
    expect(matchPattern('ls *', 'lsof')).toBe(false);
  });
  it('matches ls glob against ls -la', () => {
    expect(matchPattern('ls *', 'ls -la')).toBe(true);
  });
  it('glob * stops at a word boundary, not greedy across tokens', () => {
    expect(matchPattern('git log', 'git log --oneline')).toBe(true);
    expect(matchPattern('git log', 'git logfoo')).toBe(false);
  });
});
