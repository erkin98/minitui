import type { ProviderMessage } from '../provider/provider-types.js';

/** Immutable message history. Every append returns a new Conversation; disk/state are never mutated. */
export interface Conversation {
  readonly messages: readonly ProviderMessage[];
  append(m: ProviderMessage): Conversation;
  snapshot(): readonly ProviderMessage[];
}

export function createConversation(seed: readonly ProviderMessage[] = []): Conversation {
  const messages = Object.freeze([...seed]);
  return {
    messages,
    append(m) {
      return createConversation([...messages, m]);
    },
    snapshot() {
      return Object.freeze([...messages]);
    },
  };
}
