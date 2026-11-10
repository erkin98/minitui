import { describe, it, expect } from 'vitest';
import { stripAnsiNondeterminism, FROZEN_SIZE } from '../src/golden/determinism.js';

describe('stripAnsiNondeterminism', () => {
  it('replaces a UUID with a stable token', () => {
    const input = 'run 3f8a1c2e-4b5d-6e7f-8a9b-0c1d2e3f4a5b started';
    expect(stripAnsiNondeterminism(input)).toBe('run <uuid> started');
  });

  it('replaces an ISO timestamp with a stable token', () => {
    expect(stripAnsiNondeterminism('at 2026-06-25T14:03:09.123Z')).toBe('at <ts>');
  });

  it('replaces a clock time HH:MM:SS with a stable token', () => {
    expect(stripAnsiNondeterminism('elapsed 00:01:23')).toBe('elapsed <time>');
  });

  it('collapses the home directory to a stable token', () => {
    const home = process.env.HOME ?? '/home/u';
    expect(stripAnsiNondeterminism(`output to ${home}/videos/out.mp4`)).toBe(
      'output to <home>/videos/out.mp4',
    );
  });

  it('maps any spinner glyph to one stable glyph', () => {
    expect(stripAnsiNondeterminism('⠋ working')).toBe('⠿ working');
    expect(stripAnsiNondeterminism('⠙ working')).toBe('⠿ working');
  });

  it('leaves deterministic structural text untouched', () => {
    expect(stripAnsiNondeterminism('Merge  [ Run ]')).toBe('Merge  [ Run ]');
  });

  it("locks the frozen terminal width at ink-testing-library's 100 columns", () => {
    expect(FROZEN_SIZE).toEqual({ columns: 100 });
  });
});
