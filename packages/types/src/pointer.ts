import { z } from 'zod';

// A loosely-validated JSON-Pointer-shaped string: empty (whole document) or
// /-prefixed. The RFC-6901 ~0/~1 escape grammar is intentionally NOT enforced
// by this boundary, so `/bad~2` and a trailing `~` are accepted. Branded so a
// bare string cannot be passed where a validated Pointer is required.
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

const MAX_JSON_DEPTH = 256;
const RESERVED_JSON_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

type MutableJsonContainer = JsonValue[] | Record<string, JsonValue>;
type JsonPath = Array<string | number>;

interface CloneFrame {
  readonly target: MutableJsonContainer;
  readonly entries: ReadonlyArray<readonly [string, unknown]>;
  readonly depth: number;
  readonly path: JsonPath;
  readonly array: boolean;
}

type CloneFailure = { readonly ok: false };
type CloneResult = { readonly ok: true; readonly value: JsonValue } | CloneFailure;
type DataPropertyResult =
  | { readonly ok: true; readonly key: string; readonly value: unknown }
  | CloneFailure;
type ContainerResult =
  | {
      readonly ok: true;
      readonly target: MutableJsonContainer;
      readonly entries: ReadonlyArray<readonly [string, unknown]>;
      readonly array: boolean;
    }
  | CloneFailure;
type UnknownDataDescriptor = Omit<PropertyDescriptor, 'get' | 'set' | 'value'> & {
  readonly value: unknown;
};

function rejectJson(ctx: z.RefinementCtx, message: string, path: JsonPath = []): CloneFailure {
  ctx.addIssue({ code: 'custom', message, path });
  return { ok: false };
}

function isDataDescriptor(
  descriptor: PropertyDescriptor | undefined,
): descriptor is UnknownDataDescriptor {
  return descriptor !== undefined && Object.hasOwn(descriptor, 'value');
}

function readDataProperty(
  owner: object,
  key: string | symbol,
  path: JsonPath,
  ctx: z.RefinementCtx,
): DataPropertyResult {
  if (typeof key !== 'string') {
    return rejectJson(ctx, 'JsonValue containers cannot have symbol properties', path);
  }
  const descriptor = Reflect.getOwnPropertyDescriptor(owner, key);
  if (!isDataDescriptor(descriptor)) {
    return rejectJson(ctx, 'JsonValue containers cannot have accessor properties', [...path, key]);
  }
  if (descriptor.enumerable !== true) {
    return rejectJson(ctx, 'JsonValue containers cannot have non-enumerable properties', [
      ...path,
      key,
    ]);
  }
  return { ok: true, key, value: descriptor.value };
}

function readArrayLength(value: object, path: JsonPath, ctx: z.RefinementCtx): number | undefined {
  const descriptor = Reflect.getOwnPropertyDescriptor(value, 'length');
  if (!isDataDescriptor(descriptor) || typeof descriptor.value !== 'number') {
    rejectJson(ctx, 'JsonValue array has an invalid length', path);
    return undefined;
  }
  if (!Number.isSafeInteger(descriptor.value) || descriptor.value < 0) {
    rejectJson(ctx, 'JsonValue array has an invalid length', path);
    return undefined;
  }
  return descriptor.value;
}

function isCanonicalArrayMember(key: string, length: number): boolean {
  return /^(0|[1-9][0-9]*)$/.test(key) && Number.isSafeInteger(Number(key)) && Number(key) < length;
}

function inspectArray(
  value: object,
  keys: ArrayLike<string | symbol>,
  path: JsonPath,
  ctx: z.RefinementCtx,
): ContainerResult {
  const length = readArrayLength(value, path, ctx);
  if (length === undefined) return { ok: false };
  const entries: Array<readonly [string, unknown]> = [];
  for (const key of Array.from(keys)) {
    if (key === 'length') continue;
    const property = readDataProperty(value, key, path, ctx);
    if (!property.ok) return property;
    if (!isCanonicalArrayMember(property.key, length)) {
      return rejectJson(ctx, 'JsonValue arrays must contain only canonical indices', [
        ...path,
        property.key,
      ]);
    }
    entries.push([property.key, property.value]);
  }
  if (entries.length !== length) return rejectJson(ctx, 'JsonValue arrays must be dense', path);
  return { ok: true, target: [], entries, array: true };
}

function inspectRecord(
  value: object,
  keys: ArrayLike<string | symbol>,
  path: JsonPath,
  ctx: z.RefinementCtx,
): ContainerResult {
  const entries: Array<readonly [string, unknown]> = [];
  for (const key of Array.from(keys)) {
    const property = readDataProperty(value, key, path, ctx);
    if (!property.ok) return property;
    if (RESERVED_JSON_KEYS.has(property.key)) {
      return rejectJson(ctx, `reserved key "${property.key}" not allowed in JsonValue`, [
        ...path,
        property.key,
      ]);
    }
    entries.push([property.key, property.value]);
  }
  return { ok: true, target: {}, entries, array: false };
}

function inspectContainer(value: object, path: JsonPath, ctx: z.RefinementCtx): ContainerResult {
  const array = Array.isArray(value);
  const prototype = Reflect.getPrototypeOf(value);
  if (array && prototype !== Array.prototype) {
    return rejectJson(ctx, 'JsonValue container has an unsupported prototype', path);
  }
  if (!array && prototype !== Object.prototype && prototype !== null) {
    return rejectJson(ctx, 'JsonValue container has an unsupported prototype', path);
  }
  const keys = Reflect.ownKeys(value);
  return array ? inspectArray(value, keys, path, ctx) : inspectRecord(value, keys, path, ctx);
}

function allocateJsonValue(
  value: unknown,
  depth: number,
  path: JsonPath,
  ctx: z.RefinementCtx,
  seen: WeakSet<object>,
  stack: CloneFrame[],
): CloneResult {
  if (depth > MAX_JSON_DEPTH) {
    return rejectJson(ctx, `JsonValue nesting exceeds max depth ${MAX_JSON_DEPTH}`, path);
  }
  if (value === null || typeof value === 'string' || typeof value === 'boolean') {
    return { ok: true, value };
  }
  if (typeof value === 'number') {
    return Number.isFinite(value)
      ? { ok: true, value }
      : rejectJson(ctx, 'JsonValue number must be finite', path);
  }
  if (typeof value !== 'object') return rejectJson(ctx, 'value is not a JSON value', path);
  if (seen.has(value)) {
    return rejectJson(ctx, 'JsonValue must be a tree without cycles or aliases', path);
  }

  const container = inspectContainer(value, path, ctx);
  if (!container.ok) return container;
  seen.add(value);
  stack.push({
    target: container.target,
    entries: container.entries,
    depth,
    path,
    array: container.array,
  });
  return { ok: true, value: container.target };
}

function cloneJsonTree(raw: unknown, ctx: z.RefinementCtx): unknown {
  const seen = new WeakSet<object>();
  const stack: CloneFrame[] = [];

  try {
    const root = allocateJsonValue(raw, 0, [], ctx, seen, stack);
    if (!root.ok) return undefined;
    while (stack.length > 0) {
      const frame = stack.pop();
      if (frame === undefined) break;
      for (const [key, value] of frame.entries) {
        const pathKey = frame.array ? Number(key) : key;
        const child = allocateJsonValue(
          value,
          frame.depth + 1,
          [...frame.path, pathKey],
          ctx,
          seen,
          stack,
        );
        if (!child.ok) return undefined;
        Object.defineProperty(frame.target, key, {
          value: child.value,
          writable: true,
          enumerable: true,
          configurable: true,
        });
      }
    }
    return root.value;
  } catch {
    rejectJson(ctx, 'JsonValue container reflection failed');
    return undefined;
  }
}

// The recursive schema sees only the descriptor-safe clone produced above, so
// Zod never reflects over caller-owned objects and its readonly wrappers can
// deep-freeze without invoking accessors or touching exotic containers.
const JsonValueCore: z.ZodType<JsonValue> = z.lazy(() =>
  z.union([
    z.string(),
    z.number(),
    z.boolean(),
    z.null(),
    z.record(z.string(), JsonValueCore).readonly(),
    z.array(JsonValueCore).readonly(),
  ]),
);

export const JsonValueSchema: z.ZodType<JsonValue> = z.preprocess(cloneJsonTree, JsonValueCore);

// Descriptor-safe shallow clone for dynamic-key records. Values are deliberately
// left untouched for their supplied schema; guardedRecord is shallow-readonly.
export const guardReservedKeys = (raw: unknown, ctx: z.RefinementCtx): unknown => {
  if (raw === null || typeof raw !== 'object') return raw;
  try {
    const prototype = Reflect.getPrototypeOf(raw);
    if (Array.isArray(raw) || (prototype !== Object.prototype && prototype !== null)) {
      ctx.addIssue({ code: 'custom', message: 'dynamic-key container must be a plain record' });
      return undefined;
    }
    const clone: Record<string, unknown> = {};
    for (const key of Reflect.ownKeys(raw)) {
      if (typeof key !== 'string') {
        ctx.addIssue({ code: 'custom', message: 'dynamic-key container cannot have symbol keys' });
        return undefined;
      }
      const descriptor = Reflect.getOwnPropertyDescriptor(raw, key);
      if (!isDataDescriptor(descriptor) || descriptor.enumerable !== true) {
        ctx.addIssue({
          code: 'custom',
          message: 'dynamic-key container requires enumerable data properties',
          path: [key],
        });
        return undefined;
      }
      if (RESERVED_JSON_KEYS.has(key)) {
        ctx.addIssue({
          code: 'custom',
          message: `reserved key "${key}" not allowed in JsonValue`,
          path: [key],
        });
        return undefined;
      }
      Object.defineProperty(clone, key, {
        value: descriptor.value,
        writable: true,
        enumerable: true,
        configurable: true,
      });
    }
    return clone;
  } catch {
    ctx.addIssue({ code: 'custom', message: 'dynamic-key container reflection failed' });
    return undefined;
  }
};

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
