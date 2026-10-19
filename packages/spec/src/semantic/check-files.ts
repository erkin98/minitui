import { getByPath } from '../pointer.js';
import type { Spec, UIElement } from '../spec-types.js';
import type { CapabilityProvider } from '../capability-port.js';
import type { SemanticIssue } from './semantic-types.js';

/** Resolve a FilePicker's bound value to a flat list of candidate paths. */
function pickedPaths(element: UIElement, state: Record<string, unknown>): string[] {
  const raw = (element.props as Record<string, unknown> | undefined)?.value;
  let value: unknown = raw;
  const marker =
    typeof raw === 'object' && raw !== null ? (raw as Record<string, unknown>) : undefined;
  // A marker whose pointer is not a string is not one the renderer follows: it follows nothing.
  // The frozen catalog binds FilePicker.value two-way via $bindState; resolve it exactly like $state
  // or this moat never stats a real picked path.
  const pointer = marker?.$state ?? marker?.$bindState;
  if (marker !== undefined && ('$state' in marker || '$bindState' in marker)) {
    value = typeof pointer === 'string' ? getByPath(state, pointer) : undefined;
  }
  // An empty string is an unpicked picker: nothing to probe.
  if (typeof value === 'string') return value === '' ? [] : [value];
  if (Array.isArray(value)) {
    return value.filter((v): v is string => typeof v === 'string' && v !== '');
  }
  return [];
}

/**
 * File-picker paths must exist and be readable via the live port. A path that is not a file is an issue
 * only for a picker in `file` mode; `dir` mode and an omitted mode accept any existing path. A path that
 * does not exist yet is `missing_file` in every mode.
 */
export async function checkFiles(
  spec: Spec,
  caps: CapabilityProvider,
): Promise<readonly SemanticIssue[]> {
  const state = spec.state ?? {};
  const issues: SemanticIssue[] = [];
  for (const [key, element] of Object.entries(spec.elements)) {
    if (element.type !== 'FilePicker') continue;
    const fileMode = (element.props as Record<string, unknown> | undefined)?.mode === 'file';
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
      } else if (!stat.isFile && fileMode) {
        issues.push({
          severity: 'error',
          code: 'not_a_file',
          message: `Path "${path}" selected on element "${key}" is a directory, not a file.`,
          elementKey: key,
        });
      }
    }
  }
  return issues;
}
