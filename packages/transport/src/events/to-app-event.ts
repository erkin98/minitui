import { EventType, type BaseEvent } from '@ag-ui/core';
import { JsonValueSchema, JsonPatchArraySchema, TokenUsageSchema } from '@minitui/types';
import type { AppEvent } from './app-event.js';

const NON_RETRIABLE_CODES = new Set([
  'non-retriable',
  'ContextOverflow',
  'context_overflow',
  'context_length_exceeded',
]);
const VIS_CLASSES = new Set(['modelVisible', 'modelOnly', 'localOnly']);

/** The two accepted wires: real AG-UI BaseEvent (remote path, post transformChunks/verifyEvents)
 *  and the minitui-native wire (local path, fed straight through — ledger §L, no adapter
 *  crossing). The minitui EXTENSION fields — visClass (CUSTOM/RAW), isError/toolName/error
 *  (TOOL_CALL_RESULT), retriable (RUN_ERROR) — are honored when present; no stock AG-UI
 *  producer sets them, so a genuinely-remote adapter must derive them. */
export type WireEvent = BaseEvent | ({ type: string } & Record<string, unknown>);

/** JSON.stringify throws on circular refs / BigInt; toAppEvent is declared total (never throws),
 *  so a non-JSON-safe CUSTOM/RAW payload falls back to String() rather than propagating. */
function safeStringify(payload: unknown): string {
  try {
    return JSON.stringify(payload);
  } catch {
    return String(payload);
  }
}

/** Wire-field normalizer: primitives coerce, anything else takes the fallback — an
 *  object in a string slot must not surface as '[object Object]'. */
function str(v: unknown, fallback = ''): string {
  if (typeof v === 'string') return v;
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  return fallback;
}

/** CUSTOM/RAW both ride the visibility channel, but their payloads live in DIFFERENT fields:
 *  CUSTOM = { name, value }, RAW = { event, source? } (real AG-UI schemas — RAW never carries
 *  value/name). Non-string payloads are JSON-stringified. visClass defaults to modelVisible
 *  unless the event carries a valid minitui/BFF extension value. */
function toVisibility(
  e: Record<string, unknown>,
  payload: unknown,
): Extract<AppEvent, { kind: 'visibility' }> {
  const cls = typeof e.visClass === 'string' ? e.visClass : '';
  const note =
    typeof payload === 'string' ? payload : payload == null ? '' : safeStringify(payload);
  return {
    kind: 'visibility',
    note,
    visClass: (VIS_CLASSES.has(cls) ? cls : 'modelVisible') as
      | 'modelVisible'
      | 'modelOnly'
      | 'localOnly',
  };
}

/** The ONE place raw wire events become the internal AppEvent union. */
// eslint-disable-next-line complexity -- §Z68: irreducible event-dispatch table (switch over a closed union); the ceiling 15 stays a real gate for every other function
export function toAppEvent(raw: unknown): AppEvent {
  // Untrusted-wire boundary: raw is `unknown`. A null/undefined/primitive payload must not
  // throw reading `.type` — the declared-total contract maps it to a safe passthrough instead.
  if (raw === null || typeof raw !== 'object') {
    return { kind: 'passthrough', rawType: String(raw) };
  }
  const e = raw as { type: string } & Record<string, unknown>;
  // PIN-NORMALIZER-TOTAL (fold): a non-string/absent discriminant is MALFORMED, not an
  // unmodeled-but-valid event — fail CLOSED rather than emit a passthrough whose rawType
  // would violate the { rawType: string } union member (the cast below is boundary-only).
  if (typeof e.type !== 'string') {
    return {
      kind: 'run-error',
      message: 'malformed wire event: non-string type discriminant',
      code: 'non-retriable',
      retriable: false,
    };
  }
  // The predicate is claimed as EventType so every case shares the enum type; the claim is
  // boundary-only — an unmodeled wire string still lands in the default passthrough arm.
  switch (e.type as EventType) {
    case EventType.RUN_STARTED:
      return {
        kind: 'run-started',
        threadId: str(e.threadId),
        runId: str(e.runId),
      };
    case EventType.RUN_FINISHED: {
      // §Z57-A/§Z103: usage is a minitui wire extension (token/cost totals) arriving on the
      // untrusted remote @ag-ui/client wire — PARSE it through the canonical TokenUsageSchema
      // (the L01 int/nonnegative guard) rather than casting. FAIL-SOFT: an invalid or absent
      // count DROPS the usage field (the RUN_FINISHED still fires) — never throw (a cosmetic
      // status counter must not abort a completed run), never clamp (dropping is honest).
      const usage = TokenUsageSchema.safeParse(e.usage);
      return {
        kind: 'run-finished',
        threadId: str(e.threadId),
        runId: str(e.runId),
        ...(usage.success ? { usage: usage.data } : {}),
      };
    }
    case EventType.RUN_ERROR: {
      const code = e.code === undefined ? undefined : String(e.code);
      // PIN-RETRIABLE-FLOOR (fold): the §Z79 non-retriable family is a HARD FLOOR — a code in
      // NON_RETRIABLE_CODES ('non-retriable' + the ContextOverflow family) forces retriable:false
      // and is NOT overridable by an explicit wire `retriable` flag (a Slice-2+ BFF extension a
      // remote could set). Only an unknown/retriable code honors the explicit flag; absent flag +
      // non-floor code defaults retriable. context-overflow must never re-feed, wire flag or not.
      const retriable =
        code !== undefined && NON_RETRIABLE_CODES.has(code)
          ? false
          : typeof e.retriable === 'boolean'
            ? e.retriable
            : true;
      return { kind: 'run-error', message: str(e.message, 'run error'), code, retriable };
    }
    case EventType.TEXT_MESSAGE_CONTENT:
      return {
        kind: 'text-delta',
        messageId: str(e.messageId),
        delta: str(e.delta),
      };
    case EventType.TOOL_CALL_RESULT: {
      // isError/toolName/error are minitui wire extensions: the REAL AG-UI ToolCallResultEvent
      // has none of them (repos/ag-ui core events.ts requires messageId instead), so on a raw
      // remote stream isError defaults false and toolName/error default absent until the remote
      // adapter derives them explicitly (ledger G12). toolName/error are the agent-core §N
      // extension (plan 11 agentObservation / plan 12 routeToolCallResult, both source-verified
      // already emitting them) — toolName lets a consumer attribute a result without re-joining
      // the earlier TOOL_CALL_START by id.
      const errorField = typeof e.error === 'string' ? { error: e.error } : {};
      return {
        kind: 'tool-result',
        toolCallId: str(e.toolCallId),
        toolName: str(e.toolName),
        content: str(e.content),
        isError: e.isError === true,
        ...errorField,
      };
    }
    case EventType.STATE_SNAPSHOT: {
      // §Z100: PARSE the untrusted-wire snapshot through the reserved-key-guarded canonical schema
      // (rejects an own __proto__/constructor/prototype at every object level via Reflect.ownKeys)
      // rather than casting — the snapshot VALUE is otherwise unguarded before it folds into the
      // store. FAIL-CLOSED: a rejected snapshot never reaches the store; since toAppEvent is
      // declared total (no diagnostics sink here), it surfaces a non-retriable run-error, never throws.
      // PIN-NORMALIZER-TOTAL (fold): parse `e.snapshot` DIRECTLY (no `?? null`) — a MISSING snapshot
      // is malformed and fails closed here, never fabricates a `snapshot: null` state event.
      const parsed = JsonValueSchema.safeParse(e.snapshot);
      if (!parsed.success) {
        return {
          kind: 'run-error',
          message: 'invalid STATE_SNAPSHOT rejected at transport wire boundary',
          code: 'non-retriable',
          retriable: false,
        };
      }
      return { kind: 'state-snapshot', snapshot: parsed.data };
    }
    case EventType.STATE_DELTA: {
      // §Z100: PARSE the untrusted-wire delta through the canonical patch-array schema — its op
      // `value` members inherit the same reserved-key guard, adding VALUE-member coverage. The
      // applyStatePatch banPrototypeModifications guard still defends PATCH PATHS downstream; this
      // is the complementary VALUE check. FAIL-CLOSED to a non-retriable run-error (declared-total).
      // PIN-NORMALIZER-TOTAL (fold): parse `e.delta` DIRECTLY (no `?? []`) — a MISSING delta is
      // malformed and fails closed here, never fabricates an empty-patch state-delta event.
      const parsed = JsonPatchArraySchema.safeParse(e.delta);
      if (!parsed.success) {
        return {
          kind: 'run-error',
          message: 'invalid STATE_DELTA rejected at transport wire boundary',
          code: 'non-retriable',
          retriable: false,
        };
      }
      return { kind: 'state-delta', delta: parsed.data };
    }
    case EventType.CUSTOM:
      return toVisibility(e, e.value ?? e.name);
    case EventType.RAW:
      return toVisibility(e, e.event);
    case EventType.ACTIVITY_SNAPSHOT: {
      // minitui-owned payload pinned to { spec } (ledger G9; plan-02 AgentEvent; SpecSinkPort emits
      // it). The REAL AG-UI ActivitySnapshotEvent carries { messageId, activityType, content } —
      // mapping content→spec belongs to the remote adapter (Slice 2+). ONE shape here, no fallbacks.
      // PIN-NORMALIZER-TOTAL (fold): PARSE `e.spec` through the reserved-key-guarded schema rather
      // than casting — this CLONES (breaks the wire alias so a later caller mutation can't reach the
      // emitted event) AND validates (§Z100 own-key guard). FAIL-CLOSED on a missing/invalid spec.
      const parsed = JsonValueSchema.safeParse(e.spec);
      if (!parsed.success) {
        return {
          kind: 'run-error',
          message: 'invalid ACTIVITY_SNAPSHOT rejected at transport wire boundary',
          code: 'non-retriable',
          retriable: false,
        };
      }
      return { kind: 'activity-snapshot', spec: parsed.data };
    }
    default:
      return { kind: 'passthrough', rawType: e.type };
  }
}
