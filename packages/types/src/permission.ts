import { z } from 'zod';
import { PermissionDescriptorSchema } from './actions.js';

// One subcommand root the host parser extracted from a (possibly compound)
// command. The hard floor matches EVERY root by name; argv carries the root's
// own arguments for arg-runner re-resolution.
export const CommandRootSchema = z
  .object({
    name: z.string(),
    argv: z.array(z.string()).readonly(),
  })
  .readonly();
export type CommandRoot = z.infer<typeof CommandRootSchema>;

// Output of the host shell parser. parseError:true is returned, never thrown.
// Fail closed: parseError:true or hasSubstitution:true means
// parser-uncertain -> the engine DENIES, non-YOLO-upgradable (never ask/allow).
// roots is an array of CommandRoot OBJECTS (not bare strings) so per-root gating
// can see each root's name/argv — this is what defeats `ls && rm -rf /`.
export const ParsedCommandSchema = z
  .object({
    raw: z.string(),
    roots: z.array(CommandRootSchema).readonly(),
    hasSubstitution: z.boolean(),
    parseError: z.boolean(),
    reason: z.string().optional(),
  })
  .readonly();
export type ParsedCommand = z.infer<typeof ParsedCommandSchema>;

// The host-RESOLVED values shown to the user at the consent gate — never agent text.
export const PermissionRequestSchema = z
  .object({
    id: z.string(),
    descriptor: PermissionDescriptorSchema,
    resolvedCommand: z.string(),
    resolvedPaths: z.array(z.string()).readonly(),
  })
  .readonly();
export type PermissionRequest = z.infer<typeof PermissionRequestSchema>;

// deny-first triad. ask carries the pending request the UI subscribes to.
export const DecisionSchema = z
  .discriminatedUnion('kind', [
    z.object({ kind: z.literal('allow') }),
    z.object({ kind: z.literal('deny'), reason: z.string() }),
    z.object({ kind: z.literal('ask'), request: PermissionRequestSchema }),
  ])
  .readonly();
export type Decision = z.infer<typeof DecisionSchema>;

// yolo bypasses ask/allow, NEVER the hard floor.
export const ApprovalModeSchema = z.enum(['default', 'yolo']);
export type ApprovalMode = z.infer<typeof ApprovalModeSchema>;

export const PermissionReplySchema = z
  .discriminatedUnion('kind', [
    z.object({ kind: z.literal('once') }),
    z.object({ kind: z.literal('always'), cascade: z.boolean() }),
    z.object({ kind: z.literal('reject'), feedback: z.string() }),
  ])
  .readonly();
export type PermissionReply = z.infer<typeof PermissionReplySchema>;

// Layered rule model; managed-deny is final (resolved in exec, shape lives here).
export const PermissionRuleSchema = z
  .object({
    pattern: z.string(),
    effect: z.enum(['allow', 'ask', 'deny']),
    layer: z.enum(['managed', 'user', 'project']),
    // Resolved absolute executable path the grant was approved for;
    // undefined for operator config rules + legacy grants (name-only match).
    identity: z.string().optional(),
  })
  .readonly();
export type PermissionRule = z.infer<typeof PermissionRuleSchema>;

// Compatibility alias for consumers that use the shorter rule name.
export type Rule = PermissionRule;
