import { describe, it, expect } from 'vitest';
import { KEYS, keyBytes } from '../src/render/keys.js';

describe('KEYS', () => {
  it('pins the exact raw-stdin byte sequence for every named key', () => {
    expect(KEYS).toEqual({
      enter: '\r',
      escape: '\x1b',
      up: '\x1b[A',
      down: '\x1b[B',
      right: '\x1b[C',
      left: '\x1b[D',
      tab: '\t',
      shiftTab: '\x1b[Z',
      backspace: '\x7f',
      delete: '\x1b[3~',
      space: ' ',
      ctrlC: '\x03',
    });
  });

  it('is frozen so a test can never mutate the shared table', () => {
    expect(Object.isFrozen(KEYS)).toBe(true);
  });
});

describe('keyBytes', () => {
  it('resolves a named key to its byte sequence', () => {
    expect(keyBytes('up')).toBe('\x1b[A');
    expect(keyBytes('enter')).toBe('\r');
  });

  it('passes a raw escape sequence through unchanged', () => {
    expect(keyBytes('\x1b[Z')).toBe('\x1b[Z');
    expect(keyBytes('x')).toBe('x');
  });

  it('passes a name inherited from Object.prototype through as text', () => {
    expect(keyBytes('toString')).toBe('toString');
    expect(keyBytes('constructor')).toBe('constructor');
  });
});
