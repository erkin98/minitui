import { isWiderThan, type MinituiCatalog, type VisibilityClass } from '@minitui/catalog';
import { bindingsOf } from './walk-bindings.js';
import type { Spec } from '../spec-types.js';
import type { SemanticIssue } from './semantic-types.js';

/** Read an agent-supplied visibility/callableFrom the wire type does not model. */
function requestedClass(
  bag: unknown,
  key: 'visibility' | 'callableFrom',
): VisibilityClass | undefined {
  if (typeof bag !== 'object' || bag === null) return undefined;
  const v = (bag as Record<string, unknown>)[key];
  return v === 'localOnly' || v === 'clientOnly' || v === 'remoteOnly' ? v : undefined;
}

/**
 * Reject an agent attempt to WIDEN a builder-declared visibility class.
 * Visibility (`element.visibility`) and
 * callableFrom (on an `on`/`watch` binding) are BUILDER-owned catalog metadata;
 * the wire `SpecElement`/`ActionBinding` do not model them, so an agent-supplied
 * value is a smuggled excess field the strict-props check never sees (it checks
 * `props`, not the element envelope) and json-render's validator has no action
 * grammar to strip it — this is the ONLY gate that catches it. The smuggled field
 * survives json-render's autoFix (relocation/prune of KNOWN fields only). A class
 * strictly WIDER (more exposed to the model) than the catalog's is a privilege
 * escalation → reject. Narrower/equal is harmless — the agent may only tighten;
 * the runtime ceiling is always the catalog's class.
 */
export function checkVisibility(spec: Spec, catalog: MinituiCatalog): readonly SemanticIssue[] {
  const issues: SemanticIssue[] = [];
  for (const [key, element] of Object.entries(spec.elements)) {
    const want = requestedClass(element, 'visibility');
    const declared = catalog.visibilityOf(element.type);
    if (want !== undefined && declared !== undefined && isWiderThan(want, declared)) {
      issues.push({
        severity: 'error',
        code: 'visibility_widened',
        message: `Element "${key}" (${element.type}) requests visibility "${want}", wider than the catalog's "${declared}". Visibility is builder-owned — remove it.`,
        elementKey: key,
      });
    }
    for (const binding of bindingsOf(element)) {
      const action = binding.action;
      if (typeof action !== 'string') continue;
      const wantAct = requestedClass(binding, 'callableFrom');
      const declaredAct = catalog.callableFromOf(action);
      if (wantAct !== undefined && declaredAct !== undefined && isWiderThan(wantAct, declaredAct)) {
        issues.push({
          severity: 'error',
          code: 'visibility_widened',
          message: `Action "${action}" bound on element "${key}" requests callableFrom "${wantAct}", wider than the catalog's "${declaredAct}". Remove it.`,
          elementKey: key,
        });
      }
    }
  }
  return issues;
}
