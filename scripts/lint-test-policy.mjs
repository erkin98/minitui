/* global console, process */
import { ESLint } from 'eslint';
import { globSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const testPatterns = [
  '**/*.test.{ts,tsx}',
  '**/*.spec.{ts,tsx}',
  '**/test/**/*.{ts,tsx}',
  '**/__tests__/**/*.{ts,tsx}',
];

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

const { results, files: lintedFiles } = await lintOrDie(testPatterns);

const formatter = await eslint.loadFormatter('stylish');
const output = await formatter.format(results);
if (output.length > 0) console.error(output);

let failed = results.reduce((total, result) => total + result.errorCount, 0) > 0;

// Reachability guard for the replacement-API ban. `no-vitest-replacement-api` catches
// `vi`/`vitest` only when they are IMPORTED; with vitest's `globals: true`, `vi` becomes an
// ambient global and `vi.mock(...)` needs no import — invisible to the rule. Forbidding
// `globals: true` in every vitest config keeps the import ban the whole enforcement surface,
// which is simpler and stricter than an AST member check that would risk false positives on
// any object named `vi`.
const hasGlobalsTrue = (source) =>
  // ponytail: strip /* */ then // comments, then match the boolean literal — enough for
  // hand-written configs; a computed `globals: someFlag` is not modelled (nor used here).
  /\bglobals\s*:\s*true\b/.test(source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, ''));

// Positive control: the matcher must flag the on-setting, clear the off-setting, and ignore
// a commented one — else a broken regex or missing comment-strip would pass vacuously.
if (
  !hasGlobalsTrue('test: { globals: true }') ||
  hasGlobalsTrue('test: { globals: false }') ||
  hasGlobalsTrue('// globals: true — never enable')
) {
  throw new Error('lint:test-policy globals guard is vacuous');
}

const vitestConfigs = globSync(
  [
    'vitest.shared.ts',
    'vitest.config.ts',
    'packages/*/vitest.config.ts',
    'apps/*/vitest.config.ts',
    'test/vitest.config.ts',
  ],
  { cwd: root },
);
const globalsOffenders = vitestConfigs.filter((rel) =>
  hasGlobalsTrue(readFileSync(resolve(root, rel), 'utf8')),
);
if (globalsOffenders.length > 0) {
  console.error(
    `lint:test-policy: vitest 'globals: true' makes replacement APIs ambient globals and bypasses no-vitest-replacement-api — remove it from ${globalsOffenders.join(', ')}`,
  );
  failed = true;
}

if (failed) process.exitCode = 1;
else
  console.log(
    `lint:test-policy: ${lintedFiles.size} test files OK, ${vitestConfigs.length} vitest configs free of 'globals: true'`,
  );
