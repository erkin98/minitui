import { posix } from 'node:path';

// This is a LEXICAL, advisory path gate — an allow-matched path can still be a symlink/hardlink
// resolving outside the allowed root, which no string match detects.
// The OS sandbox (the sandbox slice, invariant (d)) is the real containment; minitui additionally keeps the
// stronger stance that file targets are HOST-resolved from spec pointer-holes, never agent-named
// raw absolute paths. Defense-in-depth, not sufficient on its own.
export interface PathRule {
  readonly glob: string;
  readonly effect: 'allow' | 'ask' | 'deny';
}

function globToRegExp(glob: string): RegExp {
  // ** => any depth (including separators); * => one path segment (no separator)
  let out = '';
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i]!;
    if (c === '*' && glob[i + 1] === '*') {
      out += '.*';
      i++;
      continue;
    }
    if (c === '*') {
      out += '[^/]*';
      continue;
    }
    out += c.replace(/[.+?^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp(`^${out}$`);
}

export function checkPathRules(path: string, rules: readonly PathRule[]): 'allow' | 'ask' | 'deny' {
  // collapse `..`/`//` before matching so a traversal can't ride an allow glob or evade a deny glob
  const normalized = posix.normalize(path);
  let effect: 'allow' | 'ask' | 'deny' = 'ask';
  for (const rule of rules) {
    if (globToRegExp(rule.glob).test(normalized)) effect = rule.effect; // last match wins
  }
  return effect;
}
