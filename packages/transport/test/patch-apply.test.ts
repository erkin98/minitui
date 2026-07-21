import { describe, it, expect } from 'vitest';
import { applyStatePatch, PatchError } from '../src/state/patch-apply.js';
import type { JsonValue } from '../src/state/json-pointer.js';

describe('applyStatePatch', () => {
  it('applies a valid RFC-6902 delta into a NEW document', () => {
    const state: JsonValue = { merge: { progress: 0 } };
    const next = applyStatePatch(state, [{ op: 'replace', path: '/merge/progress', value: 42 }]);
    expect(next).toEqual({ merge: { progress: 42 } });
    expect(state).toEqual({ merge: { progress: 0 } }); // input untouched (mutateDocument:false)
  });

  it('rejects a malformed op at apply time with PatchError', () => {
    expect(() =>
      applyStatePatch({ a: 1 }, [{ op: 'replace', path: '/nope/deep', value: 1 }]),
    ).toThrow(PatchError);
  });

  it('rejects prototype-pollution paths (banPrototypeModifications)', () => {
    expect(() =>
      applyStatePatch({}, [{ op: 'add', path: '/__proto__/polluted', value: true }]),
    ).toThrow(PatchError);
    // global prototype is NOT polluted
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });
});
