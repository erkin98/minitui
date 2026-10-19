import type { ParsedCommand, CommandRoot } from '@minitui/types';
import { freeTree, parseToTree, type SyntaxNode } from './parser.js';
import { hasSubstitution } from './substitution.js';
import { unwrapArgv, type PeeledWrapper } from './wrappers.js';
import { unaccountedNodes } from './accounting.js';
import { hasGlobOrBrace, hasLineBreak, isNonCommandName } from './names.js';
import { hasUnquotedGlobOrBrace, isRelativeDotDot, isUnresolved } from './operands.js';
import { currentHost, foldsCase, type Host } from './host.js';

const REDIRECT_TYPES = new Set(['file_redirect']);

// Positive node-kind allowlist. Rather than enumerate dangerous constructs, enumerate the kinds this
// file's walk MODELS and fail-closed on anything else. The set is deliberately WIDER than a plain
// reject-all-complex approach because minitui GATES (not rejects) the constructs it keeps — it KEEPS
// expansions as argv text so the hard-floor sees `$HOME`, force-denies on substitution, drops leading
// assignments, threads redirect targets. Verified against the real 0.25.1 grammar on all modeled
// test commands. Any NAMED node outside the set (subshell/compound_statement/
// arithmetic_expansion/if/for/while/case/function_definition/test_command/array/declaration_command)
// is a construct minitui does NOT model → fail-closed to parseError → the engine DENIES it. A future
// grammar node auto-rejects by construction — the fail-closed property an enumerate-the-bad walk lacked.
// A heredoc or herestring is absent on purpose: the host never emits one, and its body hides a command
// from every root, so it is a parse error in every approval mode. Re-admitting one starts with
// extending the word accounting in accounting.ts.
const ALLOWED_NODE_KINDS: ReadonlySet<string> = new Set([
  // containers
  'program',
  'list',
  'pipeline',
  'redirected_statement',
  // command core
  'command',
  'command_name',
  // words / literals
  'word',
  'string',
  'string_content',
  'raw_string',
  'number',
  'concatenation',
  // expansions — KEPT as text so the hard-floor sees $HOME / ${HOME} / $@
  'simple_expansion',
  'expansion',
  'variable_name',
  'special_variable_name',
  // substitutions — forced to deny via hasSubstitution (never allowed)
  'command_substitution',
  'process_substitution',
  // leading assignment-prefix — dropped from argv so `FOO=bar curl` gates as `curl`
  'variable_assignment',
  // a trailing comment (`ls # note`) is a modeled, harmless node — not an unmodeled construct
  'comment',
  // redirects — target threaded onto the gated root argv
  'file_redirect',
  'file_descriptor',
]);

// True iff every NAMED node in the tree is a kind this file models. A dangerous construct always
// introduces a NAMED node (subshell/compound_statement/arithmetic_expansion/…), so the named-node
// allowlist is the tight fail-closed gate; anonymous operator/quote tokens need no check.
function hasOnlyKnownNodes(node: SyntaxNode): boolean {
  if (node.isNamed && !ALLOWED_NODE_KINDS.has(node.type)) return false;
  for (const child of node.namedChildren) {
    if (child && !hasOnlyKnownNodes(child)) return false;
  }
  return true;
}

const namedKids = (node: SyntaxNode): SyntaxNode[] =>
  node.namedChildren.filter((child): child is SyntaxNode => child !== null);

// One redirect: its operator token (`>`, `>>`, `2>`'s `>`, `&>>`, …) and its destination words. The
// grammar reads every word after the first destination as part of the redirect (`rm 2>/dev/null -rf ~`
// gives the redirect three destinations after the descriptor), so only the first is a target.
interface Redirect {
  readonly operator: string;
  readonly destinations: readonly SyntaxNode[];
}

function redirectOf(node: SyntaxNode): Redirect {
  const operator = node.children.find((child) => child !== null && !child.isNamed)?.text ?? '';
  const destinations = node
    .childrenForFieldName('destination')
    .filter((child): child is SyntaxNode => child !== null);
  return { operator, destinations };
}

// A command the walk found, before the wrapper peel. `owned` lists every argument-position node this
// root accounts for, so the accounting can prove no word was dropped or counted twice.
export interface RawRoot {
  // the command node; undefined for the root of a redirect that has no command
  readonly cmd: SyntaxNode | undefined;
  // set only on the root of a redirect that has no command: the operator text names it
  readonly operator: string | undefined;
  // words a redirect absorbed that belong to the command, appended to its argv BEFORE the wrapper peel
  readonly absorbed: readonly string[];
  // redirect targets, appended AFTER the resolved argv so the hard-floor sees a `> secret` target
  readonly targets: readonly string[];
  readonly owned: readonly SyntaxNode[];
  // the assignments this root owns: its leading ones and the standalone ones that preceded it
  readonly assigned: readonly SyntaxNode[];
  // a standalone assignment came before this root in the command
  readonly scoped: boolean;
}

export type RootCollector = (root: SyntaxNode) => RawRoot[];

// Fold redirects into a root: each redirect's first destination is a target, the rest are absorbed
// command words. Canonicalized exactly as an argv token is, so a quoted evasion `> ~/.s"s"h/…` or
// `> /de"v"/tcp/…` cannot hide the secret or egress path.
function withRedirects(root: RawRoot, redirects: readonly Redirect[]): RawRoot {
  const words = redirects.map((redirect) => redirect.destinations.map(canonicalizeNode));
  return {
    ...root,
    absorbed: [...root.absorbed, ...words.flatMap((w) => w.slice(1))],
    targets: [...root.targets, ...words.flatMap((w) => w.slice(0, 1))],
    owned: [...root.owned, ...redirects.flatMap((redirect) => redirect.destinations)],
  };
}

// A redirect with no command at all (`> ~/.ssh/authorized_keys`) still has a destination the floor
// must see. It becomes a root named for the operator text, carrying every destination.
function redirectOnlyRoot(
  redirects: readonly Redirect[],
  adopted: readonly SyntaxNode[],
  scoped: boolean,
): RawRoot {
  const words = redirects.flatMap((r) => r.destinations.map(canonicalizeNode));
  return {
    cmd: undefined,
    operator: redirects[0]?.operator ?? '',
    absorbed: [],
    targets: words,
    owned: [...adopted, ...redirects.flatMap((r) => r.destinations)],
    assigned: adopted,
    scoped,
  };
}

function commandRoot(node: SyntaxNode, adopted: readonly SyntaxNode[], scoped: boolean): RawRoot {
  const kids = namedKids(node);
  const base: RawRoot = {
    cmd: node,
    operator: undefined,
    absorbed: [],
    targets: [],
    owned: [...adopted, ...kids.filter((kid) => !REDIRECT_TYPES.has(kid.type))],
    assigned: [...adopted, ...kids.filter((kid) => kid.type === 'variable_assignment')],
    scoped,
  };
  // leading fd-redirects that sit inside the command node
  const embedded = kids.filter((kid) => REDIRECT_TYPES.has(kid.type)).map(redirectOf);
  return withRedirects(base, embedded);
}

// A redirect sits on a `redirected_statement` SIBLING of the body, not inside it. The body may be a
// command, a pipeline or a list: the redirect and the words it absorbed belong to the LAST command
// of the body (`ls | rm >/dev/null -rf ~` gives `rm` the words `-rf ~`).
function walkRedirected(node: SyntaxNode, out: RawRoot[], state: WalkState): void {
  const kids = namedKids(node);
  const redirects = kids.filter((kid) => REDIRECT_TYPES.has(kid.type)).map(redirectOf);
  const inner: RawRoot[] = [];
  for (const kid of kids) {
    if (!REDIRECT_TYPES.has(kid.type)) walk(kid, inner, state);
  }
  const last = inner.pop();
  out.push(
    ...inner,
    last
      ? withRedirects(last, redirects)
      : redirectOnlyRoot(redirects, state.pending.splice(0), state.scoped),
  );
}

// Collect every command across && || ; | & and newlines. We never descend INTO a substitution node —
// its contents are gated by the hasSubstitution force-deny (non-YOLO-upgradable), not as roots. A
// standalone assignment is owned by the next command in document order; one with no command after
// it stays unowned, which the accounting reports as a parse error.
interface WalkState {
  // standalone assignments waiting for the next command to own them
  readonly pending: SyntaxNode[];
  // set once a standalone assignment has been seen: every root after it is in its scope
  scoped: boolean;
}

function walk(node: SyntaxNode, out: RawRoot[], state: WalkState): void {
  switch (node.type) {
    case 'command_substitution':
    case 'process_substitution':
      return;
    case 'variable_assignment':
      state.pending.push(node);
      state.scoped = true;
      return;
    case 'command':
      out.push(commandRoot(node, state.pending.splice(0), state.scoped));
      return;
    case 'redirected_statement':
      walkRedirected(node, out, state);
      return;
    default:
      for (const kid of namedKids(node)) walk(kid, out, state);
  }
}

export function collectRawRoots(root: SyntaxNode): RawRoot[] {
  const out: RawRoot[] = [];
  walk(root, out, { pending: [], scoped: false });
  return out;
}

// Parameter-expansion node kinds — a command_name carrying one of these is unresolvable.
const NAME_EXPANSION_TYPES = new Set(['simple_expansion', 'expansion']);

// True when a command's NAME position is (partly) a parameter expansion (`$X foo`, `cu${X}rl`). The
// host cannot know which binary such a name runs, so it can never be matched against egress / allow —
// parseShellCommand fails closed (deny) on it. (command/process substitution in the name is caught
// separately by hasSubstitution.)
function commandNameHasExpansion(cmd: SyntaxNode): boolean {
  const nameNode = cmd.namedChildren.find((c) => c?.type === 'command_name');
  if (!nameNode) return false;
  const walkName = (n: SyntaxNode): boolean =>
    NAME_EXPANSION_TYPES.has(n.type) || n.namedChildren.some((c) => c !== null && walkName(c));
  return walkName(nameNode);
}

// True when the command NAME holds an unquoted glob character or brace expansion (`/usr/bin/cur[l]`,
// `cur{l,x}`): the host cannot say which binary runs.
function commandNameHasGlob(cmd: SyntaxNode): boolean {
  const nameNode = cmd.namedChildren.find((c) => c?.type === 'command_name');
  return nameNode !== undefined && nameNode !== null && hasUnquotedGlobOrBrace(nameNode);
}

// Canonicalize an argument / command-name node to the string the shell would actually run, so
// quote/escape/concatenation evasions (`cu""rl`, `"cu"rl`, `\c\url`) collapse to their bare form
// BEFORE the egress / home / secret match. Driven by the node TYPE, not the verbatim source slice:
//   command_name  -> canonicalize its inner token
//   raw_string     -> inner text (drops the surrounding single quotes)
//   string         -> its string_content joined (drops the double quotes); a nested expansion is
//                     kept as raw text so `"$HOME/x"` still reaches the hard-floor
//   concatenation  -> the canonicalized parts joined (`cu""rl` -> `curl`)
//   word           -> backslash-unescape (`\c\url` -> `curl`)
//   expansions / anything else -> raw text (so `$HOME` / `${HOME}` stay matchable in argv)
function canonicalizeNode(node: SyntaxNode): string {
  switch (node.type) {
    case 'command_name':
      return (
        node.namedChildren
          .filter((c): c is SyntaxNode => c !== null)
          .map(canonicalizeNode)
          .join('') || node.text
      );
    case 'raw_string':
      return node.text.replace(/^'/, '').replace(/'$/, '');
    case 'string':
      return node.namedChildren
        .filter((c): c is SyntaxNode => c !== null)
        .map((c) => (c.type === 'string_content' ? c.text : canonicalizeNode(c)))
        .join('');
    case 'concatenation':
      return node.namedChildren
        .filter((c): c is SyntaxNode => c !== null)
        .map(canonicalizeNode)
        .join('');
    case 'word':
      return node.text.replace(/\\(.)/g, '$1');
    default:
      return node.text;
  }
}

// A `command` node's named children are leading `variable_assignment`(s), the `command_name`, and
// word/string/concatenation args. We DROP `variable_assignment` so a bare assignment-prefix
// (`FOO=bar curl ...`) resolves to the REAL command_name as the gated root — not `FOO=bar`, which
// would slip past egress and the hard-floor. (In `env X=1 curl`, `X=1` is an argument WORD, not a
// variable_assignment, so it is kept and unwrapArgv's env KEY=VALUE skip handles it.) Each surviving
// node is CANONICALIZED (quotes/escapes collapsed) so a quoted/escaped evasion can't slip the match.
// Redirect targets are threaded in separately by the walk and appended after the resolved argv.
function argvOf(cmd: SyntaxNode): string[] {
  return cmd.namedChildren
    .filter(
      (c): c is SyntaxNode =>
        c !== null && c.type !== 'variable_assignment' && !REDIRECT_TYPES.has(c.type),
    )
    .map(canonicalizeNode);
}

// The value an assignment gives its variable, as an argv token: it is appended to the argv of the root
// that owns the assignment, because the floor reads only roots and must scan it as a path.
function assignmentValues(raw: RawRoot): string[] {
  return raw.assigned
    .map((assignment) => assignment.childForFieldName('value'))
    .filter((value): value is SyntaxNode => value !== null)
    .map(canonicalizeNode)
    .filter((value) => value.length > 0);
}

// Whether the host can fully account for what a root runs or touches. An assignment (a leading one, or
// a standalone one earlier in the command) can change what runs; an operand the host cannot resolve
// (a glob, a brace, an expansion other than exact `$HOME`) is a word the shell decides later; and a
// relative `..` operand of rm cannot be resolved without a working directory.
function isOpaqueByOperands(raw: RawRoot, name: string, argv: readonly string[]): boolean {
  const inAssignmentScope = raw.scoped || raw.assigned.length > 0;
  if (inAssignmentScope) return true;
  const unresolved = raw.owned.some(
    (node) =>
      node.type !== 'command_name' &&
      node.type !== 'variable_assignment' &&
      isUnresolved(node, false),
  );
  return unresolved || (name === 'rm' && argv.slice(1).some(isRelativeDotDot));
}

function fail(raw: string): ParsedCommand {
  return { raw, roots: [], hasSubstitution: false, parseError: true };
}

// The roots a peeled wrapper yields. Its plain shape is [wrapper, ...inner argv], so a managed
// `deny "sudo rm"` keeps matching. When the wrapper carried options or operands of its own, it is
// also emitted with the argv it was written with, so the floor sees what the options name (`env -C
// ~/.gnupg tar`); that root is opaque when an option is outside the tables.
function wrapperRoots(
  wrapper: PeeledWrapper,
  innerArgv: readonly string[],
  targets: readonly string[],
): CommandRoot[] {
  const plain: CommandRoot = { name: wrapper.name, argv: [wrapper.name, ...innerArgv, ...targets] };
  const plainBase = [wrapper.name, ...innerArgv];
  const sameShape =
    wrapper.full.length === plainBase.length &&
    wrapper.full.every((tok, i) => tok === plainBase[i]);
  if (sameShape) return [plain];
  const written = [...wrapper.full, ...targets];
  return [
    plain,
    wrapper.unmodelled
      ? { name: wrapper.name, argv: written, opaque: true }
      : { name: wrapper.name, argv: written },
  ];
}

// The roots one raw root yields, or undefined when the command must fail closed.
//  - a name that is (partly) a parameter expansion, before or after the wrapper peel, is UNRESOLVABLE:
//    the host cannot know which binary runs, so it can never be matched against egress / allow rules
//    (expansions in ARGUMENTS stay as text so the hard-floor still sees `$HOME`; only the NAME forces
//    this deny, and a wrapper can hide one from the pre-peel check: `sudo $CMD`, `timeout 5 ${X}`);
//  - a name that is only digits, a reserved word or an assignment word is not a command;
//  - a token that spans lines is one word the shell reads differently.
// The wire inner root carries {name, argv}, plus opaque:true when the peel hit a spawner (`sh -c`) or
// bottomed out at an empty inner command; set ONLY when true, so a resolvable root keeps the plain
// shape. Each peeled wrapper is ALSO emitted as its own non-opaque root so a managed `deny sudo`
// still fires and no inner grant silently covers the wrapped form; the inner root stays FIRST.
function rootsOf(raw: RawRoot, fold: boolean): CommandRoot[] | undefined {
  if (raw.cmd === undefined) {
    const name = raw.operator ?? '';
    return name === '' ? undefined : [{ name, argv: [name, ...raw.targets], opaque: true }];
  }
  if (commandNameHasExpansion(raw.cmd) || commandNameHasGlob(raw.cmd)) return undefined;
  const words = [...argvOf(raw.cmd), ...raw.absorbed];
  const { name, argv, peeled, skippedAssignment, opaque: peelOpaque } = unwrapArgv(words, fold);
  if (name.includes('$') || hasGlobOrBrace(name) || isNonCommandName(name)) return undefined;
  if ([...words, ...raw.targets].some(hasLineBreak)) return undefined;
  const extras = [...raw.targets, ...assignmentValues(raw)];
  const full = [...argv, ...extras];
  const opaque = peelOpaque || skippedAssignment || isOpaqueByOperands(raw, name, argv);
  const inner: CommandRoot = opaque ? { name, argv: full, opaque: true } : { name, argv: full };
  return [inner, ...peeled.flatMap((wrapper) => wrapperRoots(wrapper, argv, extras))];
}

// The extraction step, separate from the parse so a test can hand it a collector that drops a word.
// Every argument-position node of the tree must be owned by exactly one raw root; otherwise the
// command is a parse error, denied in every approval mode.
export function extractParsedCommand(
  command: string,
  root: SyntaxNode,
  collect: RootCollector = collectRawRoots,
  fold = false,
): ParsedCommand {
  const raw = collect(root);
  if (
    unaccountedNodes(
      root,
      raw.flatMap((r) => r.owned),
    ).length > 0
  )
    return fail(command);
  const roots: CommandRoot[] = [];
  for (const r of raw) {
    const made = rootsOf(r, fold);
    if (made === undefined) return fail(command);
    roots.push(...made);
  }
  return { raw: command, roots, hasSubstitution: hasSubstitution(root), parseError: false };
}

// Synchronous. Requires ensureParserReady() to have resolved (createPermissionEngine awaits it).
export function parseShellCommand(command: string, host: Host = currentHost()): ParsedCommand {
  // A backslash followed by a line break joins lines in the shell and splits a word in this grammar
  // (`cu\<LF>rl`), so it is refused wherever it appears, quotes included.
  if (/\\[\r\n]/.test(command)) return fail(command);
  const res = parseToTree(command);
  if ('parseError' in res) return fail(command);

  // Positive node-kind allowlist: fail-closed on any construct this file does not model. A
  // subshell/arithmetic/control-flow/function node degrades to parseError rather than letting the
  // walk silently extract a partial root and imply the command was fully gated. The guarantee is a
  // RUNTIME allowlist check (`ALLOWED_NODE_KINDS.has(node.type)` over a plain string node type —
  // web-tree-sitter's node.type is not a closed union), so any node kind outside the set, including
  // one a future grammar upgrade introduces, fails CLOSED the moment it is walked.
  // Everything after the parse runs inside the fail-closed path: a walk that throws (a very long chain
  // overflows the stack) is a parse error, and the tree is released on every path once the strings
  // are out of it.
  try {
    if (!hasOnlyKnownNodes(res.root)) return fail(command);
    return extractParsedCommand(command, res.root, collectRawRoots, foldsCase(host.platform));
  } catch {
    return fail(command);
  } finally {
    freeTree(res.root);
  }
}
