import {
  createAiSdkProvider,
  createAnthropicModel,
  type RedactionPolicy,
  type SdkLoopRoute,
} from '@minitui/agent-core';
import { sanitize } from '@minitui/sanitizer';
import type { DiagnosticsPort } from '@minitui/types';

// The route to the model and the cleaner of what the program writes, shared by the entry and the eval
// harness so that neither exists twice. Not exported from the package.

const CRASH_CAP = 4000;
const HIDDEN = '[redacted-secret]';

/** Characters of a message to the person; the entry's usage error uses it too. */
export const MESSAGE_CAP = 500;

export interface Cleaner {
  readonly line: (text: string) => string;
  readonly crash: (text: string) => string;
  readonly message: (error: unknown) => string;
}

const escapeRegExp = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * Everything the program writes outside the app (the log, a crash, a message to the person) goes through
 * here: control characters are removed, and so is the API key, whatever carried it (a provider's error
 * message, a request echoed back in a log record). The key is removed again after the control characters,
 * since taking them out can join the halves of a key that was split by one.
 */
export function cleaner(apiKey: string): Cleaner {
  const hide = (text: string): string => text.replaceAll(apiKey, HIDDEN);
  const plain = (text: string): string => hide(sanitize(hide(text), { allow: 'none' }));
  return {
    line: plain,
    crash: (text) => plain(text).slice(0, CRASH_CAP),
    message: (error) =>
      plain(error instanceof Error ? error.message : String(error)).slice(0, MESSAGE_CAP),
  };
}

/**
 * The key as an exact-value secret pattern: one redaction policy for the whole run, given to the provider
 * and the session alike, so the key is a secret wherever text is about to go to the model.
 */
export function keyRedactionPolicy(apiKey: string): RedactionPolicy {
  return { extraSecretPatterns: [new RegExp(escapeRegExp(apiKey), 'g')] };
}

/** The model route: the provider and the model handle for one key and model id; `fetch` is for the eval's meter. */
export function createModelRoute(args: {
  readonly apiKey: string;
  readonly modelId: string;
  readonly diagnostics: DiagnosticsPort;
  readonly redactionPolicy: RedactionPolicy;
  readonly fetch?: typeof globalThis.fetch | undefined;
}): SdkLoopRoute {
  const { apiKey, modelId, diagnostics, redactionPolicy, fetch } = args;
  return {
    provider: createAiSdkProvider({ apiKey, diagnostics, redactionPolicy }),
    model: createAnthropicModel(modelId, fetch === undefined ? { apiKey } : { apiKey, fetch }),
  };
}
