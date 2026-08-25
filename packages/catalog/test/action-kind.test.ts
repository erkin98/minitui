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
