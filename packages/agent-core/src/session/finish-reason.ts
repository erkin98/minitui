/** The terminal-reason union the provider's `finish` chunk carries (mirrors the SDK FinishReason). */
export type FinishReason = 'stop' | 'length' | 'tool-calls' | 'content-filter' | 'error' | 'other';

/** tool-calls means the SDK loop continues; everything else ends the turn. */
export function isTerminal(r: FinishReason): boolean {
  return r !== 'tool-calls';
}
