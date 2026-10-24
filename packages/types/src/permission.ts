import { z } from 'zod';
import { PermissionDescriptorSchema } from './actions.js';

// One subcommand root the host parser extracted from a (possibly compound)
// command. The hard floor matches EVERY root by name; argv carries the root's
// own arguments for arg-runner re-resolution.
export const CommandRootSchema = z
  .object({
    name: z.string(),
    argv: z.array(z.string()).readonly(),
    // `opaque: true` on a root means the host cannot fully account for what that root runs or touches.
    // Producers, in the root extractor only: a spawner, a shell or a command-string builtin; an
    // argument runner peeled to an empty inner command; a root with an unresolved operand (an
    // expansion other than exact `$HOME`, or an unquoted glob or brace expansion); every root in the
    // scope of a leading or standalone assignment; the inner root behind a wrapper option the table
    // does not model; a `NAME=value` operand skipped by the `env` or `sudo` peel; the synthetic root
    // of a redirect with no command; a relative `rm` operand in a command that also changes
    // directory (`cd`, `pushd`) or that a wrapper option runs from another directory or another root;
    // and a builtin that evaluates a quoted operand the host cannot read (`printf -v`, `let`, `test -v`,
    // `read -a` or any `read` operand holding a bracket, `mapfile -C`, `readarray -C`, `wait -p`, `compgen`, and a declaration builtin reached through `builtin` or `command`). Consumers: such a root asks; no approval mode lifts it; an allow
    // rule or a grant never satisfies it; a deny rule still fires first; `always` on an uncertain ask
    // allows this request and mints no grant. The hard floor runs on every root and accepts a
    // hand-built parsed command with literal argv and no `opaque`. Omitted on a resolvable root, so
    // such a root's shape stays {name, argv}.
    opaque: z.boolean().optional(),
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

// A reply names the request it answers (`requestId`, the id the host minted for that request). The
// gate resolves exactly that request: a reply whose id matches no request waiting for approval
// resolves nothing, so an answer can never approve a request the person was not shown.
export const PermissionReplySchema = z
  .discriminatedUnion('kind', [
    z.object({ kind: z.literal('once'), requestId: z.string() }),
    z.object({ kind: z.literal('always'), cascade: z.boolean(), requestId: z.string() }),
    z.object({ kind: z.literal('reject'), feedback: z.string(), requestId: z.string() }),
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
    // Present (and then always true) only on a narrow grant: one approved command, matched by string
    // equality after the deny pass. Never false, and absent on cascade grants and operator rules.
    exact: z.literal(true).optional(),
  })
  .readonly();
export type PermissionRule = z.infer<typeof PermissionRuleSchema>;

// Compatibility alias for consumers that use the shorter rule name.
export type Rule = PermissionRule;
