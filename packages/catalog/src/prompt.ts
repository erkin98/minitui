import type { MinituiCatalog } from './define-catalog.js';

/**
 * The system-prompt catalog section: ADOPT json-render's catalog.prompt() (which
 * already teaches the components + the patch-line grammar), then append the
 * minitui-only action-kind/permission hints json-render is unaware of.
 */
export function buildCatalogPrompt(
  catalog: MinituiCatalog,
  opts?: { readonly customRules?: readonly string[] },
): string {
  const base = catalog.base.prompt({
    mode: 'inline',
    customRules: [...(opts?.customRules ?? [])],
  });

  const dangerLines: string[] = [];
  const localLines: string[] = [];
  for (const [name, def] of catalog.actionDefs) {
    if (def.kind === 'render-local') {
      localLines.push(`- ${name}: render-local (mutates local state only, no permission gate).`);
    } else {
      const danger = def.permission?.danger === true ? 'DANGEROUS' : 'safe';
      const summary = def.permission?.summaryTemplate ?? def.description;
      dangerLines.push(`- ${name} (${def.kind}, ${danger}): ${summary}`);
    }
  }

  return [
    base,
    '',
    '## Action Safety',
    'Every non-render-local action runs behind a host permission gate that shows the user the RESOLVED command before running it. DANGEROUS actions require explicit approval.',
    ...dangerLines,
    '',
    'Render-local actions mutate only the local state model and are limited to setState/pushState/removeState:',
    ...localLines,
  ].join('\n');
}
