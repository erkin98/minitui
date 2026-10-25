import type {
  PermissionRequest,
  Decision,
  PermissionReply,
  PermissionGatePort,
  ApprovalMode,
  PermissionRule,
  ParsedCommand,
} from '@minitui/types';
import { sanitize, CONSENT_FORBIDDEN } from '@minitui/sanitizer';
import { parseShellCommand } from './shell/roots.js';
import { currentHost, type Host } from './shell/host.js';
import { ensureParserReady } from './shell/parser.js';
import { STDIN_RUNNERS } from './shell/wrappers.js';
import { checkHardFloor } from './hard-floor.js';
import { resolveStatic, denyRuleFor, unsafeToolArgs, identityMismatch } from './decision.js';
import { defaultResolveExecutable, type ResolveExecutable } from './resolve-exec.js';
import { isBareCommandName, sameGrant, type RuleSet } from './rules.js';
import { createPendingChannel } from './pending.js';
import { exceedsConsentBudget, REQUEST_TOO_LARGE_REASON } from './consent.js';

// exec is the SOLE owner + definer of PermissionEngine — @minitui/types never exports it (it lives
// in exec). Re-exported from permission/index.ts for sibling-package imports.
// The engine is declared as an extension of the gate port, so drift on either side fails the type check
// instead of a consumer. check and requests come from the port; the rest is the engine's own.
export interface PermissionEngine extends PermissionGatePort {
  reply(reply: PermissionReply): void; // once | always(+cascade) | reject(feedback), naming its request
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
  // the machine a command will run on, for the parse and the floor. Defaults to the current machine,
  // read at each check; a test passes its own so it never writes to `process.env`.
  readonly host?: Host | undefined;
}

// The fixed reason for a request whose text cannot be shown as it is decided on. It never holds
// the offending string.
const NOT_CANONICAL_REASON =
  'request contains control or invisible characters and cannot be shown safely; rename the file or path and try again';

// A request is canonical when every string in it survives the sanitiser unchanged and holds no
// member of the consent class. The walk covers every string leaf of the request, not three named
// fields, so a string field added later is covered without an edit here. It is iterative and
// bounded: a request that is not a plain tree of reasonable size is not canonical.
const CANONICAL_WALK_LIMIT = 4096;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null;

function isCanonicalRequest(request: unknown): boolean {
  const stack: unknown[] = [request];
  for (let visited = 0; stack.length > 0; visited += 1) {
    if (visited > CANONICAL_WALK_LIMIT) return false;
    const value = stack.pop();
    if (typeof value === 'string') {
      if (CONSENT_FORBIDDEN.test(value) || sanitize(value, { allow: 'none' }) !== value) {
        return false;
      }
    } else if (isRecord(value)) {
      stack.push(...Object.values(value));
    }
  }
  return true;
}

// Strip ANSI/OSC from every host-resolved string before it reaches the consent UI
// (SECURITY: consent shows HOST-RESOLVED values, never raw escape sequences).
// This consent-boundary sanitize is load-bearing (do NOT weaken): rather than depend on every
// render call-site remembering to parse, minitui routes EVERY consent string through the one
// zero-dep sanitizer here. Keep it. It is a second layer behind the canonical-text check in `check`:
// a request that reaches it holds no string the sanitiser would change, so only a direct call shows it
// works; it is exported for that, inside the package, and is not on the barrel.
export function sanitizeRequest(req: PermissionRequest): PermissionRequest {
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

// 'always' grant. A cascade grant is a broad rule on the gated root's name. A narrow grant is stored
// as the approved command with `exact: true` and matches only that string; it exists only for a command
// with exactly one root, so for any other command `always` allows this request and stores nothing.
// Either kind is bound to the RESOLVED executable identity (realpath of argv[0]) so a later $PATH/symlink
// swap of the same basename can't inherit it. `identity` is left off when the command can't be
// resolved — that grant keeps the match + the exec-time re-gate as backstop (undefined is elided, not
// stored, for exactOptionalPropertyTypes).
function grantFor(
  req: PermissionRequest,
  parsed: ParsedCommand,
  cascade: boolean,
  resolveExecutable: ResolveExecutable,
): PermissionRule | undefined {
  const root = parsed.roots[0];
  // a cascade grant names one bare command; for a command word that is not (it holds a space or a
  // star) the grant falls back to the narrow kind, which needs a single root and otherwise stores nothing
  const narrow = !cascade || root === undefined || !isBareCommandName(root.name);
  if (narrow && parsed.roots.length !== 1) return undefined;
  const pattern = narrow || root === undefined ? req.resolvedCommand : root.name;
  const identity = root ? resolveExecutable(root.argv[0] ?? root.name) : undefined;
  return {
    pattern,
    effect: 'allow',
    layer: 'user',
    ...(narrow ? { exact: true as const } : {}),
    ...(identity === undefined ? {} : { identity }),
  };
}

export function createEngine(opts: EngineOptions): PermissionEngine {
  let rules: PermissionRule[] = [...opts.initialRules.rules];
  let mode: ApprovalMode = opts.mode ?? 'default';
  const pending = createPendingChannel();
  const resolveExecutable = opts.resolveExecutable ?? defaultResolveExecutable; // grant-identity resolver

  // A grant that is already live is not added again, so it is neither listed twice nor reported to
  // onGrant twice.
  function addGrant(rule: PermissionRule): void {
    if (rules.some((live) => sameGrant(live, rule))) return;
    rules = [...rules, rule];
    opts.onGrant?.(rule);
  }

  // The fixed step order (parseError/substitution deny -> non-overridable hard floor -> deny-first
  // triad -> non-YOLO-liftable ask) must stay visible in one function; the branch count is inherent
  // to the security sequence.
  // eslint-disable-next-line complexity
  async function check(req: PermissionRequest): Promise<Decision> {
    // -1. size budget. A request the approval box cannot show whole is denied before anything else, in
    //     every mode: what cannot be shown cannot be approved. The check is structural and cheap, so it
    //     runs first, and an oversize request is refused with the size reason even when it also holds a
    //     control character.
    if (exceedsConsentBudget(req)) return { kind: 'deny', reason: REQUEST_TOO_LARGE_REASON };

    // -0.5. canonical text. What the person approves must be the string the engine decides on, so a
    //       request holding a control or invisible character is denied next: before the parse, before
    //       the hard floor, in every approval mode. The sanitised copy shown to the overlay below is a
    //       second layer, not this control.
    if (!isCanonicalRequest(req)) return { kind: 'deny', reason: NOT_CANONICAL_REASON };

    await ensureParserReady(); // idempotent; first call pays the wasm init
    const host = opts.host ?? currentHost();
    const parsed = parseShellCommand(req.resolvedCommand, host);

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
    //     resolve (defeats host-resolved consent). Hard-deny forces a rewrite without substitution.
    if (parsed.hasSubstitution) {
      return {
        kind: 'deny',
        reason:
          'shell substitution is never permitted — the host cannot verify what $(…), backticks, ' +
          'or <(…) expand to; rewrite the command without substitution',
      };
    }

    // 1. hard floor — non-overridable, ignores mode entirely
    const floor = checkHardFloor(parsed, req.resolvedPaths, host);
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
      parsed.roots.some((r) => r.opaque === true) || // opaque root: a spawner or a wrapper peeled to an empty inner command — the payload the AST can't see, never YOLO-lifted
      parsed.roots.some((r) => STDIN_RUNNERS.has(r.name)) || // xargs feeds its target from stdin — invisible to the name-based floor, never YOLO-lifted
      parsed.roots.some((r) => unsafeToolArgs(r)) || // git global-opt / ffmpeg net-input never YOLO-lifted
      parsed.roots.some((r) => identityMismatch(r, { rules }, resolveExecutable, parsed.raw)); // a swapped-identity grant is host-uncertainty, never YOLO-lifted
    if (mode === 'yolo' && !uncertain) return { kind: 'allow' };

    const resolution = await pending.ask(sanitizeRequest(req));
    // only a once or an always reply approves; anything else is a rejection
    if (resolution.kind !== 'once' && resolution.kind !== 'always') {
      return { kind: 'deny', reason: resolution.feedback ?? 'rejected' };
    }
    // an ask the host could not fully account for allows this request and mints no grant, narrow or
    // cascade: it can never be matched safely, and the same command asks again
    if (resolution.kind === 'always' && !uncertain) {
      const grant = grantFor(req, parsed, resolution.cascade ?? false, resolveExecutable);
      if (grant !== undefined) addGrant(grant);
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
