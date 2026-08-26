import { resolveBindings } from './resolve-bindings.js';
import { checkCapabilities } from './check-capabilities.js';
import { checkFiles } from './check-files.js';
import type { Spec } from '../spec-types.js';
import type { CapabilityProvider } from '../capability-port.js';
import type { SemanticIssue, SemanticResult } from './semantic-types.js';

/**
 * Run the three semantic checks. Binding resolution is sync; capability + file
 * checks are async ONLY through the injected port. Issues are concatenated in a
 * stable order (bindings, capabilities, files).
 */
export async function validateSemantics(
  spec: Spec,
  caps: CapabilityProvider,
): Promise<SemanticResult> {
  const [capIssues, fileIssues] = await Promise.all([
    checkCapabilities(spec, caps),
    checkFiles(spec, caps),
  ]);
  const issues: readonly SemanticIssue[] = [...resolveBindings(spec), ...capIssues, ...fileIssues];
  return { valid: issues.length === 0, issues };
}
