import { z } from 'zod';
import { holePointersOf } from './contract/action-kind.js';
import type { MinituiCatalog } from './define-catalog.js';

const WATCHERS_MARKER = 'STATE WATCHERS:';
const RULES_MARKER = 'RULES:';

// The generator documents a `watch` field, with an example bound to an action no catalog has. The
// gate refuses `watch`, so the section is cut and one rule keeps the word in front of the model.
const WATCH_RULE =
  'The `watch` field is not supported. Bind actions to events under `on`, never under `watch`.';

// Cut the lines from the watcher heading up to, not including, the rules heading. When the
// generator stops printing either heading the cut cannot be trusted, so the build stops instead.
function dropWatcherSection(text: string): string {
  const lines = text.split('\n');
  const from = lines.indexOf(WATCHERS_MARKER);
  if (from < 0) {
    throw new Error(`Catalog prompt: the generated text has no "${WATCHERS_MARKER}" line to cut.`);
  }
  const to = lines.indexOf(RULES_MARKER, from + 1);
  if (to < 0) {
    throw new Error(`Catalog prompt: the generated text has no "${RULES_MARKER}" line after it.`);
  }
  return [...lines.slice(0, from), ...lines.slice(to)].join('\n');
}

const paramsLine = (schema: z.ZodType): string =>
  `  params: ${JSON.stringify(z.toJSONSchema(schema))}`;

/**
 * The system-prompt catalog section: ADOPT json-render's catalog.prompt() (which
 * already teaches the components + the patch-line grammar), then append the
 * minitui-only action-kind/permission hints json-render is unaware of.
 */
export function buildCatalogPrompt(
  catalog: MinituiCatalog,
  opts?: { readonly customRules?: readonly string[] },
): string {
  const base = dropWatcherSection(
    catalog.base.prompt({
      mode: 'standalone',
      customRules: [WATCH_RULE, ...(opts?.customRules ?? [])],
    }),
  );

  const dangerLines: string[] = [];
  const localLines: string[] = [];
  for (const [name, def] of catalog.actionDefs) {
    if (def.kind === 'render-local') {
      localLines.push(`- ${name}: render-local (mutates local state only, no permission gate).`);
      localLines.push(paramsLine(def.params));
    } else {
      const danger = def.permission?.danger === true ? 'DANGEROUS' : 'safe';
      const summary = def.permission?.summaryTemplate ?? def.description;
      dangerLines.push(`- ${name} (${def.kind}, ${danger}): ${summary}`);
      dangerLines.push(paramsLine(def.params));
      const pointers = [
        ...new Set([
          ...holePointersOf(def.permission?.resourceTemplate ?? ''),
          ...holePointersOf(def.permission?.summaryTemplate ?? ''),
        ]),
      ];
      if (pointers.length > 0) {
        dangerLines.push(`  needs a string in state at: ${pointers.join(', ')}`);
      }
      if (def.statusPointers !== undefined) {
        dangerLines.push(
          `  progress (a number from 0 to 1) and status (text) are written at: ${def.statusPointers.progress}, ${def.statusPointers.status}; seed both in state`,
        );
      }
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
