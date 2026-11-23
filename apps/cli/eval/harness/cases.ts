import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { z } from 'zod';
import { videoMergeCatalog } from '@minitui/catalog';
import { CATALOG_CHECKERS } from '../graders/index.js';
import type { CapabilityCause } from './row.js';
import type { StopKind } from './trial.js';

/** What a reference writes for the trial's case directory; the loader replaces it. */
export const CASE_DIR = '@@CASE_DIR@@';

export interface MergeExpectation {
  readonly inputs: readonly string[]; // file names, resolved against the case directory
  readonly ordered: boolean; // true: the order of the names is the order asked for
  readonly output: string | null; // a file name; null when any absolute path in the case directory will do
  readonly codecs: readonly string[]; // acceptable codec values; empty when the case gives no codec cue, so any passes
  readonly editableInputs: boolean; // the inputs are bound two-way to a picker or a reorderable list
}

export interface DescribedElement {
  readonly type: string; // a component name of the case's catalog
  readonly label: string | null; // a case-insensitive part of its label
  readonly options: readonly string[]; // values a Select must offer; empty when none were described
  readonly bound: boolean; // its value or items are bound to state
  readonly pressAction: string | null; // the action its press runs
  readonly showsState: boolean; // its displayed text reads state: a state or item marker, a template with a ${...} hole, or a $cond whose chosen branch does; never a fixed string
}

export interface GenerationCase {
  readonly id: string; // ^[a-z0-9-]+$, unique in the set
  readonly version: number; // bumped on any edit
  readonly suite: 'regression' | 'capability';
  readonly split: 'dev' | 'test';
  readonly catalog: string; // must equal the catalog the cli is built with
  readonly input: { readonly kind: 'intent' | 'description'; readonly text: string };
  readonly files: readonly string[]; // created empty in the case directory before each trial
  readonly tags: readonly string[]; // dimension values
  readonly requires: {
    readonly components: readonly string[];
    readonly actions: readonly string[];
  };
  readonly needsModelWrittenCode: boolean;
  readonly expect: {
    readonly merge: MergeExpectation | null;
    readonly described: readonly DescribedElement[];
    readonly forbidActions: readonly string[];
  };
  readonly reference: string | null; // file under cases/references/: a spec that passes every check, paths under CASE_DIR
  /** Required when reference is null: the reply file the dry runs replay on every request, and what they must reach. */
  readonly dryRun: {
    readonly reply: string;
    readonly stop: StopKind;
    readonly cause: CapabilityCause | null;
  } | null;
}

export interface CaseSet {
  readonly status: 'draft' | 'approved';
  readonly caseSetVersion: number;
  /** In file order: a case's 1-based position here names its directory. */
  readonly cases: readonly GenerationCase[];
  /** The text of every reference and reply file the cases name, keyed by file name, as checked. */
  readonly patches: ReadonlyMap<string, string>;
}

export interface LoadContext {
  /** The system prompt the trials send: no case text may appear in it. */
  readonly systemPrompt: string;
  readonly readReference: (file: string) => string;
}

// A file name only: no separator, no `..`, no control character.
const isPlainName = (name: string): boolean =>
  name !== '' && name !== '.' && !/[/\\]|\.\.|\p{Cc}/u.test(name);
const fileName = z
  .string()
  .refine(isPlainName, 'a file name must hold no separator, .. or control');
const named = z.string().min(1);

const STOPS = [
  'valid',
  'exhausted',
  'turn-deadline',
  'provider-error',
  'spend-cap',
  'timeout',
  'harness-error',
] as const satisfies readonly StopKind[];
const CAUSES = [
  'pass',
  'missing-component',
  'missing-action',
  'needs-model-written-code',
  'model-error',
] as const satisfies readonly CapabilityCause[];

const CaseSchema = z
  .object({
    id: z.string().regex(/^[a-z0-9-]+$/, 'an id is lower-case letters, digits and dashes'),
    version: z.number().int().positive(),
    suite: z.enum(['regression', 'capability']),
    split: z.enum(['dev', 'test']),
    catalog: named,
    input: z.object({ kind: z.enum(['intent', 'description']), text: named }).strict(),
    files: z
      .array(fileName)
      .refine((names) => new Set(names).size === names.length, 'a file name is listed twice'),
    tags: z.array(named),
    requires: z.object({ components: z.array(named), actions: z.array(named) }).strict(),
    needsModelWrittenCode: z.boolean(),
    expect: z
      .object({
        merge: z
          .object({
            inputs: z.array(fileName).min(2),
            ordered: z.boolean(),
            output: fileName.nullable(),
            codecs: z.array(named),
            editableInputs: z.boolean(),
          })
          .strict()
          .nullable(),
        described: z.array(
          z
            .object({
              type: named,
              label: named.nullable(),
              options: z.array(named),
              bound: z.boolean(),
              pressAction: named.nullable(),
              showsState: z.boolean(),
            })
            .strict(),
        ),
        forbidActions: z.array(named),
      })
      .strict(),
    reference: fileName.nullable(),
    dryRun: z
      .object({ reply: fileName, stop: z.enum(STOPS), cause: z.enum(CAUSES).nullable() })
      .strict()
      .nullable(),
  })
  .strict();

const HeaderSchema = z
  .object({ status: z.enum(['draft', 'approved']), caseSetVersion: z.number().int().positive() })
  .strict();

// The JSON pointer slots: a patch line's own path and from, a state marker's value, a repeat's statePath,
// and an action binding's statePath and clearStatePath. Every other string leaf is a value.
function isPointerSlot(key: string | undefined, parent: string | undefined): boolean {
  if (key === '$state' || key === '$bindState') return true;
  if (key === 'statePath') return parent === 'repeat' || parent === 'params';
  return key === 'clearStatePath' && parent === 'params';
}

function hasAbsoluteLeaf(value: unknown, key?: string, parent?: string): boolean {
  if (typeof value === 'string') return value.startsWith('/') && !isPointerSlot(key, parent);
  if (Array.isArray(value)) return value.some((item) => hasAbsoluteLeaf(item, '', key));
  if (typeof value !== 'object' || value === null) return false;
  return Object.entries(value).some(([k, v]) => hasAbsoluteLeaf(v, k, key));
}

function parseLines(text: string): readonly Record<string, unknown>[] {
  return text
    .split('\n')
    .filter((line) => line.trim() !== '')
    .map((line) => {
      const parsed: unknown = JSON.parse(line);
      if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
        throw new Error('a patch line is not a JSON object');
      }
      return Object.fromEntries(Object.entries(parsed));
    });
}

// A patch line's value starts at the place its path names, so the last two segments are its key context.
function lineHasAbsoluteLeaf(patchLine: Record<string, unknown>): boolean {
  const segments = typeof patchLine.path === 'string' ? patchLine.path.split('/') : [];
  return hasAbsoluteLeaf(patchLine.value, segments.at(-1), segments.at(-2));
}

function checkPatchText(text: string, file: string): void {
  let lines: readonly Record<string, unknown>[];
  try {
    lines = parseLines(text);
  } catch {
    throw new Error(`${file}: every line must be a JSON patch object`);
  }
  if (lines.some(lineHasAbsoluteLeaf)) {
    throw new Error(`${file}: holds an absolute path not written behind ${CASE_DIR}`);
  }
}

// Each check names the rule it enforces; a case that breaks one is refused with its position and id.
function checkCase(c: GenerationCase, ctx: LoadContext, patches: Map<string, string>): void {
  if (c.catalog !== videoMergeCatalog.id || CATALOG_CHECKERS[c.catalog] === undefined) {
    throw new Error(`names catalog ${c.catalog}, not the one the cli is built with`);
  }
  if (ctx.systemPrompt.includes(c.input.text))
    throw new Error('its text appears in the system prompt');
  const tokens = c.input.text.split(/\s+/).map((token) => token.replace(/^["'`([<]+/, ''));
  if (tokens.some((token) => token.startsWith('/'))) {
    throw new Error('its text holds an absolute path');
  }
  const merge = c.expect.merge;
  if (merge !== null && merge.inputs.some((input) => !c.files.includes(input))) {
    throw new Error('a merge input is not one of its files');
  }
  const components = videoMergeCatalog.componentNames;
  if (c.expect.described.some((entry) => !components.includes(entry.type))) {
    throw new Error('a described entry names no component of the catalog');
  }
  if (c.reference === null && c.dryRun === null) {
    throw new Error('has neither a reference nor a dry-run reply');
  }
  for (const file of [c.reference, c.dryRun?.reply]) {
    if (file === null || file === undefined || patches.has(file)) continue;
    const text = ctx.readReference(file);
    checkPatchText(text, file);
    patches.set(file, text);
  }
}

// What zod refused, in words that name the field: "described" for an empty described type, and so on.
const zodMessage = (error: z.ZodError): string =>
  error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`).join('; ');

interface FileLine {
  readonly text: string;
  readonly number: number; // 1-based in the file, blank lines counted
}

// A line as JSON, or a refusal naming `where` and the line's number: the text of the line is never quoted.
function jsonOf(line: FileLine, where: string): unknown {
  try {
    return JSON.parse(line.text);
  } catch {
    throw new Error(`${where}: line ${line.number} is not valid JSON`);
  }
}

/** The case set: its header line, then one case per line, each checked against every refusal rule. */
export function parseCaseSet(text: string, ctx: LoadContext): CaseSet {
  const [headerLine = { text: '', number: 1 }, ...caseLines] = text
    .split('\n')
    .map((line, index): FileLine => ({ text: line, number: index + 1 }))
    .filter((line) => line.text.trim() !== '');
  const header = HeaderSchema.safeParse(jsonOf(headerLine, 'the case set header'));
  if (!header.success) throw new Error(`the case set header: ${zodMessage(header.error)}`);
  const patches = new Map<string, string>();
  const ids = new Set<string>();
  const cases = caseLines.map((line, index): GenerationCase => {
    const parsed = CaseSchema.safeParse(jsonOf(line, `case ${index + 1}`));
    if (!parsed.success) throw new Error(`case ${index + 1}: ${zodMessage(parsed.error)}`);
    const c = parsed.data;
    try {
      if (ids.has(c.id)) throw new Error('duplicate id');
      ids.add(c.id);
      checkCase(c, ctx, patches);
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      throw new Error(`case ${index + 1} (${c.id}): ${reason}`);
    }
    return c;
  });
  return { status: header.data.status, caseSetVersion: header.data.caseSetVersion, cases, patches };
}

/** Reads the case file and the reference and reply files beside it, under `references/`. */
export function loadCaseSet(file: string, ctx: Pick<LoadContext, 'systemPrompt'>): CaseSet {
  const references = join(dirname(file), 'references');
  return parseCaseSet(readFileSync(file, 'utf8'), {
    systemPrompt: ctx.systemPrompt,
    readReference: (name) => readFileSync(join(references, name), 'utf8'),
  });
}

/**
 * A reference or reply for one trial: the case directory written as the content of a JSON string wherever
 * the placeholder stands, so no character of its name can break a line. The replacement is a function, so
 * a `$&` or a `$'` in the directory is written as it is, never read as a pattern. The runner and the tests
 * render through this one function.
 */
export function renderPatchText(text: string, caseDirectory: string): string {
  return text.replaceAll(CASE_DIR, () => JSON.stringify(caseDirectory).slice(1, -1));
}
