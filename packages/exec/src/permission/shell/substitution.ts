import type { SyntaxNode } from './parser.js';

const SUBSTITUTION_TYPES = new Set(['command_substitution', 'process_substitution']);

// Walk the whole AST: any substitution node anywhere means the resolved command is unknowable at
// parse time, so the engine hard-DENIES it (mirroring parseError) — never ask, never allow.
// A human `ask` would rubber-stamp an effect the host has admitted it cannot resolve.
export function hasSubstitution(node: SyntaxNode): boolean {
  if (SUBSTITUTION_TYPES.has(node.type)) return true;
  for (const child of node.namedChildren) {
    if (child && hasSubstitution(child)) return true;
  }
  return false;
}
