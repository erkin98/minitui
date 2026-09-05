import type { ParsedCommand, CommandRoot } from '@minitui/types';
import { parseToTree, type SyntaxNode } from './parser.js';
import { hasSubstitution } from './substitution.js';
import { unwrapArgv } from './wrappers.js';

const REDIRECT_TYPES = new Set(['file_redirect', 'heredoc_redirect', 'herestring_redirect']);

// Positive node-kind allowlist. Rather than enumerate dangerous constructs, enumerate the kinds this
// file's walk MODELS and fail-closed on anything else. The set is deliberately WIDER than a plain
// reject-all-complex approach because minitui GATES (not rejects) the constructs it keeps — it KEEPS
// expansions as argv text so the hard-floor sees `$HOME`, force-denies on substitution, drops leading
// assignments, threads redirect targets. Verified against the real 0.25.1 grammar on all modeled
// test commands. Any NAMED node outside the set (subshell/compound_statement/
// arithmetic_expansion/if/for/while/case/function_definition/test_command/array/declaration_command)
// is a construct minitui does NOT model → fail-closed to parseError → the engine DENIES it. A future
// grammar node auto-rejects by construction — the fail-closed property an enumerate-the-bad walk lacked.
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
  'heredoc_redirect',
  'herestring_redirect',
  'heredoc_start',
  'heredoc_body',
  'heredoc_end',
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

// A redirect node's target is its last named child: `> ~/.ssh/authorized_keys` -> that path,
// `2>&1` -> the fd token. Threaded onto the gated root's argv so a `> secret` write/read target
// is visible to the hard-floor (a bare `> file` is otherwise invisible to root-name gating).
function redirectTargetsOf(node: SyntaxNode): string[] {
  const out: string[] = [];
  for (const c of node.namedChildren) {
    if (c && REDIRECT_TYPES.has(c.type)) {
      const kids = c.namedChildren.filter((k): k is SyntaxNode => k !== null);
      const target = kids.at(-1)?.text;
      if (target) out.push(target);
    }
  }
  return out;
}

interface RawRoot {
  readonly cmd: SyntaxNode;
  readonly redirects: readonly string[];
}

// Collect every `command` node across && || ; | & and newlines. A TRAILING `cmd > file` redirect
// is a redirect child of a `redirected_statement` SIBLING (not inside the command node), so at that
// level we pull the targets and tag them onto the wrapped command. We never descend INTO a
// substitution node — its contents are gated by the hasSubstitution force-deny
// (non-YOLO-upgradable), not as roots.
function collectRoots(node: SyntaxNode, out: RawRoot[]): void {
  if (node.type === 'command_substitution' || node.type === 'process_substitution') return;
  if (node.type === 'redirected_statement') {
    const redirects = redirectTargetsOf(node);
    const inner: RawRoot[] = [];
    for (const c of node.namedChildren) {
      if (c && !REDIRECT_TYPES.has(c.type)) collectRoots(c, inner);
    }
    if (inner.length > 0) {
      out.push({ cmd: inner[0]!.cmd, redirects: [...inner[0]!.redirects, ...redirects] });
      out.push(...inner.slice(1));
    }
    return;
  }
  if (node.type === 'command') {
    out.push({ cmd: node, redirects: redirectTargetsOf(node) }); // leading fd-redirects, if any
    return;
  }
  for (const child of node.namedChildren) {
    if (child) collectRoots(child, out);
  }
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
  const walk = (n: SyntaxNode): boolean =>
    NAME_EXPANSION_TYPES.has(n.type) || n.namedChildren.some((c) => c !== null && walk(c));
  return walk(nameNode);
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
// Redirect targets are threaded in separately by collectRoots and appended after the resolved argv.
function argvOf(cmd: SyntaxNode): string[] {
  return cmd.namedChildren
    .filter(
      (c): c is SyntaxNode =>
        c !== null && c.type !== 'variable_assignment' && !REDIRECT_TYPES.has(c.type),
    )
    .map(canonicalizeNode)
    .filter((t) => t.length > 0);
}

function fail(raw: string): ParsedCommand {
  return { raw, roots: [], hasSubstitution: false, parseError: true };
}

// Synchronous. Requires ensureParserReady() to have resolved (createPermissionEngine awaits it).
export function parseShellCommand(command: string): ParsedCommand {
  const res = parseToTree(command);
  if ('parseError' in res) return fail(command);

  // Positive node-kind allowlist: fail-closed on any construct this file does not model. A
  // subshell/arithmetic/control-flow/function node degrades to parseError rather than letting
  // collectRoots silently extract a partial root and imply the command was fully gated. The
  // guarantee is a RUNTIME allowlist check (`ALLOWED_NODE_KINDS.has(node.type)` over a plain string
  // node type — web-tree-sitter's node.type is not a closed union), so any node kind outside the
  // set, including one a future grammar upgrade introduces, fails CLOSED the moment it is walked.
  if (!hasOnlyKnownNodes(res.root)) return fail(command);

  const rawRoots: RawRoot[] = [];
  collectRoots(res.root, rawRoots);

  // A command_name that is (partly) a parameter expansion (`$X foo`, `cu${X}rl`) is UNRESOLVABLE —
  // the host cannot know which binary runs, so it can never be matched against egress / allow rules.
  // Fail closed (deny) rather than gate a name we cannot canonicalize. Expansions in ARGUMENTS are
  // kept as text so the hard-floor still sees `$HOME`; only the NAME position forces this deny.
  if (rawRoots.some(({ cmd }) => commandNameHasExpansion(cmd))) return fail(command);

  // unwrapArgv returns rich exec-LOCAL bookkeeping (wrappedBy/opaque); the WIRE roots carry only the
  // canonical {name, argv} shape (opaque re-derived downstream from name). Redirect target paths are
  // appended so the hard-floor sees a `> secret` write/read target. Each peeled wrapper (sudo, env,
  // npx, …) is ALSO emitted as its own root so a managed `deny sudo` still fires and no inner grant
  // silently covers the wrapped form — the inner (gated) root stays FIRST.
  const roots: CommandRoot[] = rawRoots.flatMap(({ cmd, redirects }) => {
    const { name, argv, wrappedBy } = unwrapArgv(argvOf(cmd));
    const inner: CommandRoot = { name, argv: [...argv, ...redirects] };
    const wrapperRoots: CommandRoot[] = wrappedBy.map((w) => ({
      name: w,
      argv: [w, ...inner.argv],
    }));
    return [inner, ...wrapperRoots];
  });

  return {
    raw: command,
    roots,
    hasSubstitution: hasSubstitution(res.root),
    parseError: false,
  };
}
