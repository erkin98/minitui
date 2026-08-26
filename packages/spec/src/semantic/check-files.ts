import { getByPath } from '../pointer.js';
import type { Spec, UIElement } from '../spec-types.js';
import type { CapabilityProvider } from '../capability-port.js';
import type { SemanticIssue } from './semantic-types.js';

/** Resolve a FilePicker's bound value to a flat list of candidate paths. */
function pickedPaths(element: UIElement, state: Record<string, unknown>): string[] {
  const raw = (element.props as Record<string, unknown> | undefined)?.value;
  let value: unknown = raw;
  if (typeof raw === 'object' && raw !== null && '$state' in raw) {
    value = getByPath(state, (raw as { $state: string }).$state);
  } else if (typeof raw === 'object' && raw !== null && '$bindState' in raw) {
    // The frozen catalog binds FilePicker.value two-way via $bindState;
    // resolve it exactly like $state or this moat never stats a real picked path.
    value = getByPath(state, (raw as { $bindState: string }).$bindState);
  }
  if (typeof value === 'string') return [value];
  if (Array.isArray(value)) return value.filter((v): v is string => typeof v === 'string');
  return [];
}

/** File-picker paths must resolve to a real, readable file via the live port. */
export async function checkFiles(
  spec: Spec,
  caps: CapabilityProvider,
): Promise<readonly SemanticIssue[]> {
  const state = spec.state ?? {};
  const issues: SemanticIssue[] = [];
  for (const [key, element] of Object.entries(spec.elements)) {
    if (element.type !== 'FilePicker') continue;
    for (const path of pickedPaths(element, state)) {
      const stat = await caps.statFile(path);
      if (!stat.exists) {
        issues.push({
          severity: 'error',
          code: 'missing_file',
          message: `File "${path}" selected on element "${key}" does not exist.`,
          elementKey: key,
        });
      } else if (!stat.readable) {
        issues.push({
          severity: 'error',
          code: 'unreadable_file',
          message: `File "${path}" selected on element "${key}" is not readable.`,
          elementKey: key,
        });
      }
    }
  }
  return issues;
}
