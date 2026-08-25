import type { JsonValue } from '@minitui/types';
import type { AppSpec } from '../contract/spec.js';
import type { MinituiCatalog } from '../define-catalog.js';
import { rejectOffCatalog, type AllowlistIssue } from '../allowlist.js';
import { checkSemantics, type SemanticIssue } from './semantic.js';

export type ValidationIssue = AllowlistIssue | SemanticIssue;

export type ValidationResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly issues: readonly ValidationIssue[] };

/**
 * The catalog-aware validation entry @minitui/spec's composeValidation calls
 * between the adopted structural autoFix and the reprompt: allowlist first
 * (name-on-catalog), then semantic (props/binding/danger). Short-circuits on
 * allowlist issues — semantic-checking an off-catalog element is meaningless.
 * `state` is the bound state document (MiniAppSpec.state; the wire AppSpec is
 * state-free) — composeValidation passes candidate.state.
 */
export function runFullValidation(
  spec: AppSpec,
  catalog: MinituiCatalog,
  state: JsonValue,
): ValidationResult {
  const allowlistIssues = rejectOffCatalog(spec, catalog);
  if (allowlistIssues.length > 0) return { ok: false, issues: allowlistIssues };

  const semanticIssues = checkSemantics(spec, catalog, state);
  if (semanticIssues.length > 0) return { ok: false, issues: semanticIssues };

  return { ok: true };
}
