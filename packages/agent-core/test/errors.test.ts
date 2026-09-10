import { describe, it, expect } from 'vitest';
import { ProviderError, ContextOverflowError, RouteError, toRunError } from '../src/errors.js';

describe('agent-core errors', () => {
  it('ContextOverflowError is NEVER retriable', () => {
    expect(new ContextOverflowError('too long').retriable).toBe(false);
  });
  it('a plain ProviderError defaults retriable=true', () => {
    expect(new ProviderError('429').retriable).toBe(true);
  });
  it('toRunError maps overflow to a non-retriable RUN_ERROR payload', () => {
    expect(toRunError(new ContextOverflowError('boom'))).toEqual({
      message: 'boom',
      retriable: false,
    });
    // A bare Error overflow (the SDK's live shape, not a ContextOverflowError) is non-retriable too.
    expect(toRunError(new Error('maximum context length exceeded')).retriable).toBe(false);
  });
  it('toRunError maps an unknown throw to a retriable generic payload', () => {
    expect(toRunError(new RouteError('bad route')).retriable).toBe(false);
    expect(toRunError('weird')).toEqual({ message: 'weird', retriable: true });
  });
});
