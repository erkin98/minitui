import { describe, it, expect } from 'vitest';
import { APICallError, RetryError } from 'ai';
import { ProviderError, ContextOverflowError, RouteError, toRunError } from '../src/errors.js';

const apiError = (statusCode: number, message = 'request failed'): APICallError =>
  new APICallError({
    message,
    url: 'https://example.invalid/v1',
    requestBodyValues: {},
    statusCode,
  });

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

describe('toRunError classifies by data, not by message text', () => {
  it.each([400, 401, 403, 404, 413, 422])('a status %i is not retriable', (status) => {
    expect(toRunError(apiError(status)).retriable).toBe(false);
  });

  it.each([408, 409, 429, 500, 502, 503, 529])('a status %i is retriable', (status) => {
    expect(toRunError(apiError(status)).retriable).toBe(true);
  });

  it('classifies a RetryError as its last error', () => {
    const wrap = (last: APICallError): RetryError =>
      new RetryError({
        message: 'gave up',
        reason: 'maxRetriesExceeded',
        errors: [apiError(500), last],
      });
    expect(toRunError(wrap(apiError(401, 'bad key')))).toEqual({
      message: 'bad key',
      retriable: false,
    });
    expect(toRunError(wrap(apiError(503, 'busy')))).toEqual({ message: 'busy', retriable: true });
  });

  it.each([
    'maximum context length exceeded',
    "This model's maximum context length is 8192 tokens",
    'prompt is too long: 208310 tokens > 200000 maximum',
    'context_length_exceeded',
    'input is too long for requested model',
  ])('treats "%s" as a context overflow', (message) => {
    expect(toRunError(new Error(message)).retriable).toBe(false);
    expect(toRunError(apiError(500, message)).retriable).toBe(false);
  });

  it.each([
    'context deadline exceeded',
    'ECONNRESET in the context of a TLS handshake',
    'upstream proxy buffer overflow',
    'request took too long',
    'maximum retries reached for token refresh',
  ])('does not take "%s" for a context overflow', (message) => {
    expect(toRunError(new Error(message)).retriable).toBe(true);
  });

  it('does not throw on a value with no prototype', () => {
    const bare: unknown = Object.create(null);
    const result = toRunError(bare);
    expect(result.retriable).toBe(true);
    expect(typeof result.message).toBe('string');
  });

  it('shows a plain in-stream error object as type: message', () => {
    expect(toRunError({ type: 'overloaded_error', message: 'Overloaded' })).toEqual({
      message: 'overloaded_error: Overloaded',
      retriable: true,
    });
    expect(toRunError({ message: 'just a message' }).message).toBe('just a message');
  });

  it('survives an object whose message getter throws', () => {
    const hostile = {
      get message(): string {
        throw new Error('getter');
      },
    };
    expect(() => toRunError(hostile)).not.toThrow();
  });
});
