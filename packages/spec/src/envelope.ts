import { sanitize, type ValidationIssue } from '@minitui/catalog';
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

// ---- the wire schema's issues as repair lines ----

// A schema issue as the installed zod shapes it: a code, a path, and for a union the issues of each
// branch (their paths are relative to the union) or for unknown keys the keys.
interface SchemaIssue {
  readonly code: string;
  readonly path: readonly PropertyKey[];
  readonly keys?: readonly string[];
  readonly errors?: readonly (readonly SchemaIssue[])[];
}

const MAX_ISSUE_LINES = 8;
const MAX_PATH_SEGMENTS = 12;
const MAX_SHOWN = 64;

// Model-authored text: stripped of terminal escapes and cut, counting the cut marker.
function shown(text: string): string {
  const clean = sanitize(text);
  const chars = [...clean];
  return chars.length > MAX_SHOWN ? `${chars.slice(0, MAX_SHOWN - 1).join('')}…` : clean;
}

function linesOf(issue: SchemaIssue, base: readonly PropertyKey[]): string[] {
  const path = [...base, ...issue.path];
  if (issue.code === 'invalid_union' && issue.errors) {
    // a union is described through the first branch that read the outer shape and failed deeper; when no
    // branch did, through the first branch that carries an issue
    const wrongOuterShape = (b: readonly SchemaIssue[]): boolean =>
      b.every((i) => i.code === 'invalid_type' && i.path.length === 0);
    const branch =
      issue.errors.find((b) => b.length > 0 && !wrongOuterShape(b)) ??
      issue.errors.find((b) => b.length > 0);
    if (branch) return branch.flatMap((inner) => linesOf(inner, path));
  }
  const where =
    path.length === 0
      ? 'spec'
      : path
          .slice(0, MAX_PATH_SEGMENTS)
          .map((s) => shown(String(s)))
          .join('/');
  if (issue.code === 'unrecognized_keys' && issue.keys && issue.keys.length > 0) {
    return [`${where}: unexpected key ${issue.keys.map((k) => `"${shown(k)}"`).join(', ')}`];
  }
  return [`${where}: wrong shape for this field`];
}

/**
 * Render the wire schema's issues as structural repair lines: one per failing path, at most 8. No text
 * of the schema library's error is copied into a reprompt — "Invalid input" at a union path is
 * something the model cannot act on — and every path segment and key is model-authored, so it is
 * stripped of escapes and cut. Each line becomes a structural issue with the code `empty_spec`.
 */
export function formatSchemaIssues(issues: readonly SchemaIssue[]): SpecIssue[] {
  const lines = [...new Set(issues.flatMap((i) => linesOf(i, [])))].slice(0, MAX_ISSUE_LINES);
  return lines.map((message) => ({ severity: 'error', code: 'empty_spec', message }));
}
