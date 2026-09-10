import type {
  PermissionRequest,
  Decision,
  PermissionReply,
  ApprovalMode,
  PermissionRule,
  ParsedCommand,
} from '@minitui/types';
import { sanitize } from '@minitui/sanitizer';
import { parseShellCommand } from './shell/roots.js';
import { ensureParserReady } from './shell/parser.js';
import { OPAQUE_SPAWNERS, STDIN_RUNNERS } from './shell/wrappers.js';
import { checkHardFloor } from './hard-floor.js';
import { resolveStatic, denyRuleFor, unsafeToolArgs, identityMismatch } from './decision.js';
import { defaultResolveExecutable, type ResolveExecutable } from './resolve-exec.js';
import type { RuleSet } from './rules.js';
import { createPendingChannel } from './pending.js';

// exec is the SOLE owner + definer of PermissionEngine — @minitui/types never exports it (it lives
// in exec). Re-exported from permission/index.ts (Task 15) for sibling-package imports.
export interface PermissionEngine {
  // the interface other packages wire through PermissionGatePort
  check(req: PermissionRequest): Promise<Decision>;
  readonly requests: AsyncIterable<PermissionRequest>;
  reply(reply: PermissionReply): void; // once | always(+cascade) | reject(feedback)
  setMode(mode: ApprovalMode): void;
  disposeAll(reason: string): void;
}

export interface EngineOptions {
  readonly initialRules: RuleSet;
  readonly mode?: ApprovalMode | undefined;
  readonly onGrant?: ((rule: PermissionRule) => void) | undefined;
  // resolve a command token to the absolute realpath it would spawn — the identity a grant is bound
  // to. Defaults to `defaultResolveExecutable` (which-semantics + realpathSync); injectable so tests
  // pass a real fake (no replacement-mock) and a non-POSIX host can supply its own resolver.
  readonly resolveExecutable?: ResolveExecutable | undefined;
}

// Strip ANSI/OSC from every host-resolved string before it reaches the consent UI
// (SECURITY-invariant (e): consent shows HOST-RESOLVED values, never raw escape sequences).
// This consent-boundary sanitize is load-bearing (do NOT weaken): rather than depend on every
// render call-site remembering to parse, minitui routes EVERY consent string through the one
// zero-dep sanitizer here. Keep it.
function sanitizeRequest(req: PermissionRequest): PermissionRequest {
  return {
    ...req,
    resolvedCommand: sanitize(req.resolvedCommand, { allow: 'none' }),
    // resolvedPaths is a host-resolved string the overlay renders as chrome, so it MUST be sanitized
    // too — the `...req` spread carried it raw, letting ESC/CSI/C0 bytes in a path reach the consent
    // modal and spoof the approval surface (the terminal-escape attack class; the sanitizer is the
    // only control here — no sandbox backstops the DISPLAY). `resolvedPaths` is a required readonly
    // array, so map every element unconditionally.
    resolvedPaths: req.resolvedPaths.map((p) => sanitize(p, { allow: 'none' })),
    descriptor: {
      ...req.descriptor,
      summaryTemplate: sanitize(req.descriptor.summaryTemplate, { allow: 'none' }),
    },
  };
}

// 'always' grant: cascade => broad grant on the gated root name; else narrow on the resolved command.
// Bind the grant to the RESOLVED executable identity (realpath of argv[0]) so a later $PATH/symlink
// swap of the same basename can't inherit it. `identity` is left off when the command can't be
// resolved — that grant keeps name-only match + the exec-time re-gate as backstop (undefined is
// elided, not stored, for exactOptionalPropertyTypes).
function grantFor(
  req: PermissionRequest,
  parsed: ParsedCommand,
  cascade: boolean,
  resolveExecutable: ResolveExecutable,
): PermissionRule {
  const root = parsed.roots[0];
  const pattern = cascade && root ? root.name : req.resolvedCommand;
  const identity = root ? resolveExecutable(root.argv[0] ?? root.name) : undefined;
  return identity === undefined
    ? { pattern, effect: 'allow', layer: 'user' }
    : { pattern, effect: 'allow', layer: 'user', identity };
}

export function createEngine(opts: EngineOptions): PermissionEngine {
  let rules: PermissionRule[] = [...opts.initialRules.rules];
  let mode: ApprovalMode = opts.mode ?? 'default';
  const pending = createPendingChannel();
  const resolveExecutable = opts.resolveExecutable ?? defaultResolveExecutable; // grant-identity resolver

  function addGrant(rule: PermissionRule): void {
    rules = [...rules, rule];
    opts.onGrant?.(rule);
  }

  // The fixed step order (parseError/substitution deny -> non-overridable hard floor -> deny-first
  // triad -> non-YOLO-liftable ask) must stay visible in one function; the branch count is inherent
  // to the security sequence.
  // eslint-disable-next-line complexity
  async function check(req: PermissionRequest): Promise<Decision> {
    await ensureParserReady(); // idempotent; first call pays the wasm init
    const parsed = parseShellCommand(req.resolvedCommand);

    // 0. fail-closed degraded-parse guard. An unparseable OR unmodeled command (the positive
    //    node-kind allowlist routes ANY construct minitui does not model to parseError) is NEVER
    //    auto-approved; this runs BEFORE the YOLO bypass so YOLO cannot lift it. minitui hard-DENIES
    //    a degraded parse rather than degrading it to a still-allowable prompt.
    // The deny reason names the fail-closed cause AND the fix (what the user can do about it).
    if (parsed.parseError) {
      return {
        kind: 'deny',
        reason:
          'unparseable or uses an unmodeled construct (fail-closed) — rewrite as a direct command; ' +
          'subshells, control-flow, and function definitions are not supported',
      };
    }

    // 0.5 shell substitution — non-YOLO-upgradable DENY, mirroring the parseError deny above.
    //     Checked BEFORE the hard floor and the YOLO bypass so YOLO can never lift it. The AST
    //     cannot see what a substitution expands to, and collectRoots is structurally blind to
    //     substitution bodies (the hidden `rm -rf ~` in `ffmpeg -i $(rm -rf ~).mp4` never reaches the
    //     hard floor) — a human `ask` would rubber-stamp an effect the host has admitted it cannot
    //     resolve (defeats invariant (e)). Hard-deny forces the agent to rewrite without substitution.
    if (parsed.hasSubstitution) {
      return {
        kind: 'deny',
        reason:
          'shell substitution is never permitted — the host cannot verify what $(…), backticks, ' +
          'or <(…) expand to; rewrite the command without substitution',
      };
    }

    // 1. hard floor — non-overridable, ignores mode entirely
    const floor = checkHardFloor(parsed, req.resolvedPaths);
    if (floor.blocked) return { kind: 'deny', reason: floor.reason ?? 'blocked by hard floor' };

    // 2. deny-first static triad over the live rules (resolveExecutable binds grant identity)
    const verdict = resolveStatic(parsed, { rules }, resolveExecutable);
    if (verdict === 'deny') {
      // name the rule that fired instead of a bare "denied by rule". rule.pattern/layer are
      // operator-authored RuleSet config, not agent/command text, so no sanitize() is needed here —
      // the consent-boundary sanitize stays scoped to the surfaced ask-path request below.
      const rule = denyRuleFor(parsed, { rules });
      const reason = rule
        ? `denied by ${rule.layer} rule '${rule.pattern}'`
        : 'denied by rule (no matching rule identified)';
      return { kind: 'deny', reason };
    }
    if (verdict === 'allow') return { kind: 'allow' };

    // 3. ask — yolo bypasses ONLY the prompt, and ONLY for a fully-understood command. A
    //    parser-uncertain ask (opaque spawner, no recognised root), an unsafe-tool-arg ask (git
    //    global-option hijack, ffmpeg network-input SSRF), OR a grant-identity mismatch (the resolved
    //    argv[0] no longer matches the realpath the grant was approved for) always reaches the human —
    //    YOLO never silently allows what the host could not fully resolve or vouch for, and an `ask`
    //    YOLO override would defeat the unsafe-arg / identity downgrade. (Substitution is already
    //    hard-denied at step 0.5, mirroring parseError, so it is absent here.)
    const uncertain =
      parsed.roots.length === 0 ||
      parsed.roots.some((r) => OPAQUE_SPAWNERS.has(r.name)) ||
      parsed.roots.some((r) => STDIN_RUNNERS.has(r.name)) || // xargs feeds its target from stdin — invisible to the name-based floor, never YOLO-lifted
      parsed.roots.some((r) => unsafeToolArgs(r)) || // git global-opt / ffmpeg net-input never YOLO-lifted
      parsed.roots.some((r) => identityMismatch(r, { rules }, resolveExecutable)); // a swapped-identity grant is host-uncertainty, never YOLO-lifted
    if (mode === 'yolo' && !uncertain) return { kind: 'allow' };

    const resolution = await pending.ask(sanitizeRequest(req));
    if (resolution.kind === 'reject') {
      return { kind: 'deny', reason: resolution.feedback ?? 'rejected' };
    }
    if (resolution.kind === 'always') {
      addGrant(grantFor(req, parsed, resolution.cascade ?? false, resolveExecutable));
    }
    return { kind: 'allow' }; // once | always
  }

  return {
    check,
    requests: pending.requests,
    reply: (reply: PermissionReply) => pending.reply(reply),
    setMode: (m: ApprovalMode) => {
      mode = m;
    },
    disposeAll: (reason: string) => pending.disposeAll(reason),
  };
}
