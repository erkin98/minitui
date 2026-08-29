import type { FinishReason } from '../session/finish-reason.js';

/**
 * The minitui-owned provider chunk union. The SDK's stream-part types never leak past
 * ai-sdk-provider.ts — every provider speaks this union so the model loop stays provider-agnostic.
 * The discriminant is `type`.
 */
export type ProviderChunk =
  | { readonly type: 'text'; readonly text: string }
  | {
      readonly type: 'tool-call';
      readonly toolCallId: string;
      readonly toolName: string;
      readonly input: unknown;
    }
  | {
      readonly type: 'tool-result';
      readonly toolCallId: string;
      readonly toolName: string;
      readonly output: unknown;
      readonly isError: boolean;
    }
  | {
      readonly type: 'approval-request';
      readonly toolCallId: string;
      readonly toolName: string;
      readonly input: unknown;
    }
  | { readonly type: 'approval-response'; readonly toolCallId: string; readonly approved: boolean }
  // The token/cost totals the finish chunk carries; optional because not every provider reports usage.
  | {
      readonly type: 'finish';
      readonly reason: FinishReason;
      readonly usage?: { inputTokens: number; outputTokens: number } | undefined;
    }
  // The provider-seam error taxonomy: a fatal error (e.g. context overflow) is retriable:false; a
  // transient one (rate-limit / overload) is retriable:true and carries a parsed retry-after delay when
  // the provider supplied one. ai-sdk-provider is the only producer today.
  | {
      readonly type: 'error';
      readonly message: string;
      readonly retriable: boolean;
      readonly retryAfterMs?: number;
    };

export interface ModelConfig {
  readonly model: string;
  readonly maxOutputTokens?: number;
  readonly temperature?: number;
  readonly system?: string | undefined;
}

export interface ProviderMessage {
  readonly role: 'user' | 'assistant' | 'system';
  readonly content: string;
}

export interface ProviderRequest {
  readonly messages: readonly ProviderMessage[];
  readonly config: ModelConfig;
}
