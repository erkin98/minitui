import type { ProviderChunk, ProviderRequest } from './provider-types.js';

/** The pluggable-model seam. The day-1 impl (ai-sdk-provider) wraps the Vercel AI SDK streamText().fullStream. */
export interface ModelProvider {
  readonly id: string;
  /**
   * Routing flag read by the session: `true` on the day-1 ai-sdk-provider — the session drives the
   * multi-step tool loop through streamText() and this provider only supplies the model handle. Unset or
   * `false` (a scripted / non-SDK provider) means the session consumes streamChat() directly and maps each
   * ProviderChunk to a MinituiEvent. Optional so a structurally-typed provider can omit it.
   */
  readonly usesSdkLoop?: boolean;
  streamChat(req: ProviderRequest, signal: AbortSignal): AsyncIterable<ProviderChunk>;
}
