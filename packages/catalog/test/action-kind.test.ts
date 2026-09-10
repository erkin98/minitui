import { describe, it, expect } from 'vitest';
import {
  applyResourceTemplate,
  resolvePointer,
  type ActionKind,
  type PermissionDescriptor,
} from '../src/contract/action-kind.js';

describe('ActionKind / PermissionDescriptor re-export', () => {
  it('exposes the four kinds and the descriptor shape', () => {
    const k: ActionKind = 'exec-local';
    const pd: PermissionDescriptor = {
      danger: true,
      resourceTemplate: 'ffmpeg -i ${/inputs/0} -i ${/inputs/1}',
      summaryTemplate: 'Merge 2 videos',
    };
    expect(k).toBe('exec-local');
    expect(pd.danger).toBe(true);
  });
});

describe('resolvePointer', () => {
  it('walks an RFC-6901 pointer to its value', () => {
    expect(resolvePointer({ inputs: ['/abs/a.mp4'] }, '/inputs/0')).toBe('/abs/a.mp4');
  });
  it('returns undefined for a missing pointer (never throws)', () => {
    expect(resolvePointer({ inputs: [] }, '/inputs/0')).toBeUndefined();
  });
  it('reads a slashless pointer as ONE relative segment (mirrors the runtime getByPath, not the whole doc)', () => {
    // The pinned runtime parseJsonPointer('missing') === ['missing'], so getByPath reads
    // state['missing']. The gate must resolve identically, else a slashless binding
    // resolves to the whole document (always defined) and the bad-binding check can never
    // fire for it while the action wires to nothing at dispatch.
    expect(resolvePointer({ missing: 'v' }, 'missing')).toBe('v');
    expect(resolvePointer({ p: 1 }, 'missing')).toBeUndefined();
  });
  it('resolves a reserved/inherited-key pointer to undefined (own-property read only)', () => {
    // A plain member read walks the prototype chain: ({})['__proto__'] is
    // Object.prototype and ({})['constructor'] is the Object function — both truthy,
    // so such a pointer would validate against a member the store never serves. An
    // own-property read returns undefined so the bad-binding check fires instead.
    expect(resolvePointer({}, '/__proto__')).toBeUndefined();
    expect(resolvePointer({}, '/constructor')).toBeUndefined();
    // Controls: a real own key still resolves, at depth and slashless.
    expect(resolvePointer({ a: { b: 1 } }, '/a/b')).toBe(1);
    expect(resolvePointer({ missing: 'v' }, 'missing')).toBe('v');
  });
  it('rejects a non-canonical array-index token (strict RFC-6901: 0 or [1-9][0-9]*)', () => {
    // Number() would leniently accept '1e0' as 1, '00' as 0, and ' 1' as 1; a
    // strict RFC-6901 array index has no exponent/leading-zero/whitespace form, so
    // each of these resolves to undefined (treated as unresolved, then rejected).
    expect(resolvePointer({ inputs: ['a', 'b'] }, '/inputs/1e0')).toBeUndefined();
    expect(resolvePointer({ inputs: ['a', 'b'] }, '/inputs/00')).toBeUndefined();
    expect(resolvePointer({ inputs: ['a', 'b'] }, '/inputs/ 1')).toBeUndefined();
    expect(resolvePointer({ inputs: ['a', 'b'] }, '/inputs/0x1')).toBeUndefined();
    // canonical indices still resolve
    expect(resolvePointer({ inputs: ['a', 'b'] }, '/inputs/0')).toBe('a');
    expect(resolvePointer({ inputs: ['a', 'b'] }, '/inputs/1')).toBe('b');
  });
});

describe('applyResourceTemplate', () => {
  it('resolves ${/pointer} holes against the state document', () => {
    const out = applyResourceTemplate('ffmpeg -i ${/inputs/0} -i ${/inputs/1}', {
      inputs: ['/abs/a.mp4', '/abs/b.mp4'],
    });
    expect(out).toBe('ffmpeg -i /abs/a.mp4 -i /abs/b.mp4');
  });
  it('leaves an unresolved hole literally in place (caller treats residual ${ as an error)', () => {
    const out = applyResourceTemplate('x ${/missing}', { inputs: [] });
    expect(out).toBe('x ${/missing}');
  });
  it('leaves a non-string resolved value as the literal hole (never coerces objects)', () => {
    const out = applyResourceTemplate('x ${/obj}', { obj: { a: 1 } });
    expect(out).toBe('x ${/obj}');
  });
});
