import { z } from 'zod';

// The action discriminant — the no-code seam routes every action by this.
export const ACTION_KINDS = ['render-local', 'exec-local', 'exec-mcp', 'agent-callback'] as const;

export const ActionKindSchema = z.enum(ACTION_KINDS);
export type ActionKind = z.infer<typeof ActionKindSchema>;

// String(x) runs the value's own toString / Symbol.toPrimitive, either of which can
// throw. That error would replace the exhaustiveness message with the offending value's
// own noise — the reporter must survive a value that fights being rendered.
function safeString(x: unknown): string {
  try {
    return String(x);
  } catch {
    return `[unrenderable ${typeof x}]`;
  }
}

// JSON.stringify throws on a BigInt and returns undefined for a function/symbol —
// none of which are reachable through a real exhaustive switch, but an `as never`
// escape hatch (tests, or a caller that lied about exhaustiveness) can still hand
// one in, and the message-building must not fail while reporting a failure.
function renderUnhandled(x: unknown): string {
  if (typeof x === 'bigint') return `${x}n`;
  if (typeof x === 'function' || typeof x === 'symbol' || typeof x === 'undefined') {
    return safeString(x);
  }
  try {
    return JSON.stringify(x);
  } catch {
    return safeString(x);
  }
}

// Exhaustiveness helper: a discriminated-union switch whose `default` returns
// assertNever(x) fails to COMPILE if a new member is added, catching an unmodeled kind at
// build time (a second layer behind each runtime deny). No runtime dep; throws if ever hit.
export function assertNever(x: never, context?: string): never {
  throw new Error(`unhandled${context ? ` ${context}` : ''}: ${renderUnhandled(x)}`);
}

/**
 * The three-class catalog field-visibility axis (WHERE a builder-owned field is
 * callable), ordered narrowest-to-widest exposure. Owned here as the single source so
 * @minitui/catalog and @minitui/agent-core reference ONE definition instead of
 * hand-mirroring it — a shape drift between the two then fails `tsc -b`. This is the
 * CATALOG axis, distinct from agent-core's model-visibility CHANNEL axis
 * (localOnly | modelVisible | modelOnly); the two vocabularies never unify.
 */
export type VisibilityClass = 'localOnly' | 'clientOnly' | 'remoteOnly';

/**
 * The minimal built-catalog view the model-visibility adapter reads: the allowlist
 * names plus the RESOLVED per-name visibility index (a secret already folded to
 * localOnly, the clientOnly default already applied). @minitui/catalog's MinituiCatalog
 * extends this and agent-core's adapter consumes it — so the cli hands a built catalog
 * across the seam without agent-core importing the catalog package.
 */
export interface CatalogVisibilitySource {
  readonly componentNames: readonly string[];
  readonly actionNames: readonly string[];
  readonly visibilityOf: (component: string) => VisibilityClass | undefined;
  readonly callableFromOf: (action: string) => VisibilityClass | undefined;
}
