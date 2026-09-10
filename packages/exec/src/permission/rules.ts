import type { PermissionRule } from '@minitui/types';
import { matchPattern } from './shell/match.js';

export interface RuleSet {
  readonly rules: readonly PermissionRule[];
}

type Effect = 'allow' | 'ask' | 'deny';

// Higher number wins. managed-deny is forced to the top so it is final.
const LAYER_RANK: Record<PermissionRule['layer'], number> = { managed: 3, project: 2, user: 1 };
const EFFECT_RANK: Record<Effect, number> = { deny: 2, ask: 1, allow: 0 };

// The winning RULE for a value — layer precedence with managed-deny absolute. This is the single
// precedence implementation; effectFor (below) and decision.ts's denyRuleFor (Task 10) both project
// off it, so the engine's deny reason can never disagree with the effect resolveStatic saw.
export function matchedRule(set: RuleSet, value: string): PermissionRule | undefined {
  const matched = set.rules.filter((r) => matchPattern(r.pattern, value));
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
