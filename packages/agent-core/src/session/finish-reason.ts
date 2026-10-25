/** The terminal-reason union the provider's `finish` chunk carries (mirrors the SDK FinishReason). */
export type FinishReason = 'stop' | 'length' | 'tool-calls' | 'content-filter' | 'error' | 'other';

/** tool-calls means the SDK loop continues; everything else ends the turn. */
export function isTerminal(r: FinishReason): boolean {
  return r !== 'tool-calls';
}

/** How a run ends once the model stream has finished. */
export type FinishEnding =
  | { readonly kind: 'finished' }
  | { readonly kind: 'error'; readonly message: string; readonly retriable: boolean };

/**
 * The one mapping from a finish reason to the ending of the run, used by the SDK loop and by the finish
 * chunk of the other loop. A cut, filtered or halted generation is a non-retriable error; a failed or
 * dropped one is a retriable error. `reason` is read as unknown: a value outside the known set is the
 * SDK's "no finish reported" and ends as a dropped stream.
 */
export function endingOf(reason: unknown): FinishEnding {
  switch (reason) {
    case 'stop':
    case 'other':
      return { kind: 'finished' };
    case 'length':
      return {
        kind: 'error',
        message: 'the model reply was cut by the output-token limit',
        retriable: false,
      };
    case 'content-filter':
      return {
        kind: 'error',
        message: 'model output was blocked by the provider content filter',
        retriable: false,
      };
    case 'tool-calls':
      return {
        kind: 'error',
        message: 'turn halted: the tool-call limit was reached',
        retriable: false,
      };
    case 'error':
      return {
        kind: 'error',
        message: 'the provider reported a failed generation',
        retriable: true,
      };
    default:
      return { kind: 'error', message: 'stream closed before finish', retriable: true };
  }
}
