import { z } from 'zod';

// RFC-6901 JSON-Pointer string: empty string (whole document) or one-or-more
// /-prefixed reference tokens. Branded so a bare string can't be passed where a
// validated Pointer is required.
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

// JsonValue is a security-restricted JSON subset (ledger §Z100). Every object
// level is reserved-key-guarded by the shared guardReservedKeys preprocess
// (declared below; referenced inside z.lazy so it resolves at parse-time, not
// module-eval — no TDZ). The union KEEPS the recursive z.record so a nested
// object routes back through this same guarded schema.
export const JsonValueSchema: z.ZodType<JsonValue> = z.lazy(() =>
  z.preprocess(
    guardReservedKeys,
    z.union([
      z.string(),
      z.number(),
      z.boolean(),
      z.null(),
      z.record(z.string(), JsonValueSchema).readonly(),
      z.array(JsonValueSchema).readonly(),
    ]),
  ),
);

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
