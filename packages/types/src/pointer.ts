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

// Shared limits for model-facing JSON values and patch batches.
export const JSON_RESOURCE_LIMITS = Object.freeze({
  maxDepth: 256,
  maxNodes: 65_536,
  maxStringCodeUnits: 1_048_576,
  maxPatchOperations: 256,
});

const RESERVED_JSON_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

type MutableJsonContainer = JsonValue[] | Record<string, JsonValue>;
type JsonPath = Array<string | number>;

interface CloneFrame {
  readonly target: MutableJsonContainer;
  readonly entries: ReadonlyArray<readonly [string, unknown]>;
  readonly path: JsonPath;
  readonly array: boolean;
}

interface JsonResourceBudget {
  nodes: number;
  stringCodeUnits: number;
}

type JsonResourceLimit = 'nodes' | 'stringCodeUnits';

type CloneFailure = { readonly ok: false };
type CloneResult = { readonly ok: true; readonly value: JsonValue } | CloneFailure;
type DataPropertyResult =
  | { readonly ok: true; readonly key: string; readonly value: unknown }
  | CloneFailure;
type PatchPropertyResult =
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

function createJsonResourceBudget(): JsonResourceBudget {
  return { nodes: 0, stringCodeUnits: 0 };
}

function chargeJsonResourceBudget(
  budget: JsonResourceBudget,
  nodes: number,
  stringCodeUnits: number,
): JsonResourceLimit | undefined {
  budget.nodes += nodes;
  if (budget.nodes > JSON_RESOURCE_LIMITS.maxNodes) return 'nodes';
  budget.stringCodeUnits += stringCodeUnits;
  if (budget.stringCodeUnits > JSON_RESOURCE_LIMITS.maxStringCodeUnits) {
    return 'stringCodeUnits';
  }
  return undefined;
}

function jsonResourceLimitMessage(limit: JsonResourceLimit): string {
  return limit === 'nodes'
    ? `JsonValue exceeds max node count ${JSON_RESOURCE_LIMITS.maxNodes}`
    : `JsonValue exceeds max string code units ${JSON_RESOURCE_LIMITS.maxStringCodeUnits}`;
}

function chargeJsonResourceOrReject(
  budget: JsonResourceBudget,
  nodes: number,
  stringCodeUnits: number,
  path: JsonPath,
  ctx: z.RefinementCtx,
): boolean {
  const limit = chargeJsonResourceBudget(budget, nodes, stringCodeUnits);
  if (limit === undefined) return true;
  rejectJson(ctx, jsonResourceLimitMessage(limit), path);
  return false;
}

function isDataDescriptor(
  descriptor: PropertyDescriptor | undefined,
): descriptor is UnknownDataDescriptor {
  return descriptor !== undefined && Object.hasOwn(descriptor, 'value');
}

function isJsonArray(value: JsonValue): value is readonly JsonValue[] {
  return Array.isArray(value);
}

function isPlainObjectPrototype(prototype: object | null): boolean {
  return prototype === Object.prototype || prototype === null;
}

function defineDataEntry(target: object, key: string, value: unknown): void {
  Object.defineProperty(target, key, {
    value,
    writable: true,
    enumerable: true,
    configurable: true,
  });
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
  keys: readonly (string | symbol)[],
  path: JsonPath,
  ctx: z.RefinementCtx,
): ContainerResult {
  const length = readArrayLength(value, path, ctx);
  if (length === undefined) return { ok: false };
  const entries: Array<readonly [string, unknown]> = [];
  for (const key of keys) {
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
  keys: readonly (string | symbol)[],
  path: JsonPath,
  ctx: z.RefinementCtx,
  budget: JsonResourceBudget,
): ContainerResult {
  const entries: Array<readonly [string, unknown]> = [];
  for (const key of keys) {
    const property = readDataProperty(value, key, path, ctx);
    if (!property.ok) return property;
    if (RESERVED_JSON_KEYS.has(property.key)) {
      return rejectJson(ctx, `reserved key "${property.key}" not allowed in JsonValue`, [
        ...path,
        property.key,
      ]);
    }
    if (!chargeJsonResourceOrReject(budget, 0, property.key.length, [...path, property.key], ctx)) {
      return { ok: false };
    }
    entries.push([property.key, property.value]);
  }
  return { ok: true, target: {}, entries, array: false };
}

function inspectContainer(
  value: object,
  path: JsonPath,
  ctx: z.RefinementCtx,
  budget: JsonResourceBudget,
): ContainerResult {
  const array = Array.isArray(value);
  const prototype = Reflect.getPrototypeOf(value);
  if (array && prototype !== Array.prototype) {
    return rejectJson(ctx, 'JsonValue container has an unsupported prototype', path);
  }
  if (!array && !isPlainObjectPrototype(prototype)) {
    return rejectJson(ctx, 'JsonValue container has an unsupported prototype', path);
  }
  const keys = Reflect.ownKeys(value);
  return array
    ? inspectArray(value, keys, path, ctx)
    : inspectRecord(value, keys, path, ctx, budget);
}

function allocateJsonValue(
  value: unknown,
  depth: number,
  path: JsonPath,
  ctx: z.RefinementCtx,
  seen: WeakSet<object>,
  stack: CloneFrame[],
  budget: JsonResourceBudget,
): CloneResult {
  if (depth > JSON_RESOURCE_LIMITS.maxDepth) {
    return rejectJson(
      ctx,
      `JsonValue nesting exceeds max depth ${JSON_RESOURCE_LIMITS.maxDepth}`,
      path,
    );
  }
  const stringCodeUnits = typeof value === 'string' ? value.length : 0;
  if (!chargeJsonResourceOrReject(budget, 1, stringCodeUnits, path, ctx)) return { ok: false };
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

  const container = inspectContainer(value, path, ctx, budget);
  if (!container.ok) return container;
  seen.add(value);
  stack.push({
    target: container.target,
    entries: container.entries,
    path,
    array: container.array,
  });
  return { ok: true, value: container.target };
}

function cloneJsonTreeWithBudget(
  raw: unknown,
  ctx: z.RefinementCtx,
  budget: JsonResourceBudget,
  rootPath: JsonPath = [],
): CloneResult {
  const seen = new WeakSet<object>();
  const stack: CloneFrame[] = [];

  try {
    const root = allocateJsonValue(raw, 0, rootPath, ctx, seen, stack, budget);
    if (!root.ok) return root;
    let frame: CloneFrame | undefined;
    while ((frame = stack.pop()) !== undefined) {
      for (const [key, value] of frame.entries) {
        const pathKey = frame.array ? Number(key) : key;
        const child = allocateJsonValue(
          value,
          frame.path.length + 1,
          [...frame.path, pathKey],
          ctx,
          seen,
          stack,
          budget,
        );
        if (!child.ok) return child;
        defineDataEntry(frame.target, key, child.value);
      }
    }
    return root;
  } catch {
    return rejectJson(ctx, 'JsonValue container reflection failed', rootPath);
  }
}

function cloneJsonTree(raw: unknown, ctx: z.RefinementCtx): unknown {
  const result = cloneJsonTreeWithBudget(raw, ctx, createJsonResourceBudget());
  return result.ok ? result.value : undefined;
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

// Use after each mutation of an already-canonical private document. This check
// deliberately neither clones nor freezes the mutable intermediate.
export function assertJsonResourceBudget(value: JsonValue): void {
  const budget = createJsonResourceBudget();
  const seen = new WeakSet<object>();
  const pending: Array<{ readonly value: JsonValue; readonly depth: number }> = [
    { value, depth: 0 },
  ];

  while (pending.length > 0) {
    const entry = pending.pop();
    if (entry === undefined) break;
    if (entry.depth > JSON_RESOURCE_LIMITS.maxDepth) {
      throw new RangeError(`JsonValue nesting exceeds max depth ${JSON_RESOURCE_LIMITS.maxDepth}`);
    }
    const stringCodeUnits = typeof entry.value === 'string' ? entry.value.length : 0;
    const limit = chargeJsonResourceBudget(budget, 1, stringCodeUnits);
    if (limit !== undefined) throw new RangeError(jsonResourceLimitMessage(limit));
    if (entry.value === null || typeof entry.value !== 'object') continue;
    if (seen.has(entry.value))
      throw new TypeError('JsonValue must be a tree without cycles or aliases');
    seen.add(entry.value);
    if (isJsonArray(entry.value)) {
      for (const child of entry.value) pending.push({ value: child, depth: entry.depth + 1 });
      continue;
    }
    for (const [key, child] of Object.entries(entry.value)) {
      const keyLimit = chargeJsonResourceBudget(budget, 0, key.length);
      if (keyLimit !== undefined) throw new RangeError(jsonResourceLimitMessage(keyLimit));
      pending.push({ value: child, depth: entry.depth + 1 });
    }
  }
}

// Descriptor-safe shallow clone for dynamic-key records. Values are deliberately
// left untouched for their supplied schema; guardedRecord is shallow-readonly.
export const guardReservedKeys = (raw: unknown, ctx: z.RefinementCtx): unknown => {
  if (raw === null || typeof raw !== 'object') return raw;
  try {
    const prototype = Reflect.getPrototypeOf(raw);
    if (Array.isArray(raw) || !isPlainObjectPrototype(prototype)) {
      ctx.addIssue({ code: 'custom', message: 'dynamic-key container must be a plain record' });
      return undefined;
    }
    const clone: Record<string, unknown> = {};
    for (const key of Reflect.ownKeys(raw)) {
      const property = readDataProperty(raw, key, [], ctx);
      if (!property.ok) return undefined;
      if (RESERVED_JSON_KEYS.has(property.key)) {
        ctx.addIssue({
          code: 'custom',
          message: `reserved key "${property.key}" not allowed in JsonValue`,
          path: [property.key],
        });
        return undefined;
      }
      defineDataEntry(clone, property.key, property.value);
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
const JsonObjectCore: z.ZodType<Readonly<Record<string, JsonValue>>> = z
  .record(z.string(), JsonValueCore)
  .readonly();

export const JsonObjectSchema: z.ZodType<Readonly<Record<string, JsonValue>>> = z.preprocess(
  cloneJsonTree,
  JsonObjectCore,
);

// RFC-6902 operations as a discriminated union over `op`.
const PatchStringSchema = z.string().max(JSON_RESOURCE_LIMITS.maxStringCodeUnits);

const createJsonPatchCore = (valueSchema: z.ZodType<JsonValue>) =>
  z.discriminatedUnion('op', [
    z.object({ op: z.literal('add'), path: PatchStringSchema, value: valueSchema }),
    z.object({ op: z.literal('replace'), path: PatchStringSchema, value: valueSchema }),
    z.object({ op: z.literal('remove'), path: PatchStringSchema }),
    z.object({ op: z.literal('move'), from: PatchStringSchema, path: PatchStringSchema }),
    z.object({ op: z.literal('copy'), from: PatchStringSchema, path: PatchStringSchema }),
    z.object({ op: z.literal('test'), path: PatchStringSchema, value: valueSchema }),
  ]);

export const JsonPatchSchema = z
  .preprocess(guardReservedKeys, createJsonPatchCore(JsonValueSchema))
  .readonly();
export type JsonPatch = z.infer<typeof JsonPatchSchema>;

const ClonedJsonPatchSchema = createJsonPatchCore(JsonValueCore).readonly();

type UnknownCloneResult = { readonly ok: true; readonly value: unknown } | { readonly ok: false };

function rejectPatch(
  ctx: z.RefinementCtx,
  message: string,
  path: readonly PropertyKey[] = [],
): { readonly ok: false } {
  ctx.addIssue({ code: 'custom', message, path: [...path] });
  return { ok: false };
}

function isPatchMetadataScalar(value: unknown): value is string | number | boolean | null {
  return (
    value === null ||
    typeof value === 'string' ||
    typeof value === 'number' ||
    typeof value === 'boolean'
  );
}

function clonePatchPropertyValue(
  key: string,
  value: unknown,
  index: number,
  ctx: z.RefinementCtx,
  budget: JsonResourceBudget,
): UnknownCloneResult {
  if (key === 'value') return cloneJsonTreeWithBudget(value, ctx, budget, [index, key]);
  if (!isPatchMetadataScalar(value)) return { ok: true, value };
  const stringCodeUnits = typeof value === 'string' ? value.length : 0;
  return chargeJsonResourceOrReject(budget, 1, stringCodeUnits, [index, key], ctx)
    ? { ok: true, value }
    : { ok: false };
}

function clonePatchProperty(
  raw: object,
  key: string | symbol,
  index: number,
  ctx: z.RefinementCtx,
  budget: JsonResourceBudget,
): PatchPropertyResult {
  if (typeof key !== 'string' || RESERVED_JSON_KEYS.has(key)) {
    return rejectPatch(ctx, 'JSON patch operation has an invalid key', [index]);
  }
  const descriptor = Reflect.getOwnPropertyDescriptor(raw, key);
  if (!isDataDescriptor(descriptor) || descriptor.enumerable !== true) {
    return rejectPatch(ctx, 'JSON patch operation requires enumerable data properties', [index]);
  }
  if (!chargeJsonResourceOrReject(budget, 0, key.length, [index, key], ctx)) {
    return { ok: false };
  }
  const cloned = clonePatchPropertyValue(key, descriptor.value, index, ctx, budget);
  return cloned.ok ? { ok: true, key, value: cloned.value } : cloned;
}

function clonePatchOperation(
  raw: unknown,
  index: number,
  ctx: z.RefinementCtx,
  budget: JsonResourceBudget,
): UnknownCloneResult {
  if (raw === null || typeof raw !== 'object') return { ok: true, value: raw };
  try {
    const prototype = Reflect.getPrototypeOf(raw);
    if (Array.isArray(raw) || (prototype !== Object.prototype && prototype !== null)) {
      return rejectPatch(ctx, 'JSON patch operation must be a plain record', [index]);
    }
    if (!chargeJsonResourceOrReject(budget, 1, 0, [index], ctx)) return { ok: false };
    const clone: Record<string, unknown> = {};
    for (const key of Reflect.ownKeys(raw)) {
      const property = clonePatchProperty(raw, key, index, ctx, budget);
      if (!property.ok) return property;
      Object.defineProperty(clone, property.key, {
        value: property.value,
        writable: true,
        enumerable: true,
        configurable: true,
      });
    }
    return { ok: true, value: clone };
  } catch {
    return rejectPatch(ctx, 'JSON patch operation reflection failed', [index]);
  }
}

function readPatchArrayLength(raw: object, ctx: z.RefinementCtx): number | undefined {
  if (!Array.isArray(raw) || Reflect.getPrototypeOf(raw) !== Array.prototype) {
    rejectPatch(ctx, 'JSON patch must be an ordinary array');
    return undefined;
  }
  const descriptor = Reflect.getOwnPropertyDescriptor(raw, 'length');
  if (
    !isDataDescriptor(descriptor) ||
    typeof descriptor.value !== 'number' ||
    !Number.isSafeInteger(descriptor.value) ||
    descriptor.value < 0
  ) {
    rejectPatch(ctx, 'JSON patch array has an invalid length');
    return undefined;
  }
  if (descriptor.value > JSON_RESOURCE_LIMITS.maxPatchOperations) {
    rejectPatch(
      ctx,
      `JSON patch exceeds max operations ${JSON_RESOURCE_LIMITS.maxPatchOperations}`,
    );
    return undefined;
  }
  return descriptor.value;
}

function clonePatchMembers(
  raw: object,
  length: number,
  ctx: z.RefinementCtx,
  budget: JsonResourceBudget,
): unknown[] | undefined {
  const clone: unknown[] = [];
  let members = 0;
  for (const key of Reflect.ownKeys(raw)) {
    if (key === 'length') continue;
    if (typeof key !== 'string' || !isCanonicalArrayMember(key, length)) {
      rejectPatch(ctx, 'JSON patch array has a non-index member');
      return undefined;
    }
    const index = Number(key);
    let descriptor: PropertyDescriptor | undefined;
    try {
      descriptor = Reflect.getOwnPropertyDescriptor(raw, key);
    } catch {
      rejectPatch(ctx, 'JSON patch array member reflection failed', [index]);
      return undefined;
    }
    if (!isDataDescriptor(descriptor) || descriptor.enumerable !== true) {
      rejectPatch(ctx, 'JSON patch array requires data properties', [index]);
      return undefined;
    }
    const operation = clonePatchOperation(descriptor.value, index, ctx, budget);
    if (!operation.ok) return undefined;
    Object.defineProperty(clone, key, {
      value: operation.value,
      writable: true,
      enumerable: true,
      configurable: true,
    });
    members += 1;
  }
  if (members === length) return clone;
  rejectPatch(ctx, 'JSON patch array must be dense');
  return undefined;
}

function clonePatchArray(raw: unknown, ctx: z.RefinementCtx): unknown {
  if (raw === null || typeof raw !== 'object') return raw;
  try {
    const budget = createJsonResourceBudget();
    if (!chargeJsonResourceOrReject(budget, 1, 0, [], ctx)) return undefined;
    const length = readPatchArrayLength(raw, ctx);
    return length === undefined ? undefined : clonePatchMembers(raw, length, ctx, budget);
  } catch {
    rejectPatch(ctx, 'JSON patch array reflection failed');
    return undefined;
  }
}

export const JsonPatchArraySchema = z.preprocess(
  clonePatchArray,
  z.array(ClonedJsonPatchSchema).max(JSON_RESOURCE_LIMITS.maxPatchOperations).readonly(),
);
