import type { SemanticIssue } from './semantic/semantic-types.js';

export const REPAIR_HEADER =
  'The generated UI spec is invalid. Fix every error below and re-emit the spec.';

export const SEMANTIC_HEADER = 'The spec is structurally valid but semantically wrong:';

export const CATALOG_HEADER = 'The spec references names or props outside the trusted catalog:';

/** Render semantic issues as a bullet list for a repair prompt (catalog-agnostic). */
export function formatSemanticIssues(issues: readonly SemanticIssue[]): string {
  if (issues.length === 0) return '';
  const lines = [SEMANTIC_HEADER];
  for (const issue of issues) lines.push(`- ${issue.message}`);
  return lines.join('\n');
}

/**
 * Render catalog-gate issues as a bullet list. Structurally typed on `message`
 * so this file never imports @minitui/catalog and stays catalog-agnostic.
 */
export function formatCatalogIssues(issues: readonly { readonly message: string }[]): string {
  if (issues.length === 0) return '';
  const lines = [CATALOG_HEADER];
  for (const issue of issues) lines.push(`- ${issue.message}`);
  return lines.join('\n');
}
