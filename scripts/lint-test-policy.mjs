/* global console, process */
import { ESLint } from 'eslint';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative, resolve } from 'node:path';
import { createVitest } from 'vitest/node';
import { CAST_DIRECTIVE_ALLOWLIST, TEST_FILE_GLOBS } from '../config/eslint-policy.js';

const root = resolve(import.meta.dirname, '..');

// errorOnUnmatchedPattern:false is load-bearing for the control below: it lets a
// glob that matches nothing return an empty result set instead of throwing ESLint's
// own error, so the control proves OUR guard fired rather than ESLint's.
const eslint = new ESLint({ cwd: root, errorOnUnmatchedPattern: false });

const ZERO_MATCH = 'lint:test-policy matched zero files';

async function lintOrDie(patterns) {
  const results = await eslint.lintFiles(patterns);
  const files = new Set(results.map((result) => result.filePath));
  if (files.size === 0) throw new Error(ZERO_MATCH);
  return { results, files };
}

// Positive control: the zero-match guard must fire on a glob that matches nothing.
// Without it, a glob that silently stopped matching would report OK over an empty
// set — a green gate that linted no policy at all.
// The message is matched, not merely the throw: any other failure on the control
// glob would otherwise be read as the guard firing.
let guardFired = false;
try {
  await lintOrDie(['**/__lint-test-policy-control__/**/*.ts']);
} catch (error) {
  guardFired = error instanceof Error && error.message === ZERO_MATCH;
}
if (!guardFired) throw new Error('lint:test-policy zero-file guard did not fire');

const { results, files: lintedFiles } = await lintOrDie(TEST_FILE_GLOBS);

const formatter = await eslint.loadFormatter('stylish');
const output = await formatter.format(results);
if (output.length > 0) console.error(output);

let failed = results.reduce((total, result) => total + result.errorCount, 0) > 0;

// The allowlisted cast rows: one reasoned directive per row, counted per file.
const CAST_DIRECTIVE = /eslint-disable(?:-next-line|-line)?[^\n]*\bno-restricted-syntax\b/g;
const countCastDirectives = (text) => text.match(CAST_DIRECTIVE)?.length ?? 0;
// Positive control: a planted directive counts as one and a clean line as none.
if (
  countCastDirectives('// eslint-disable-next-line no-restricted-syntax -- x\nconst a = 1;\n') !==
    1 ||
  countCastDirectives('const a = 1;\n') !== 0
) {
  throw new Error('lint:test-policy cast-directive count is vacuous');
}
const castCounts = new Map();
for (const file of lintedFiles) {
  const count = countCastDirectives(readFileSync(file, 'utf8'));
  if (count > 0) castCounts.set(relative(root, file).replaceAll('\\', '/'), count);
}
const castFiles = new Set([...castCounts.keys(), ...Object.keys(CAST_DIRECTIVE_ALLOWLIST)]);
for (const file of castFiles) {
  const want = CAST_DIRECTIVE_ALLOWLIST[file] ?? 0;
  const got = castCounts.get(file) ?? 0;
  if (want !== got) {
    console.error(
      `lint:test-policy: ${file} holds ${got} cast directives, the allowlist says ${want}`,
    );
    failed = true;
  }
}

// A delegating global wrapper that restores in finally is instrumentation, not a
// replacement double, so it is permitted.
// Reachability guard for the replacement-API ban. Vitest can hand a test its replacement API without an
// import in two ways: `globals: true` makes `vi` an ambient global, and `includeSource` lets a source
// file reach the Vitest object through `import.meta.vitest`. The lint rule reports the import-free
// spellings it can see in a file, but a configuration can switch either on without any file naming
// them, so the CONFIGURATION is checked, and from Vitest itself: every project's resolved settings,
// never config text (a text match is dodged by `!0`, a shorthand, a spread, a quoted key and a computed
// key; the resolved value is not).
async function resolveProjects(options) {
  // `run: false` starts nothing and writes no cache; the runner loader keeps Vite from writing a
  // temporary copy of the config under node_modules.
  const vitest = await createVitest('test', {
    watch: false,
    run: false,
    configLoader: 'runner',
    ...options,
  });
  try {
    return vitest.projects.map((project) => ({
      name: project.name,
      globals: project.config.globals === true,
      // Vitest sets no default for this key on a test project: absent means off.
      includeSource: project.config.includeSource?.length ?? 0,
    }));
  } finally {
    await vitest.close();
  }
}

// Positive control: every spelling that a text match cannot see must still resolve to `globals: true`,
// and a configured `includeSource` list must still resolve to a non-empty list (a misread key would
// otherwise read as "off" for every project). Each control config imports nothing (a temporary
// directory has no node_modules) and includes only a name no test file has. A unique directory per run
// keeps two parallel runs apart.
const NONE = "include: ['*.none.test.ts']";
const RESOLVES = {
  globals: (project) => project?.globals === true,
  includeSource: (project) => (project?.includeSource ?? 0) > 0,
};
const CONTROL_CONFIGS = [
  ['`!0`', `export default { test: { ${NONE}, globals: !0 } };`, 'globals'],
  ['shorthand', `const globals = true;\nexport default { test: { ${NONE}, globals } };`, 'globals'],
  [
    'spread',
    `const on = { globals: true };\nexport default { test: { ${NONE}, ...on } };`,
    'globals',
  ],
  ['quoted key', `export default { test: { ${NONE}, 'globals': true } };`, 'globals'],
  ['computed key', `export default { test: { ${NONE}, ['glo' + 'bals']: true } };`, 'globals'],
  [
    'includeSource list',
    `export default { test: { ${NONE}, includeSource: ['src/**/*.ts'] } };`,
    'includeSource',
  ],
];
const controlRoot = mkdtempSync(join(tmpdir(), 'lint-test-policy-'));
const unseenSpellings = [];
try {
  for (const [index, [spelling, text, setting]] of CONTROL_CONFIGS.entries()) {
    const config = join(controlRoot, `control-${index}.config.mjs`);
    writeFileSync(config, `${text}\n`);
    const [project] = await resolveProjects({ root: controlRoot, config });
    if (!RESOLVES[setting](project)) unseenSpellings.push(spelling);
  }
} finally {
  rmSync(controlRoot, { recursive: true, force: true });
}
if (unseenSpellings.length > 0) {
  throw new Error(
    `lint:test-policy config guard is vacuous: ${unseenSpellings.join(', ')} did not resolve to the setting it spells`,
  );
}

const projects = await resolveProjects({ root });
// Zero-project floor mirroring the lint-half guard: if the project globs ever stop resolving, the
// check would cover nothing and pass vacuously.
if (projects.length === 0) throw new Error(ZERO_MATCH);
// Floor: one project per package config, plus the root and release-scripts projects. A project glob that
// quietly stopped matching would otherwise leave the guard checking a shorter list.
const packageConfigs = readdirSync(join(root, 'packages'), { withFileTypes: true }).filter(
  (entry) =>
    entry.isDirectory() && existsSync(join(root, 'packages', entry.name, 'vitest.config.ts')),
).length;
const floor = packageConfigs + 2;
if (projects.length < floor) {
  throw new Error(
    `lint:test-policy resolved ${projects.length} vitest projects, at least ${floor} expected (one per packages/*/vitest.config.ts plus root and release-scripts): a project went missing`,
  );
}
const offenders = projects.filter((project) => project.globals || project.includeSource > 0);
if (offenders.length > 0) {
  const named = offenders
    .map((project) => {
      const settings = [project.globals && 'globals', project.includeSource > 0 && 'includeSource'];
      return `${project.name || '(unnamed)'} (${settings.filter(Boolean).join(' + ')})`;
    })
    .join(', ');
  console.error(
    `lint:test-policy: a vitest project resolves 'globals: true' or an 'includeSource' list, which reaches the replacement API without an import and bypasses no-vitest-replacement-api — remove it from ${named}`,
  );
  failed = true;
}

if (failed) process.exitCode = 1;
else
  console.log(
    `lint:test-policy: ${lintedFiles.size} test files OK, ${projects.length} vitest projects resolved with globals off and no includeSource`,
  );
