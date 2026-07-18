import { z } from 'zod';

// The action discriminant — the no-code seam routes every action by this.
export const ACTION_KINDS = ['render-local', 'exec-local', 'exec-mcp', 'agent-callback'] as const;

export const ActionKindSchema = z.enum(ACTION_KINDS);
export type ActionKind = z.infer<typeof ActionKindSchema>;

// Exhaustiveness helper (§Z47) — a discriminated-union switch whose `default` returns
// assertNever(x) fails to COMPILE if a new member is added, catching an unmodeled kind at
// build time (a second layer behind each runtime deny). No runtime dep; throws if ever hit.
export function assertNever(x: never, context?: string): never {
  throw new Error(`unhandled${context ? ` ${context}` : ''}: ${JSON.stringify(x)}`);
}
