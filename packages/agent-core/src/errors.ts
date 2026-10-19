import { APICallError, RetryError } from 'ai';

export class ProviderError extends Error {
  readonly retriable: boolean;
  constructor(message: string, retriable = true) {
    super(message);
    this.name = 'ProviderError';
    this.retriable = retriable;
  }
}

/** Context window overflow is a DEAD END — re-feeding the same too-long history loops forever. */
export class ContextOverflowError extends ProviderError {
  constructor(message: string) {
    super(message, false);
    this.name = 'ContextOverflowError';
  }
}

export class RouteError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RouteError';
  }
}

/**
 * Context overflow is a dead end however it arrives — the SDK/provider often surfaces it as a plain
 * Error or string (never a ContextOverflowError), so toRunError classifies by message too, keeping
 * the retry path honest so a doomed turn is never re-run. The wording is narrow on purpose: a bare
 * "context", "too long" or "overflow" also appears in ordinary transient failures.
 */
export const CONTEXT_OVERFLOW_RE =
  /context[ _-]?(?:length|window)|context_length_exceeded|prompt is too long|input is too long|too many tokens|maximum (?:context|prompt)/i;

// A string property of an unknown value, or undefined. Never throws: a getter may.
function stringProperty(value: object, key: string): string | undefined {
  try {
    const found: unknown = (value as Record<string, unknown>)[key];
    return typeof found === 'string' ? found : undefined;
  } catch {
    return undefined;
  }
}

/**
 * The text of any thrown value, produced without ever throwing. A string is itself; an object with a
 * string `message` gives the message, prefixed with `type: ` when it has a string `type` (a provider can
 * send an in-stream error as a plain { type, message } object); anything else is its String() form, and
 * Object.prototype.toString when even that throws (a value with no prototype).
 */
function errorMessage(err: unknown): string {
  if (typeof err === 'string') return err;
  if (typeof err === 'object' && err !== null) {
    const message = stringProperty(err, 'message');
    if (message !== undefined) {
      const type = stringProperty(err, 'type');
      return type !== undefined ? `${type}: ${message}` : message;
    }
  }
  try {
    return String(err);
  } catch {
    return Object.prototype.toString.call(err);
  }
}

// How many RetryError wrappers are looked through; a cycle of them ends at this bound.
const MAX_UNWRAP = 8;

/**
 * Classify any thrown value for the RUN_ERROR mapping; overflow + route stay non-retriable.
 * The session maps retriable:false to a non-retriable error code at the runError call sites;
 * retriable is the internal classification bit. The SDK's own errors are classified by data (a retry
 * wrapper by its last error, an API call error by its retryable flag), everything else by message text.
 */
export function toRunError(err: unknown): { message: string; retriable: boolean } {
  if (err instanceof ProviderError) return { message: err.message, retriable: err.retriable };
  if (err instanceof RouteError) return { message: err.message, retriable: false };
  let current = err;
  for (let i = 0; i < MAX_UNWRAP && RetryError.isInstance(current); i += 1) {
    current = current.lastError;
  }
  const message = errorMessage(current);
  // A string-message context overflow (the SDK's live shape) is non-retriable, matching ContextOverflowError.
  const overflow = CONTEXT_OVERFLOW_RE.test(message);
  if (APICallError.isInstance(current)) {
    return { message, retriable: current.isRetryable && !overflow };
  }
  return { message, retriable: !overflow };
}
