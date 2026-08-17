import type { JsonValue } from '../state/json-pointer.js';
import type { JsonPatchOp } from '../state/patch-apply.js';
import type { AppSpec } from '@minitui/types';

/** The internal event contract — one union, three consumers (feed / store / channels). */
export type AppEvent =
  | { kind: 'run-started'; threadId: string; runId: string }
  | {
      kind: 'run-finished';
      threadId: string;
      runId: string;
      usage?: { inputTokens: number; outputTokens: number } | undefined;
    }
  | { kind: 'run-error'; message: string; code?: string | undefined; retriable: boolean }
  | { kind: 'text-delta'; messageId: string; delta: string }
  | {
      kind: 'tool-result';
      toolCallId: string;
      toolName: string;
      content: string;
      isError: boolean;
      error?: string | undefined;
      denied?: boolean | undefined;
    }
  | { kind: 'state-snapshot'; snapshot: JsonValue }
  | { kind: 'state-delta'; delta: readonly JsonPatchOp[] }
  | { kind: 'visibility'; note: string; visClass: 'modelVisible' | 'modelOnly' | 'localOnly' }
  | { kind: 'activity-snapshot'; spec: AppSpec }
  | { kind: 'passthrough'; rawType: string };

export type AppEventKind = AppEvent['kind'];
