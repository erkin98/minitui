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
 * the retry path honest so a doomed turn is never re-run.
 */
const CONTEXT_OVERFLOW_RE = /context|too\s*long|maximum.*token|overflow/i;

/**
 * Classify any thrown value for the RUN_ERROR mapping; overflow + route stay non-retriable.
 * The session maps retriable:false to a non-retriable error code at the runError call sites;
 * retriable is the internal classification bit.
 */
export function toRunError(err: unknown): { message: string; retriable: boolean } {
  if (err instanceof ProviderError) return { message: err.message, retriable: err.retriable };
  if (err instanceof RouteError) return { message: err.message, retriable: false };
  const message = err instanceof Error ? err.message : String(err);
  // A string-message context overflow (the SDK's live shape) is non-retriable, matching ContextOverflowError.
  if (CONTEXT_OVERFLOW_RE.test(message)) return { message, retriable: false };
  return { message, retriable: true };
}
