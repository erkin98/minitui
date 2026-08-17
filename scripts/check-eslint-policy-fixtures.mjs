/* global console, process */
import { ESLint } from 'eslint';
import { readdirSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const expectedByFile = new Map([
  ['test/eslint-boundary-fixture/illegal-import.ts', ['import/no-restricted-paths']],
  // The by-name counterpart of the line above: illegal-import.ts uses a RELATIVE specifier,
  // this one uses `@minitui/sanitizer`. Only this entry fails when the resolver stops
  // reaching package source, which is the state a cold clone is in without the root
  // tsconfig `paths` mapping.
  ['test/eslint-boundary-fixture/illegal-by-name-import.ts', ['import/no-restricted-paths']],
  [
    'test/eslint-boundary-fixture/illegal-dynamic-capability.ts',
    ['minitui/no-restricted-capability-load'],
  ],
  [
    'test/eslint-boundary-fixture/illegal-nonliteral-load.ts',
    ['minitui/no-restricted-capability-load', 'minitui/no-vitest-replacement-api'],
  ],
  [
    'test/eslint-boundary-fixture/illegal-create-require-capability.ts',
    ['minitui/no-restricted-capability-load', 'minitui/no-vitest-replacement-api'],
  ],
  [
    'test/eslint-boundary-fixture/illegal-get-builtin-module.ts',
    ['minitui/no-restricted-capability-load', 'minitui/no-vitest-replacement-api'],
  ],
  [
    'test/eslint-boundary-fixture/illegal-module-export-capability.ts',
    ['minitui/no-restricted-capability-load', 'minitui/no-vitest-replacement-api'],
  ],
  [
    'test/eslint-boundary-fixture/illegal-process-export-capability.ts',
    ['minitui/no-restricted-capability-load', 'minitui/no-vitest-replacement-api'],
  ],
  [
    'test/eslint-boundary-fixture/illegal-computed-process-capability.ts',
    ['minitui/no-restricted-capability-load', 'minitui/no-vitest-replacement-api'],
  ],
  ['test/eslint-boundary-fixture/illegal-eval-capability.ts', ['no-eval']],
  ['test/eslint-boundary-fixture/illegal-implied-eval-capability.ts', ['no-implied-eval']],
  ['test/eslint-boundary-fixture/illegal-test-file-capability.test.ts', ['no-restricted-imports']],
  [
    'test/eslint-boundary-fixture/illegal-sanitizer-import.ts',
    ['minitui/sanitizer-local-imports-only'],
  ],
  [
    'test/eslint-boundary-fixture/illegal-vitest-alias.test.ts',
    ['minitui/no-vitest-replacement-api'],
  ],
  [
    'test/eslint-boundary-fixture/illegal-vitest-nonliteral.test.ts',
    ['minitui/no-vitest-replacement-api'],
  ],
  [
    'test/eslint-boundary-fixture/illegal-vitest-computed.test.ts',
    ['minitui/no-vitest-replacement-api'],
  ],
  [
    'test/eslint-boundary-fixture/illegal-vitest-string-export.test.ts',
    ['minitui/no-vitest-replacement-api'],
  ],
  [
    'test/eslint-boundary-fixture/illegal-vitest-create-require.test.ts',
    ['minitui/no-vitest-replacement-api'],
  ],
  [
    'test/eslint-boundary-fixture/illegal-vitest-get-builtin-module.test.ts',
    ['minitui/no-vitest-replacement-api'],
  ],
  [
    'test/eslint-boundary-fixture/illegal-vitest-module-export.test.ts',
    ['minitui/no-vitest-replacement-api'],
  ],
  [
    'test/eslint-boundary-fixture/illegal-vitest-process-export.test.ts',
    ['minitui/no-vitest-replacement-api'],
  ],
  [
    'test/eslint-boundary-fixture/illegal-vitest-process-destructure.test.ts',
    ['minitui/no-vitest-replacement-api'],
  ],
  [
    'test/eslint-boundary-fixture/illegal-vitest-computed-process.test.ts',
    ['minitui/no-vitest-replacement-api'],
  ],
  ['test/eslint-boundary-fixture/illegal-vitest-eval.test.ts', ['no-eval']],
  ['test/eslint-boundary-fixture/illegal-vitest-implied-eval.test.ts', ['no-implied-eval']],
  ['test/eslint-boundary-fixture/illegal-vitest-function-call.test.ts', ['no-restricted-globals']],
  ['test/eslint-boundary-fixture/illegal-vitest-new-function.test.ts', ['no-restricted-globals']],
  ['test/eslint-boundary-fixture/illegal-vitest-function-alias.test.ts', ['no-restricted-globals']],
  [
    'test/eslint-boundary-fixture/illegal-vitest-global-function.test.ts',
    ['minitui/no-vitest-replacement-api'],
  ],
  [
    'test/eslint-boundary-fixture/illegal-vitest-global-computed-function.test.ts',
    ['minitui/no-vitest-replacement-api'],
  ],
  [
    'test/eslint-boundary-fixture/illegal-vitest-global-function-destructure.test.ts',
    ['minitui/no-vitest-replacement-api'],
  ],
  [
    'test/eslint-boundary-fixture/illegal-vitest-global-computed-function-destructure.test.ts',
    ['minitui/no-vitest-replacement-api'],
  ],
  [
    'test/eslint-boundary-fixture/illegal-vitest-global-function-default.test.ts',
    ['minitui/no-vitest-replacement-api'],
  ],
  [
    'test/eslint-boundary-fixture/illegal-vitest-global-computed-function-default.test.ts',
    ['minitui/no-vitest-replacement-api'],
  ],
  [
    'test/eslint-boundary-fixture/illegal-vitest-global-satisfies-function.test.ts',
    ['minitui/no-vitest-replacement-api'],
  ],
  [
    'test/eslint-boundary-fixture/illegal-vitest-global-as-function-key.test.ts',
    ['minitui/no-vitest-replacement-api'],
  ],
  [
    'test/eslint-boundary-fixture/illegal-vitest-global-as-function-destructure.test.ts',
    ['minitui/no-vitest-replacement-api'],
  ],
  [
    'test/eslint-boundary-fixture/illegal-vitest-satisfies-computed-process.test.ts',
    ['minitui/no-vitest-replacement-api'],
  ],
  ['test/eslint-boundary-fixture/legal-vitest-shadowed-global-function.test.ts', []],
  ['test/eslint-boundary-fixture/legal-vitest-domain-get-builtin-module.test.ts', []],
  [
    'apps/eslint-policy-fixture/src/illegal-capability.ts',
    ['minitui/no-restricted-capability-load'],
  ],
  ['apps/eslint-policy-fixture/src/illegal-function-alias.ts', ['no-restricted-globals']],
  [
    'apps/eslint-policy-fixture/src/illegal-global-function-alias.ts',
    ['minitui/no-restricted-capability-load'],
  ],
  [
    'apps/eslint-policy-fixture/src/illegal-global-function-destructure.ts',
    ['minitui/no-restricted-capability-load'],
  ],
  [
    'apps/eslint-policy-fixture/src/illegal-global-computed-function-destructure.ts',
    ['minitui/no-restricted-capability-load'],
  ],
  [
    'apps/eslint-policy-fixture/src/illegal-global-function-default.ts',
    ['minitui/no-restricted-capability-load'],
  ],
  [
    'apps/eslint-policy-fixture/src/illegal-global-computed-function-default.ts',
    ['minitui/no-restricted-capability-load'],
  ],
  [
    'apps/eslint-policy-fixture/src/illegal-global-satisfies-function.ts',
    ['minitui/no-restricted-capability-load'],
  ],
  [
    'apps/eslint-policy-fixture/src/illegal-global-as-function-key.ts',
    ['minitui/no-restricted-capability-load'],
  ],
  [
    'apps/eslint-policy-fixture/src/illegal-global-as-function-destructure.ts',
    ['minitui/no-restricted-capability-load'],
  ],
  [
    'apps/eslint-policy-fixture/src/illegal-satisfies-computed-process.ts',
    ['minitui/no-restricted-capability-load'],
  ],
  [
    'apps/eslint-policy-fixture/src/illegal-process-destructure.ts',
    ['@typescript-eslint/unbound-method', 'minitui/no-restricted-capability-load'],
  ],
  ['apps/eslint-policy-fixture/src/legal-shadowed-global-function.ts', []],
  ['apps/eslint-policy-fixture/src/legal-domain-get-builtin-module.ts', []],
]);

const eslint = new ESLint({ cwd: root, ignore: false });
const results = await eslint.lintFiles([...expectedByFile.keys()]);
let failed = false;

for (const result of results) {
  const file = relative(root, result.filePath).replaceAll('\\', '/');
  const expected = expectedByFile.get(file) ?? [];
  const actual = result.messages
    .filter((message) => message.severity === 2)
    .map((message) => message.ruleId ?? '<fatal>')
    .sort();
  const wanted = [...expected].sort();
  if (JSON.stringify(actual) !== JSON.stringify(wanted)) {
    console.error(`${file}: expected ${JSON.stringify(wanted)}, got ${JSON.stringify(actual)}`);
    failed = true;
  }
}

for (const file of expectedByFile.keys()) {
  if (!results.some((result) => relative(root, result.filePath).replaceAll('\\', '/') === file)) {
    console.error(`${file}: fixture was not linted`);
    failed = true;
  }
}

// Registry completeness: every .ts under a fixture tree is either mapped above or named
// here as a deliberate non-fixture. Without this pass, a fixture nobody registers is
// simply never linted and this script reports OK while covering less than it appears to.
//
// The fixture trees are DISCOVERED, not hard-coded: any directory under a fixture root
// whose name ends in `-fixture` is one. A hard-coded list of directories silently
// excludes whichever tree a later plan adds — which is the same non-biting-gate defect
// this pass exists to remove, reintroduced one level up.
const FIXTURE_ROOTS = ['apps', 'test'];
const BUILD_OUTPUT = new Set(['dist', 'dist-types', 'node_modules']);
// internal-stub.ts is the import TARGET of illegal-import.ts, not a fixture of its own:
// it plants no violation and has no expected rule ids.
const NON_FIXTURES = new Set(['test/eslint-boundary-fixture/internal-stub.ts']);

const dirsIn = (rel) =>
  readdirSync(join(root, rel), { withFileTypes: true }).filter((e) => e.isDirectory());

const tsFilesUnder = (rel) =>
  readdirSync(join(root, rel), { withFileTypes: true }).flatMap((entry) => {
    if (entry.isDirectory())
      return BUILD_OUTPUT.has(entry.name) ? [] : tsFilesUnder(`${rel}/${entry.name}`);
    return entry.name.endsWith('.ts') ? [`${rel}/${entry.name}`] : [];
  });

const fixtureDirs = FIXTURE_ROOTS.flatMap((rootDir) =>
  dirsIn(rootDir)
    .filter((entry) => entry.name.endsWith('-fixture'))
    .map((entry) => `${rootDir}/${entry.name}`),
);

// Guard the inventory against being vacuous itself: if discovery finds no tree (a rename,
// a moved root), the loop below would pass by covering nothing.
if (fixtureDirs.length === 0) {
  console.error(
    `no fixture tree discovered under ${FIXTURE_ROOTS.join('/, ')}/ — the completeness pass is covering nothing`,
  );
  failed = true;
}

for (const dir of fixtureDirs) {
  for (const rel of tsFilesUnder(dir)) {
    if (expectedByFile.has(rel) || NON_FIXTURES.has(rel)) continue;
    console.error(
      `${rel}: fixture file is not in the registry (add it, or list it in NON_FIXTURES)`,
    );
    failed = true;
  }
}

if (failed) process.exitCode = 1;
else
  console.log(
    `eslint policy fixtures: OK (${expectedByFile.size} mapped, ${fixtureDirs.length} fixture trees discovered: ${fixtureDirs.join(', ')})`,
  );
