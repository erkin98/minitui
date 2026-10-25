import { describe, it, expect } from 'vitest';
import { sanitizeSpecStrings } from '@minitui/sanitizer';
import { RESERVED_JSON_KEYS } from '@minitui/types';
import { parseStatePointer } from '../src/state/json-pointer.js';

// The sanitiser is a leaf that imports nothing, so it keeps its own list of reserved keys. Every name that
// can reach a prototype is tried against it, and it must refuse exactly the names the shared list holds.
const CANDIDATES = [
  ...new Set([
    ...Object.getOwnPropertyNames(Object.prototype),
    // Function.prototype, reached without naming the global that the lint configuration bans.
    ...Object.getOwnPropertyNames(Object.getPrototypeOf(Object)),
    'prototype',
  ]),
].sort();

const refusedBySanitizer = (key: string): boolean => {
  const value: unknown = JSON.parse(JSON.stringify({ [key]: 1 }));
  try {
    sanitizeSpecStrings(value);
    return false;
  } catch {
    return true;
  }
};

describe('the reserved keys agree across the packages that check them', () => {
  it('the sanitiser refuses exactly the shared reserved keys among the prototype names', () => {
    expect(CANDIDATES.filter(refusedBySanitizer)).toEqual([...RESERVED_JSON_KEYS].sort());
  });

  it('the state pointer refuses exactly the shared reserved keys among the prototype names', () => {
    const refused = CANDIDATES.filter((key) => {
      try {
        parseStatePointer(`/${key}`);
        return false;
      } catch {
        return true;
      }
    });
    expect(refused).toEqual([...RESERVED_JSON_KEYS].sort());
  });
});
