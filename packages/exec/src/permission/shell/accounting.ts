import type { SyntaxNode } from './parser.js';

const REDIRECT_KIND = 'file_redirect';

const isSubstitution = (node: SyntaxNode): boolean =>
  node.type === 'command_substitution' || node.type === 'process_substitution';

const namedChildrenOf = (node: SyntaxNode): SyntaxNode[] =>
  node.namedChildren.filter((child): child is SyntaxNode => child !== null);

const childrenOf = (node: SyntaxNode): SyntaxNode[] =>
  node.children.filter((child): child is SyntaxNode => child !== null);

// The argument lists of the tree, in source order: the non-redirect children of each command (its name,
// its arguments and its leading assignments, and any ANONYMOUS child: the grammar's lone `$`, `==` and
// `=~`, which the shell passes as words but the root collector, reading named children only, never owns,
// so such a command is reported unaccounted), the destinations of each file redirect, and each
// assignment that stands alone, as a list of one. The walk is independent of the root collector, so a
// collector that drops a node is caught by comparing against these lists. It does not descend into a
// substitution: the substitution deny gates those bodies, they are never roots. A redirect node is never
// an entry of a list, so it is never compared with a neighbour (`<in>out cmd`, `echo hi>out`).
export function argumentLists(root: SyntaxNode): SyntaxNode[][] {
  const lists: SyntaxNode[][] = [];
  const visit = (node: SyntaxNode, parentType: string): void => {
    if (isSubstitution(node)) return;
    if (node.type === 'command') {
      lists.push(childrenOf(node).filter((child) => child.type !== REDIRECT_KIND));
    } else if (node.type === REDIRECT_KIND) {
      lists.push(
        node.childrenForFieldName('destination').filter((c): c is SyntaxNode => c !== null),
      );
    } else if (node.type === 'variable_assignment' && parentType !== 'command') {
      lists.push([node]);
    }
    for (const child of namedChildrenOf(node)) visit(child, node.type);
  };
  visit(root, '');
  return lists;
}

// Every node that stands in argument position, in source order.
export function argumentNodes(root: SyntaxNode): SyntaxNode[] {
  return argumentLists(root).flat();
}

// The spacing lists of the tree: what the shell separates by blanks, in source order, redirects
// included as entries. Each command's children (its redirects among them), each redirected statement's
// body and trailing redirects, and each redirect's destinations. The gap check runs over these, so an
// escaped space just before a redirect is seen (`sudo -p \ >/dev/null rm -rf ~`), and a leading
// redirect between an assignment and the command name is an entry, not hidden text (`X=1 >out ls`).
export function spacingLists(root: SyntaxNode): SyntaxNode[][] {
  const lists: SyntaxNode[][] = [];
  const visit = (node: SyntaxNode): void => {
    if (isSubstitution(node)) return;
    if (node.type === 'command') lists.push(childrenOf(node));
    else if (node.type === 'redirected_statement') lists.push(namedChildrenOf(node));
    else if (node.type === REDIRECT_KIND) {
      lists.push(
        node.childrenForFieldName('destination').filter((c): c is SyntaxNode => c !== null),
      );
    }
    for (const child of namedChildrenOf(node)) visit(child);
  };
  visit(root);
  return lists;
}

// Whether two consecutive entries of one list touch: no byte between them. The shell reads two touching
// pieces as one word; the grammar can hand them over as two arguments (`'r'\m`, `~/.ss[\h]/x`), and the
// floor would then decide on words the shell never runs. A `concatenation` is one entry, so the grammar's
// own joins are unaffected.
export function touchingWords(
  spans: readonly {
    readonly startIndex: number;
    readonly endIndex: number;
    readonly type: string;
  }[],
): boolean {
  for (let i = 1; i < spans.length; i++) {
    const prev = spans[i - 1];
    const next = spans[i];
    if (prev !== undefined && next !== undefined && prev.endIndex === next.startIndex) return true;
  }
  return false;
}

// Whether the source text between two consecutive entries of one list holds anything but spaces and tabs.
// The grammar takes an escaped space or tab (`\ `) as whitespace and gives it no node, though the shell
// passes it as a word: `sudo -p \  rm -rf ~` runs `rm -rf ~` with a one-space prompt, while the argv
// would read `sudo -p rm -rf ~`. Between two words the gap needs at least one blank, so an empty gap (the
// touching case) is refused here too; next to a redirect it may be empty (`echo hi>out`, `<in>out cmd`).
// Node indexes are positions in the JS string the tree was parsed from, so the gap is a plain slice of it.
const PLAIN_GAP = /^[ \t]+$/;
const REDIRECT_GAP = /^[ \t]*$/;

export function gapHidesWord(
  spans: readonly {
    readonly startIndex: number;
    readonly endIndex: number;
    readonly type: string;
  }[],
  source: string,
): boolean {
  for (let i = 1; i < spans.length; i++) {
    const prev = spans[i - 1];
    const next = spans[i];
    if (prev === undefined || next === undefined) continue;
    const besideRedirect = prev.type === REDIRECT_KIND || next.type === REDIRECT_KIND;
    const gap = source.slice(prev.endIndex, next.startIndex);
    if (!(besideRedirect ? REDIRECT_GAP : PLAIN_GAP).test(gap)) return true;
  }
  return false;
}

// Whether two words of one argument list touch, or any spacing list holds a gap with anything but spaces
// and tabs: either way the floor would read other words than the shell runs, so the command is refused.
// `source` is the text the tree was parsed from.
export function hasHiddenWords(root: SyntaxNode, source: string): boolean {
  return (
    argumentLists(root).some(touchingWords) ||
    spacingLists(root).some((list) => gapHidesWord(list, source))
  );
}

// The nodes the collector failed to account for: an argument-position node owned by no root or by
// more than one, and any owned node that is not in argument position at all. Empty means every word
// of the command belongs to exactly one root.
export function unaccountedNodes(root: SyntaxNode, owned: readonly SyntaxNode[]): SyntaxNode[] {
  const counts = new Map<number, number>();
  for (const node of owned) counts.set(node.id, (counts.get(node.id) ?? 0) + 1);
  const expected = argumentNodes(root);
  const expectedIds = new Set(expected.map((node) => node.id));
  return [
    ...expected.filter((node) => counts.get(node.id) !== 1),
    ...owned.filter((node) => !expectedIds.has(node.id)),
  ];
}
