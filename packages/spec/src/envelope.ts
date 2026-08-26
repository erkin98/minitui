import type { ValidationIssue } from '@minitui/catalog';
import { formatStructuralIssues, type SpecIssue } from './structural.js';
import type { SemanticIssue } from './semantic/semantic-types.js';
import { REPAIR_HEADER, formatCatalogIssues, formatSemanticIssues } from './prompt-fragments.js';

/**
 * A2UI VALIDATION_FAILED envelope carried back to the agent on a failed attempt.
 * (A2UI's canonical per-error field is `path` — a JSON pointer; the issue shapes
 * here carry `pointer`/`elementKey` instead. Internal-only divergence: mirror
 * `path` only if A2UI-tool interop is ever needed.)
 */
export interface ValidationEnvelope {
  readonly code: 'VALIDATION_FAILED';
  /**
   * 1-based pass number that produced this failure, in the range 1..MAX_RETRIES+1
   * (the initial generation is pass 1; each regeneration adds one). The give-up
   * envelope therefore reports `MAX_RETRIES + 1` (6), NOT a retry count of 6 — the
   * field counts total passes, not retries, so it never disagrees with its value.
   */
  readonly attempt: number;
  readonly structural: readonly SpecIssue[];
  /** Catalog-gate failures (off-catalog names / bad props) from runFullValidation. */
  readonly catalog: readonly ValidationIssue[];
  readonly semantic: readonly SemanticIssue[];
}

export function buildValidationEnvelope(args: {
  attempt: number;
  structural: readonly SpecIssue[];
  semantic: readonly SemanticIssue[];
  catalog?: readonly ValidationIssue[];
}): ValidationEnvelope {
  return {
    code: 'VALIDATION_FAILED',
    attempt: args.attempt,
    structural: args.structural,
    catalog: args.catalog ?? [],
    semantic: args.semantic,
  };
}

/** Render the envelope into the reprompt text the agent regenerates against. */
export function toRepromptText(env: ValidationEnvelope): string {
  const parts = [REPAIR_HEADER];
  const structuralText = formatStructuralIssues([...env.structural]);
  if (structuralText) parts.push(structuralText);
  const catalogText = formatCatalogIssues(env.catalog);
  if (catalogText) parts.push(catalogText);
  const semanticText = formatSemanticIssues(env.semantic);
  if (semanticText) parts.push(semanticText);
  return parts.join('\n\n');
}
