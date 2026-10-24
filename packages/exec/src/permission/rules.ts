import type { PermissionRule } from '@minitui/types';
import { matchPattern } from './shell/match.js';

export interface RuleSet {
  readonly rules: readonly PermissionRule[];
}

type Effect = 'allow' | 'ask' | 'deny';

// Higher number wins. managed-deny is forced to the top so it is final.
const LAYER_RANK: Record<PermissionRule['layer'], number> = { managed: 3, project: 2, user: 1 };
const EFFECT_RANK: Record<Effect, number> = { deny: 2, ask: 1, allow: 0 };

// A cascade grant and a persisted cascade row name one command: no whitespace and no `*`, so a stored
// pattern can never act as a wildcard or a multi-word prefix.
export const isBareCommandName = (name: string): boolean => /^[^\s*]+$/.test(name);

// A deny written as several words matches a command whose non-option tokens hold those words in
// order, so an option placed between them does not hide the deny: `deny "git push"` matches
// `git --no-pager push origin`. There is no arity table, so an operand equal to one of the words
// matches too (`git commit -m push`): a recorded over-deny, the safe direction. A pattern that names
// an option is left to the contiguous match.
function wordsInOrder(pattern: string, value: string): boolean {
  const want = pattern.trim().split(/\s+/);
  if (want.length < 2 || want.some((word) => word.startsWith('-'))) return false;
  let found = 0;
  for (const token of value.trim().split(/\s+/)) {
    if (token.startsWith('-')) continue;
    const next = want[found];
    if (next !== undefined && matchPattern(next, token)) found += 1;
  }
  return found === want.length;
}

// The winning RULE for a value — layer precedence with managed-deny absolute. This is the single
// precedence implementation; effectFor (below) and decision.ts's denyRuleFor both project
// off it, so the engine's deny reason can never disagree with the effect resolveStatic saw.
export function matchedRule(set: RuleSet, value: string): PermissionRule | undefined {
  // an exact rule covers one command string and is read by exactRuleFor, never by this prefix matcher
  const matched = set.rules.filter(
    (r) =>
      r.exact !== true &&
      (matchPattern(r.pattern, value) || (r.effect === 'deny' && wordsInOrder(r.pattern, value))),
  );
  if (matched.length === 0) return undefined;

  // managed-deny is absolute
  const managedDeny = matched.find((r) => r.layer === 'managed' && r.effect === 'deny');
  if (managedDeny) return managedDeny;

  // otherwise rank by layer first, then by effect severity within the layer
  let best: PermissionRule | undefined;
  let bestKey = -1;
  for (const r of matched) {
    const key = LAYER_RANK[r.layer] * 10 + EFFECT_RANK[r.effect];
    if (key > bestKey) {
      bestKey = key;
      best = r;
    }
  }
  return best;
}

export function effectFor(set: RuleSet, value: string): Effect | undefined {
  return matchedRule(set, value)?.effect;
}

// The exact rule for a command, if any: its pattern equals the whole command string character for
// character. A star in the pattern is a literal character here, not a wildcard.
export function exactRuleFor(set: RuleSet, raw: string): PermissionRule | undefined {
  return set.rules.find((r) => r.exact === true && r.pattern === raw);
}

// The one definition of "the same grant": every field that decides what a rule covers is equal. Identity
// and exact are part of it: two grants for one basename bound to distinct realpaths are DISTINCT grants,
// and an exact grant is distinct from a cascade grant with the same text. The engine de-dupes live grants
// with it and the grants file de-dupes saved ones with it.
export const sameGrant = (a: PermissionRule, b: PermissionRule): boolean =>
  a.pattern === b.pattern &&
  a.effect === b.effect &&
  a.layer === b.layer &&
  a.identity === b.identity &&
  a.exact === b.exact;
