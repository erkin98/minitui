import { describe, it, expect } from 'vitest';
import { toVisibilityNote } from '../src/channels/visibility-channel.js';
import { toAppError } from '../src/channels/error-channel.js';

describe('visibility + error channels', () => {
  it('passes a visibility note + class through', () => {
    expect(
      toVisibilityNote({ kind: 'visibility', note: 'picked 2 files', visClass: 'modelVisible' }),
    ).toEqual({ note: 'picked 2 files', visClass: 'modelVisible' });
  });

  it('toAppError marks ContextOverflow non-retriable', () => {
    expect(
      toAppError({
        kind: 'run-error',
        message: 'overflow',
        code: 'ContextOverflow',
        retriable: false,
      }),
    ).toEqual({ message: 'overflow', code: 'ContextOverflow', retriable: false });
  });

  it('toAppError keeps a generic error retriable', () => {
    expect(toAppError({ kind: 'run-error', message: 'blip', retriable: true })).toEqual({
      message: 'blip',
      code: undefined,
      retriable: true,
    });
  });
});
