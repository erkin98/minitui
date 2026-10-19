import type { SyntaxNode } from './parser.js';

// Whether the host can say what an operand expands to. Decided on the PARSE TREE, not on argv text, so
// quoting is visible: a single-quoted string and a double-quoted string without an expansion are
// resolved, an unquoted word that holds a glob character is not, and neither is any expansion other
// than exactly `$HOME` or `${HOME}` (the one the host resolves). A host-built argument that carries a
// bracketed filter graph in single quotes is therefore not flagged.

const EXPANSION_KINDS: ReadonlySet<string> = new Set(['simple_expansion', 'expansion']);
const EXACT_HOME = /^(\$HOME|\$\{HOME\})$/;
const GLOB_CHAR = /[*?[]/;
// a brace expansion: a comma list or a range between braces (`{a,b}`, `{1..3}`); a lone `{}` is literal
const BRACE_EXPANSION = /\{[^{}]*(,|\.\.)[^{}]*\}/;

const kidsOf = (node: SyntaxNode): SyntaxNode[] =>
  node.namedChildren.filter((child): child is SyntaxNode => child !== null);

const withoutEscapes = (text: string): string => text.replace(/\\./g, '');

// The text of a concatenation as the shell would see its braces: quoted pieces collapse to a
// placeholder, because a quoted comma or brace does not expand.
function braceSkeleton(node: SyntaxNode): string {
  return kidsOf(node)
    .map((kid) =>
      kid.type === 'string' || kid.type === 'raw_string' ? 'Q' : withoutEscapes(kid.text),
    )
    .join('');
}

// An unquoted glob character or brace expansion anywhere in the node. Used on its own for the
// command-name position, where an expansion is refused by a separate rule.
export function hasUnquotedGlobOrBrace(node: SyntaxNode): boolean {
  switch (node.type) {
    case 'word':
      return (
        GLOB_CHAR.test(withoutEscapes(node.text)) || BRACE_EXPANSION.test(withoutEscapes(node.text))
      );
    case 'concatenation':
      return kidsOf(node).some(hasUnquotedGlobOrBrace) || BRACE_EXPANSION.test(braceSkeleton(node));
    case 'command_name':
      return kidsOf(node).some(hasUnquotedGlobOrBrace);
    default:
      return false;
  }
}

// `scoped` is true inside the scope of an assignment, where `HOME` may have been reassigned and the
// exact-`$HOME` exemption no longer holds.
export function isUnresolved(node: SyntaxNode, scoped: boolean): boolean {
  if (EXPANSION_KINDS.has(node.type)) return scoped || !EXACT_HOME.test(node.text);
  switch (node.type) {
    case 'word':
      return hasUnquotedGlobOrBrace(node);
    case 'concatenation':
      return (
        kidsOf(node).some((kid) => isUnresolved(kid, scoped)) ||
        BRACE_EXPANSION.test(braceSkeleton(node))
      );
    case 'string':
      return kidsOf(node).some((kid) => EXPANSION_KINDS.has(kid.type) && isUnresolved(kid, scoped));
    default:
      return false;
  }
}

// The same test on argv TEXT, for a root that did not come from a tree (the exec-time re-gate builds
// roots with literal argv and the floor must give the same answer for rm). An expansion that is not
// exactly `$HOME` or `${HOME}`, or a brace expansion, is unresolved.
export function textIsUnresolved(token: string): boolean {
  const withoutHome = token.replace(/\$\{HOME\}|\$HOME(?![A-Za-z0-9_])/g, '');
  return withoutHome.includes('$') || withoutHome.includes('`') || BRACE_EXPANSION.test(token);
}

// A relative operand with a `..` component: with no working directory the floor cannot resolve it, so
// the root that holds one is opaque. An operand anchored at `~`, `$HOME` or `/` is resolved lexically
// by the floor instead.
export function isRelativeDotDot(token: string): boolean {
  if (/^(~|\$HOME|\$\{HOME\}|\/)/.test(token)) return false;
  return token.split('/').includes('..');
}
