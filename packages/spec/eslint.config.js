import importPlugin from 'eslint-plugin-import';
import tseslint from 'typescript-eslint';

// Package-local EXTERNAL-module ban for @minitui/spec. The DAG edge is `spec -> types,
// catalog` and NOTHING else: spec is the contract + validate/autoFix/reprompt loop, never
// a renderer and never the exec moat, so React/Ink/@json-render/ink (ALL subpaths, including
// /server — spec never renders), child_process, the MCP client, the sandbox runtime, and the
// AI SDK are each an ERROR here. The internal `@minitui/* except types, catalog` edge is
// enforced cross-package by config/eslint-boundaries.js no-restricted-paths; the last pattern
// below mirrors it locally as defense-in-depth so a planted violation proves the gate bites.
// Pattern convention (same as the sibling packages): a BARE literal package name in a
// `patterns` group uses gitignore semantics and segment-matches deeper specifiers (bare 'ink'
// wrongly flags '@json-render/ink/server'; a negation cannot rescue a path whose parent
// matched). Literal specifiers therefore go in `paths` (exact-string match); `patterns` is
// reserved for genuine wildcard families (an anchored '<pkg>/*').
const FORBIDDEN_PATHS = [
  { name: 'react', message: 'spec is not a renderer — no React.' },
  { name: 'ink', message: 'spec is not a renderer — no Ink.' },
  {
    name: '@json-render/ink',
    message: 'spec is not a renderer — no @json-render/ink (adopt only @json-render/core).',
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
  { name: 'ai', message: 'only @minitui/agent-core may import the AI SDK.' },
];

const FORBIDDEN_PATTERNS = [
  { group: ['react/*'], message: 'spec is not a renderer — no React.' },
  { group: ['ink/*'], message: 'spec is not a renderer — no Ink.' },
  {
    group: ['@json-render/ink/*'],
    message: 'spec is not a renderer — no @json-render/ink (adopt only @json-render/core).',
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
  // mirror of the shared no-restricted-paths edge: any other @minitui/* except types + catalog
  {
    group: ['@minitui/*', '!@minitui/types', '!@minitui/catalog'],
    message: 'spec may import @minitui/types and @minitui/catalog ONLY.',
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
