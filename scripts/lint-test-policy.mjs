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

const eslint = new ESLint({ cwd: root, errorOnUnmatchedPattern: false });
const results = await eslint.lintFiles(testPatterns);
const lintedFiles = new Set(results.map((result) => result.filePath));

if (lintedFiles.size === 0) {
  throw new Error('lint:test-policy matched zero files');
}

const formatter = await eslint.loadFormatter('stylish');
const output = await formatter.format(results);
if (output.length > 0) console.error(output);

const errorCount = results.reduce((total, result) => total + result.errorCount, 0);
if (errorCount > 0) process.exitCode = 1;
else console.log(`lint:test-policy: ${lintedFiles.size} files OK`);
