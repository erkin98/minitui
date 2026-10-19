import type { SyntaxNode } from './parser.js';

const REDIRECT_KIND = 'file_redirect';

const isSubstitution = (node: SyntaxNode): boolean =>
  node.type === 'command_substitution' || node.type === 'process_substitution';

const namedChildrenOf = (node: SyntaxNode): SyntaxNode[] =>
  node.namedChildren.filter((child): child is SyntaxNode => child !== null);

// Every node that stands in argument position: each named non-redirect child of a command (its name,
// its arguments and its leading assignments), each destination of a file redirect, and each
// assignment that stands alone. The walk is independent of the root collector, so a collector that
// drops a node is caught by comparing against this list. It does not descend into a substitution:
// the substitution deny gates those bodies, they are never roots.
export function argumentNodes(root: SyntaxNode): SyntaxNode[] {
  const found: SyntaxNode[] = [];
  const visit = (node: SyntaxNode, parentType: string): void => {
    if (isSubstitution(node)) return;
    if (node.type === 'command') {
      found.push(...namedChildrenOf(node).filter((child) => child.type !== REDIRECT_KIND));
    } else if (node.type === REDIRECT_KIND) {
      found.push(
        ...node.childrenForFieldName('destination').filter((c): c is SyntaxNode => c !== null),
      );
    } else if (node.type === 'variable_assignment' && parentType !== 'command') {
      found.push(node);
    }
    for (const child of namedChildrenOf(node)) visit(child, node.type);
  };
  visit(root, '');
  return found;
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
