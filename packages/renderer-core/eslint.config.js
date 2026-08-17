import importPlugin from 'eslint-plugin-import';
import tseslint from 'typescript-eslint';

// Package-local EXTERNAL-module ban: the bare npm specifiers no-restricted-paths
// cannot match (they have no path under ./packages). Everything React/Ink/json-render-ink/
// OpenTUI/Node-exec/MCP/sandbox/AI-SDK is forbidden inside renderer-core — an ERROR, not a warning.
// The internal `@minitui/* except types` edge is enforced cross-package by the shared
// config/eslint-boundaries.js no-restricted-paths zone; the last entry below
// mirrors it locally as defense-in-depth so the planted test can prove the gate self-contained.
// Pattern convention: a BARE literal package name inside a `patterns` group uses
// gitignore semantics and segment-matches deeper specifiers (bare 'ink' wrongly flags
// '@json-render/ink/server'; a negation cannot rescue a path whose parent matched).
// Literal (non-wildcard) specifiers therefore go in `paths` (exact-string match);
// `patterns` is reserved for genuine wildcard families (an anchored '<pkg>/*'), so a
// subpath import like 'react/jsx-runtime' or 'ai/react' is caught without over-matching.
const FORBIDDEN_PATHS = [
  { name: 'react', message: 'renderer-core is the swap boundary — no React.' },
  { name: 'ink', message: 'renderer-core is the swap boundary — no Ink.' },
  { name: '@json-render/ink', message: 'no renderer impl in renderer-core.' },
  // pre-emptive symmetry: no renderer-opentui package exists yet, but this port's own
  // contract (renderer-port.ts) names OpenTUI as the anticipated swap target, so the same
  // "no concrete renderer" rule applies before that package is ever scaffolded.
  { name: '@opentui/react', message: 'renderer-core is the swap boundary — no OpenTUI.' },
  { name: '@opentui/core', message: 'renderer-core is the swap boundary — no OpenTUI.' },
  { name: 'node:child_process', message: 'only @minitui/exec may import child_process.' },
  { name: 'child_process', message: 'only @minitui/exec may import child_process.' },
  {
    name: '@modelcontextprotocol/client',
    message: 'only @minitui/exec may import the MCP client SDK.',
  },
  {
    name: '@anthropic-ai/sandbox-runtime',
    message: 'only @minitui/exec may import the sandbox runtime.',
  },
  { name: 'ai', message: 'only @minitui/agent-core may import the AI SDK.' },
];

const FORBIDDEN_PATTERNS = [
  { group: ['react/*'], message: 'renderer-core is the swap boundary — no React.' },
  { group: ['ink/*'], message: 'renderer-core is the swap boundary — no Ink.' },
  { group: ['@json-render/ink/*'], message: 'no renderer impl in renderer-core.' },
  {
    group: ['@opentui/react/*', '@opentui/core/*'],
    message: 'renderer-core is the swap boundary — no OpenTUI.',
  },
  {
    group: ['@modelcontextprotocol/client/*'],
    message: 'only @minitui/exec may import the MCP client SDK.',
  },
  {
    group: ['@anthropic-ai/sandbox-runtime/*'],
    message: 'only @minitui/exec may import the sandbox runtime.',
  },
  { group: ['ai/*', '@ai-sdk/*'], message: 'only @minitui/agent-core may import the AI SDK.' },
  // mirror of the shared no-restricted-paths edge: any other @minitui/* except types is disallowed
  {
    group: ['@minitui/*', '!@minitui/types'],
    message: 'renderer-core may import @minitui/types ONLY.',
  },
];

export default tseslint.config({
  files: ['src/**/*.ts'],
  plugins: { import: importPlugin },
  languageOptions: { parser: tseslint.parser },
  rules: {
    'no-restricted-imports': ['error', { paths: FORBIDDEN_PATHS, patterns: FORBIDDEN_PATTERNS }],
  },
});
