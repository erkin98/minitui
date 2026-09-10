import importPlugin from 'eslint-plugin-import';
import tseslint from 'typescript-eslint';

// catalog -> types, renderer-core, sanitizer (+ @json-render/core,
// @json-render/ink/server, zod). The load-bearing line: ALLOW '@json-render/ink/server'
// (React erased via import type), FORBID the React root '@json-render/ink' and its
// React-pulling subpaths. Importing any forbidden specifier is a boundary breach (ERROR).
//
// paths vs patterns: no-restricted-imports' `patterns` option matches via the `ignore`
// package's gitignore semantics, not plain globbing — a bare group entry like 'ink'
// segment-matches ANY path segment named 'ink' (so it wrongly flags
// '@json-render/ink/server'), and an anchored bare entry like '@json-render/ink'
// directory-matches everything nested under it (same false positive) — a negation
// cannot rescue a path whose parent already matched. Every literal (non-wildcard)
// specifier therefore goes in `paths` below (exact-string match, no glob semantics);
// `patterns` is reserved for genuine wildcard families (a trailing '/*').
const FORBIDDEN_PATHS = [
  { name: 'react', message: 'catalog is React-free — no React.' },
  { name: 'ink', message: 'catalog is React-free — no Ink.' },
  // FORBID the React root + every non-/server subpath; '/server' is allowed
  // (unlisted). The real ink exports map is { '.', './schema', './catalog',
  // './server' } — there is NO './renderer' subpath. './schema' and './catalog'
  // are themselves React-free, but this is a deliberate CONSERVATIVE single-surface
  // policy: the package routes ALL json-render std defs through one bridge
  // (schema-bridge.ts -> '@json-render/ink/server'), so any other ink specifier is
  // a boundary breach regardless of whether it happens to pull React today.
  {
    name: '@json-render/ink',
    message:
      "import '@json-render/ink/server' (React-free), never the @json-render/ink root or any other subpath.",
  },
  {
    name: '@json-render/ink/schema',
    message:
      "import '@json-render/ink/server' (React-free), never the @json-render/ink root or any other subpath.",
  },
  {
    name: '@json-render/ink/catalog',
    message:
      "import '@json-render/ink/server' (React-free), never the @json-render/ink root or any other subpath.",
  },
  { name: 'node:child_process', message: 'only @minitui/exec may import child_process.' },
  { name: 'child_process', message: 'only @minitui/exec may import child_process.' },
  {
    name: '@modelcontextprotocol/client',
    message: 'only @minitui/exec may import the MCP client.',
  },
  {
    name: '@anthropic-ai/sandbox-runtime',
    message: 'only @minitui/exec may import the sandbox runtime.',
  },
  { name: 'ai', message: 'only @minitui/agent-core may import the AI SDK.' },
];

const FORBIDDEN_PATTERNS = [
  { group: ['react/*'], message: 'catalog is React-free — no React.' },
  { group: ['ink/*'], message: 'catalog is React-free — no Ink.' },
  {
    group: ['@modelcontextprotocol/client/*'],
    message: 'only @minitui/exec may import the MCP client.',
  },
  { group: ['@ai-sdk/*'], message: 'only @minitui/agent-core may import the AI SDK.' },
  // any @minitui/* except the three allowed edges is a disallowed edge for catalog.
  {
    group: ['@minitui/*', '!@minitui/types', '!@minitui/renderer-core', '!@minitui/sanitizer'],
    message: 'catalog may import only @minitui/types, @minitui/renderer-core, @minitui/sanitizer.',
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
