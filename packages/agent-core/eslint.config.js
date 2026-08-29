import importPlugin from 'eslint-plugin-import';
import tseslint from 'typescript-eslint';

// Package-local EXTERNAL-module ban for @minitui/agent-core. The DAG edge is
// `agent-core -> types, transport, spec, sanitizer` and NOTHING else. agent-core is the
// model loop + provider seam: it is NOT a renderer (no React/Ink/@json-render) and NOT the
// exec moat (no child_process / MCP client / sandbox runtime — it reaches execution ONLY
// through the injected ToolDispatchPort). It IS the ONE package permitted the AI SDK, so
// `ai` / `@ai-sdk/*` are deliberately ABSENT from the ban here (every other package's local
// config forbids them). The internal `@minitui/* except {types,transport,spec,sanitizer}`
// edge is enforced cross-package by config/eslint-boundaries.js no-restricted-paths; the last
// pattern below mirrors it locally as defense-in-depth. Pattern convention (same as sibling
// packages): a BARE literal package name in a `patterns` group uses gitignore semantics and
// segment-matches deeper specifiers; literal specifiers therefore go in `paths` (exact match)
// and `patterns` is reserved for genuine wildcard families (an anchored '<pkg>/*').
const FORBIDDEN_PATHS = [
  { name: 'react', message: 'agent-core is not a renderer — no React.' },
  { name: 'ink', message: 'agent-core is not a renderer — no Ink.' },
  {
    name: '@json-render/core',
    message: 'agent-core is not a renderer — no @json-render/*.',
  },
  {
    name: '@json-render/ink',
    message: 'agent-core is not a renderer — no @json-render/*.',
  },
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
];

const FORBIDDEN_PATTERNS = [
  { group: ['react/*'], message: 'agent-core is not a renderer — no React.' },
  { group: ['ink/*'], message: 'agent-core is not a renderer — no Ink.' },
  {
    group: ['@json-render/*'],
    message: 'agent-core is not a renderer — no @json-render/*.',
  },
  {
    group: ['@modelcontextprotocol/client/*'],
    message: 'only @minitui/exec may import the MCP client SDK.',
  },
  {
    group: ['@anthropic-ai/sandbox-runtime/*'],
    message: 'only @minitui/exec may import the sandbox runtime.',
  },
  // mirror of the shared no-restricted-paths edge: any @minitui/* except the four allowed
  {
    group: [
      '@minitui/*',
      '!@minitui/types',
      '!@minitui/transport',
      '!@minitui/spec',
      '!@minitui/sanitizer',
    ],
    message: 'agent-core may import @minitui/{types,transport,spec,sanitizer} ONLY.',
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
