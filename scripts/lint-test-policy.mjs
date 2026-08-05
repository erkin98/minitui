/* global console, process */
import { ESLint } from 'eslint';
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

const errorCount = results.reduce((total, result) => total + result.errorCount, 0);
if (errorCount > 0) process.exitCode = 1;
else console.log(`lint:test-policy: ${lintedFiles.size} files OK`);
