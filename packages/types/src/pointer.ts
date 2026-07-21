import { z } from 'zod';

// A loosely-validated JSON-Pointer-shaped string: empty (whole document) or
// /-prefixed. The RFC-6901 ~0/~1 escape grammar is intentionally NOT enforced
// (ledger §Z11 — the loose partial brand is settled), so `/bad~2` and a trailing
// `~` are accepted. Branded so a bare string can't be passed where a validated
// Pointer is required.
export const PointerSchema = z
  .string()
  .refine((s) => s === '' || s.startsWith('/'), {
    message: 'JSON-Pointer must be empty or start with "/"',
  })
  .brand<'Pointer'>();
export type Pointer = z.infer<typeof PointerSchema>;

// A JSON value (RFC-8259). Recursive, so declared with z.lazy + an explicit
// ZodType annotation to break the inference cycle.
export type JsonValue =
  | string
  | number
  | boolean
  | null
  | { readonly [key: string]: JsonValue }
  | readonly JsonValue[];

// PIN-DEPTH (fold): bounded fail-closed, not RangeError. 256 is far above any real
// spec/state nesting and far below stack exhaustion (~1000s). A value nested past
// this — or cyclic — is rejected with a validation ISSUE at the boundary, never
// allowed to reach the recursive core where it would overflow the call stack.
const MAX_JSON_DEPTH = 256;

// Iterative (explicit-stack) depth check run ONCE at the boundary, before the
// recursive core descends. DFS pops depth-first, so it reaches MAX_JSON_DEPTH in
// at most that many pops and bails — bounded even for cyclic/shared input (a cycle
// exceeds any finite depth). Returns a rejecting sentinel on breach so the core
// never recurses into the deep value (that recursion is the RangeError source).
const rejectOverDepth = (raw: unknown, ctx: z.RefinementCtx): unknown => {
  const stack: Array<{ node: unknown; depth: number }> = [{ node: raw, depth: 0 }];
  while (stack.length > 0) {
    const top = stack.pop();
    if (top === undefined) break;
    if (top.depth > MAX_JSON_DEPTH) {
      ctx.addIssue({
        code: 'custom',
        message: `JsonValue nesting exceeds max depth ${MAX_JSON_DEPTH}`,
      });
      return undefined; // reject WITHOUT letting the recursive core descend (no RangeError)
    }
    if (top.node !== null && typeof top.node === 'object') {
      for (const value of Object.values(top.node))
        stack.push({ node: value, depth: top.depth + 1 });
    }
  }
  return raw;
};

// JsonValue is a security-restricted JSON subset (ledger §Z100). Every object
// level is reserved-key-guarded by the shared guardReservedKeys preprocess
// (declared below; referenced inside z.lazy so it resolves at parse-time, not
// module-eval — no TDZ). The union KEEPS the recursive z.record so a nested
// object routes back through this same guarded schema. The recursive CORE
// self-references (no per-level depth re-measure); the exported boundary schema
// wraps it once with rejectOverDepth (PIN-DEPTH).
const JsonValueCore: z.ZodType<JsonValue> = z.lazy(() =>
  z.preprocess(
    guardReservedKeys,
    z.union([
      z.string(),
      z.number(),
      z.boolean(),
      z.null(),
      z.record(z.string(), JsonValueCore).readonly(),
      z.array(JsonValueCore).readonly(),
    ]),
  ),
);

export const JsonValueSchema: z.ZodType<JsonValue> = z.preprocess(rejectOverDepth, JsonValueCore);

const RESERVED_JSON_KEYS = new Set(['__proto__', 'constructor', 'prototype']);
// Reject an OWN __proto__/constructor/prototype at any object level (ledger
// §Z100 AMEND). Reflect.ownKeys catches NON-enumerable own keys too — Object.keys
// missed a non-enumerable own `constructor`; gate on string keys (a symbol can't
// collide with the reserved names). Runs on RAW input because z.record silently
// OMITS an own __proto__ (data loss, not pollution) so a post-parse refine can't
// see it. Shared by JsonValueSchema (values) and guardedRecord (dynamic-key
// container KEYS) — ONE guard, no per-consumer re-implementation.
export const guardReservedKeys = (raw: unknown, ctx: z.RefinementCtx): unknown => {
  if (raw !== null && typeof raw === 'object' && !Array.isArray(raw)) {
    for (const key of Reflect.ownKeys(raw)) {
      if (typeof key === 'string' && RESERVED_JSON_KEYS.has(key)) {
        ctx.addIssue({
          code: 'custom',
          message: `reserved key "${key}" not allowed in JsonValue`,
          path: [key],
        });
      }
    }
  }
  return raw;
};

// Factory: a dynamic-key record whose KEYS route through guardReservedKeys.
// z.record's key schema is z.string(), so a hostile container key (constructor/
// prototype survive z.record; __proto__ is silently dropped) would bypass the
// guard — every dynamic-key container (params/props/on/watch/elements) wraps
// with this so the KEY is rejected at the boundary, not just guarded on values.
export const guardedRecord = <T extends z.ZodType>(value: T) =>
  z.preprocess(guardReservedKeys, z.record(z.string(), value).readonly());

// The canonical guarded object schema (string keys → JsonValue, reserved keys
// rejected). Untrusted-object consumers PARSE through this, never an as-cast.
export const JsonObjectSchema = guardedRecord(JsonValueSchema);

// RFC-6902 operations as a discriminated union over `op`.
export const JsonPatchSchema = z
  .discriminatedUnion('op', [
    z.object({ op: z.literal('add'), path: z.string(), value: JsonValueSchema }),
    z.object({ op: z.literal('replace'), path: z.string(), value: JsonValueSchema }),
    z.object({ op: z.literal('remove'), path: z.string() }),
    z.object({ op: z.literal('move'), from: z.string(), path: z.string() }),
    z.object({ op: z.literal('copy'), from: z.string(), path: z.string() }),
    z.object({ op: z.literal('test'), path: z.string(), value: JsonValueSchema }),
  ])
  .readonly();
export type JsonPatch = z.infer<typeof JsonPatchSchema>;

export const JsonPatchArraySchema = z.array(JsonPatchSchema).readonly();
