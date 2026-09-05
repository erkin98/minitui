// eslint.config.js
import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import importPlugin from 'eslint-plugin-import';
import { BOUNDARY_ZONES, restrictedPathsRule } from './config/eslint-boundaries.js';
import { policyPlugin, TEST_FILE_GLOBS } from './config/eslint-policy.js';

const noDynamicFunctionGlobal = [
  'error',
  {
    name: 'Function',
    message: 'Dynamic Function construction cannot hide a dependency or capability.',
  },
];

// The exec-moat import ban (only @minitui/exec may reach the subprocess / OS-sandbox / MCP capabilities).
const EXEC_MOAT_IMPORT_PATHS = [
  { name: 'child_process', message: 'Exec-moat: only @minitui/exec may import child_process.' },
  {
    name: 'node:child_process',
    message: 'Exec-moat: only @minitui/exec may import child_process.',
  },
  {
    name: '@anthropic-ai/sandbox-runtime',
    message: 'Exec-moat: only @minitui/exec may import the OS sandbox runtime.',
  },
  {
    name: '@modelcontextprotocol/client',
    message: 'Exec-moat: only @minitui/exec may import the MCP client.',
  },
];
const EXEC_MOAT_IMPORT_PATTERNS = [
  {
    group: ['@modelcontextprotocol/*', '@anthropic-ai/sandbox-runtime/*'],
    message: 'Exec-moat: only @minitui/exec may import MCP-client / OS-sandbox modules.',
  },
];
// The SDK wall (only @minitui/agent-core may import the model SDK — the parallel of the exec-moat, and a
// PR-6 deliverable). Banned everywhere the wide block below applies; agent-core is re-permitted by
// agentCoreImportRule (which drops these paths, keeping the exec-moat ones). Kept in the SAME
// no-restricted-imports rule as the exec-moat paths because ESLint flat config replaces (not merges) a
// repeated rule across overlapping file globs — two separate blocks would clobber each other's paths.
const AI_SDK_IMPORT_PATHS = [
  { name: 'ai', message: 'SDK wall: only @minitui/agent-core may import the model SDK (ai).' },
  {
    name: '@ai-sdk/anthropic',
    message: 'SDK wall: only @minitui/agent-core may import @ai-sdk/*.',
  },
];
const AI_SDK_IMPORT_PATTERNS = [
  {
    group: ['@ai-sdk/*'],
    message: 'SDK wall: only @minitui/agent-core may import @ai-sdk/* modules.',
  },
];
// The renderer swap-boundary wall (only @minitui/renderer-ink + @minitui/cli may import React/Ink and the
// Ink renderer — the single place the declarative spec becomes a real terminal UI; a PR-7 deliverable).
// @json-render/CORE is deliberately ABSENT (spec/catalog/renderer-core adopt it); only @json-render/INK
// (the React binding) is walled. Banned everywhere the wide block applies; rendererInkImportRule
// re-permits it for renderer-ink (and cli). Same-rule placement + the clobber note above apply.
const REACT_INK_IMPORT_PATHS = [
  { name: 'react', message: 'Swap boundary: only @minitui/renderer-ink + cli may import React.' },
  {
    name: 'react-dom',
    message: 'Swap boundary: only @minitui/renderer-ink + cli may import React.',
  },
  { name: 'ink', message: 'Swap boundary: only @minitui/renderer-ink + cli may import Ink.' },
  {
    name: '@json-render/ink',
    message: 'Swap boundary: only @minitui/renderer-ink + cli may import @json-render/ink.',
  },
];
const REACT_INK_IMPORT_PATTERNS = [
  {
    group: ['react/*'],
    message: 'Swap boundary: only @minitui/renderer-ink + cli may import React.',
  },
  { group: ['ink/*'], message: 'Swap boundary: only @minitui/renderer-ink + cli may import Ink.' },
  // NOTE: the wall bans the REACT root `@json-render/ink` (in PATHS above) but NOT its `/server`
  // subpath — `@json-render/ink/server` is the deliberately React-FREE entry `@minitui/catalog` adopts
  // for its schema-bridge (a load-bearing non-renderer import). A `@json-render/ink/*` pattern here
  // would wrongly wall that off; the exact-root ban is what the swap boundary needs.
];

// Shared by both exec-moat capability blocks below (the widened glob over real code and
// the narrow list over the boundary-fixture files that exercise this wall) so the two
// stay identical by construction instead of by manual upkeep. The import ban carries BOTH the
// exec-moat paths and the SDK-wall paths (see AI_SDK_IMPORT_PATHS above).
const execMoatCapabilityRules = {
  'no-restricted-imports': [
    'error',
    {
      paths: [...EXEC_MOAT_IMPORT_PATHS, ...AI_SDK_IMPORT_PATHS, ...REACT_INK_IMPORT_PATHS],
      patterns: [
        ...EXEC_MOAT_IMPORT_PATTERNS,
        ...AI_SDK_IMPORT_PATTERNS,
        ...REACT_INK_IMPORT_PATTERNS,
      ],
    },
  ],
  'minitui/no-restricted-capability-load': 'error',
  'no-eval': 'error',
  'no-implied-eval': 'error',
  'no-restricted-globals': noDynamicFunctionGlobal,
};

// @minitui/agent-core is the ONE package permitted the model SDK. Re-set no-restricted-imports (in a
// block placed AFTER the wide exec-moat block, so it wins for agent-core) to DROP the SDK-wall ban only —
// keeping child_process / MCP / sandbox AND React/Ink banned (agent-core is not a renderer and reaches
// execution only through the injected ToolDispatchPort, never a subprocess directly).
const agentCoreImportRule = {
  'no-restricted-imports': [
    'error',
    {
      paths: [...EXEC_MOAT_IMPORT_PATHS, ...REACT_INK_IMPORT_PATHS],
      patterns: [...EXEC_MOAT_IMPORT_PATTERNS, ...REACT_INK_IMPORT_PATTERNS],
    },
  ],
};

// @minitui/renderer-ink + @minitui/cli are the ONLY packages permitted React/Ink (the swap boundary).
// Re-set no-restricted-imports (AFTER the wide block, so it wins for them) to DROP the React/Ink ban only —
// keeping child_process / MCP / sandbox AND the model SDK banned (a renderer is not the exec moat and not
// the agent loop).
const rendererInkImportRule = {
  'no-restricted-imports': [
    'error',
    {
      paths: [...EXEC_MOAT_IMPORT_PATHS, ...AI_SDK_IMPORT_PATHS],
      patterns: [...EXEC_MOAT_IMPORT_PATTERNS, ...AI_SDK_IMPORT_PATTERNS],
    },
  ],
};

// Local-only ignores (untracked working-copy trees). This checkout can double as a
// multi-project workspace, so `eslint .` would otherwise walk many non-repo trees
// (ESLint 9 does not read .gitignore). Loaded best-effort — a clean clone has neither
// the file nor those directories, so its absence is fine.
let localIgnores = [];
try {
  ({ default: localIgnores } = await import('./eslint.ignores.local.mjs'));
} catch {
  localIgnores = [];
}

// Floor on the local-only ignores loaded above: this config and eslint.ignores.local.mjs are
// both untracked, so an entry there could silently disable linting on a real repo tree — the
// vacuous-gate failure the policy fixtures exist to prevent, one level up. Reject any local
// ignore that targets a tracked tree; the repo's own intentional ignores live in the config's
// ignores block below, not here.
const REPO_TREES = /^(\.\/)?(packages|apps|test|scripts|config)(\/|$)/;
// Positive control (lint-test-policy.mjs idiom): prove the floor can fire — REPO_TREES must
// match a planted repo-tree glob, else a broken pattern would let a real overreach pass green.
if (!REPO_TREES.test('packages/**')) {
  throw new Error('eslint.ignores.local repo-tree floor is vacuous');
}
const overreach = localIgnores.filter((p) => typeof p !== 'string' || REPO_TREES.test(p));
if (overreach.length) {
  throw new Error(`eslint.ignores.local.mjs may not ignore a repo tree: ${overreach.join(', ')}`);
}

export default tseslint.config(
  {
    // The planted-violation fixture is INTENTIONALLY a permanent boundary violation.
    // Exclude it from the repo-wide lint so `turbo run lint` / `pnpm lint` stay green
    // on a clean tree; it is exercised on demand via `lint:boundary-fixture`.
    ignores: [
      '**/dist/**',
      '**/dist-types/**',
      '**/node_modules/**',
      '**/*.tsbuildinfo',
      // Hand-written ambient declarations (e.g. the runtime-leaf predicate types) are
      // not part of any tsc project, so the type-aware project service can't lint them.
      '**/*.d.mts',
      '**/*.d.cts',
      'test/eslint-boundary-fixture/**',
      'apps/eslint-policy-fixture/**',
      // Any local-only working-copy trees (absent in a clean clone) come from the
      // best-effort loader above; the rule set is untouched.
      ...localIgnores,
    ],
  },
  js.configs.recommended,
  // recommendedTypeChecked (not plain recommended) is the TYPE/ASYNC half of the clean-code
  // gate: it turns on no-explicit-any + the no-unsafe-* family + the type-aware
  // no-floating-promises at error level — the enforcement AGENTS.md's "no `as any` masking a
  // real type gap" previously left to review. (The lint:test-policy mock-grep is the
  // other half — replacement-mock bans; this is the type/async half.)
  ...tseslint.configs.recommendedTypeChecked,
  {
    files: ['**/*.ts', '**/*.tsx', '**/*.mts', '**/*.cts'],
    plugins: { import: importPlugin, minitui: policyPlugin },
    languageOptions: {
      parserOptions: {
        // Type-aware rules need the TS program. projectService (not `project`) is the
        // typescript-eslint 8 choice for a composite/solution monorepo — it locates each
        // package's own tsconfig via the language service (the root solution tsconfig is
        // `include: []`, so `project: ['./tsconfig.json']` would type-check nothing). The two
        // root config .ts files that sit outside every package tsconfig are excluded below.
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    settings: {
      'import/resolver': {
        typescript: { project: ['./tsconfig.json'] },
      },
    },
    rules: {
      // THE acyclic-DAG gate. Error-level, hard CI gate. Zones in config/eslint-boundaries.js.
      'import/no-restricted-paths': restrictedPathsRule(BOUNDARY_ZONES),
      // The type/async gate, reaffirmed at error over the preset so the guarantee stays
      // legible and survives a preset swap: no dangling promises, no `any` escape hatch.
      '@typescript-eslint/no-floating-promises': 'error',
      '@typescript-eslint/no-explicit-any': 'error',
      // Cyclomatic-complexity ceiling — catches tangled functions by branch count, the
      // companion to the 800-line file ceiling. 15, not the more
      // common 10, stays a real gate for the ~200 ordinary functions. POLICY: the ceiling
      // is NEVER raised — raising it
      // would silently permit unbounded complexity everywhere. The genuinely irreducible
      // cases — an event-dispatch or stream-loop `switch` over a CLOSED union, which is
      // exhaustive rather than tangled — opt out ONE AT A TIME with a targeted
      // `// eslint-disable-next-line complexity` at their own definition (the same honest
      // named-exception mechanism used below for require-yield / require-await). The exact
      // SET of functions that breach 15 is NOT hand-enumerated here: early hand-counts
      // spread 15/16/18/23/30/34 for the same function, so only the real eslint settles
      // membership at build — each over-ceiling function then earns its own disable (an
      // irreducible closed-union dispatcher) or a helper extraction
      // (a decomposable one). Do not hand-count; do not raise the ceiling.
      complexity: ['error', 15],
      // Casing as a CI rule: PascalCase types, camelCase functions, UPPER_CASE / PascalCase
      // (React components) variables. Conservative — object properties, imports, and
      // parameters stay unrestricted so external-API field names don't false-positive.
      // React components declared as function STATEMENTS (`function GenerationStatus()`,
      // `function OffCatalogFallback()`) are PascalCase functions — a PascalCase-name FILTER
      // re-permits them without widening the camelCase rule for ordinary functions.
      '@typescript-eslint/naming-convention': [
        'error',
        { selector: 'typeLike', format: ['PascalCase'] },
        { selector: 'function', format: ['camelCase'] },
        {
          // component exception: a function whose name starts uppercase is a React
          // component — the filter narrows this entry to those names, so an ordinary function
          // still falls to the camelCase entry above and only PascalCase-named ones are exempt.
          selector: 'function',
          filter: { regex: '^[A-Z]', match: true },
          format: ['PascalCase'],
        },
        {
          selector: 'variable',
          format: ['camelCase', 'UPPER_CASE', 'PascalCase'],
          leadingUnderscore: 'allow',
        },
      ],
      // Permits the immutability mandate's rest-sibling discard idiom (`const { [head]:
      // _drop, ...keep } = doc`) — the ban-on-mutation style forces destructure-drop
      // instead of `delete`, so the discarded binding needs a leading-underscore escape.
      '@typescript-eslint/no-unused-vars': [
        'error',
        { ignoreRestSiblings: true, varsIgnorePattern: '^_', argsIgnorePattern: '^_' },
      ],
    },
  },
  {
    // The exec capability wall covers every shipped package, app, and test file (not just
    // src/): the zero-replacement-mock policy pushes test authors toward real
    // implementations, so a subprocess call is exactly as likely to appear in a test as in
    // src. The exec package itself (the one package allowed this capability) and
    // package-local tooling scripts stay out of scope. The boundary-fixture directory is
    // also excluded here because it plants deliberate violations of OTHER rules (e.g. the
    // vitest-replacement-api evasion fixtures use the same indirect-loader shapes this wall
    // watches for) that would otherwise pick up a second, unwanted violation from this wall
    // once it covers test/** broadly; those specific fixtures are listed in the next block
    // instead, where only this wall's own rules apply.
    //
    // Which arm each lint:policy-fixtures witness proves:
    //   apps/**     — proven by apps/eslint-policy-fixture/src/* (drop this arm and the
    //                 fixture gate reds: those fixtures match no other arm).
    //   packages/** — the LIVE moat over real package src + tests. It has no dedicated
    //                 fixture (fixtures live under apps/ and test/), so it is not witnessed
    //                 by removing-reds-the-gate; it is instead witnessed by construction —
    //                 it applies the SAME execMoatCapabilityRules object the apps/ and test/
    //                 fixtures prove fires. Defense-in-depth, not a vacuous gate.
    //   test/**     — currently redundant: real package tests match the packages/** arm, and
    //                 the top-level test/ tree holds only the ignored boundary-fixture dir.
    //                 Kept as the SOLE no-restricted-imports / no-restricted-capability-load
    //                 cover for any future top-level test file — the later test-file block
    //                 carries only eval / globals / vitest-replacement-api, not those two.
    files: [
      'packages/**/*.{ts,tsx,mts,cts}',
      'apps/**/*.{ts,tsx,mts,cts}',
      'test/**/*.{ts,tsx,mts,cts}',
    ],
    ignores: [
      'packages/exec/**',
      'packages/*/scripts/**',
      'scripts/**',
      'test/eslint-boundary-fixture/**',
    ],
    rules: execMoatCapabilityRules,
  },
  {
    // The boundary-fixture files that specifically exercise the exec capability wall above
    // (excluded from its glob so sibling fixtures for other rules can't collide with it).
    files: [
      'test/eslint-boundary-fixture/illegal-dynamic-capability.ts',
      'test/eslint-boundary-fixture/illegal-nonliteral-load.ts',
      'test/eslint-boundary-fixture/illegal-create-require-capability.ts',
      'test/eslint-boundary-fixture/illegal-get-builtin-module.ts',
      'test/eslint-boundary-fixture/illegal-module-export-capability.ts',
      'test/eslint-boundary-fixture/illegal-process-export-capability.ts',
      'test/eslint-boundary-fixture/illegal-computed-process-capability.ts',
      'test/eslint-boundary-fixture/illegal-eval-capability.ts',
      'test/eslint-boundary-fixture/illegal-implied-eval-capability.ts',
      'test/eslint-boundary-fixture/illegal-test-file-capability.test.ts',
      'test/eslint-boundary-fixture/illegal-ai-sdk-import.ts',
      'test/eslint-boundary-fixture/illegal-react-import.ts',
    ],
    rules: execMoatCapabilityRules,
  },
  {
    // @minitui/agent-core is the ONE package permitted the model SDK — re-permit `ai`/`@ai-sdk/*` here
    // (this block is AFTER the wide exec-moat block, so it wins) while keeping the exec-moat bans. The
    // other execMoatCapabilityRules keys (capability-load / eval / globals) are separate rule ids that
    // merge, so only no-restricted-imports is overridden.
    files: ['packages/agent-core/**/*.{ts,tsx,mts}'],
    rules: agentCoreImportRule,
  },
  {
    // @minitui/renderer-ink + @minitui/cli are the ONLY packages permitted React/Ink (the swap
    // boundary) — re-permit react/ink/@json-render/ink here (AFTER the wide block, so it wins) while
    // keeping the exec-moat + SDK-wall bans.
    files: ['packages/renderer-ink/**/*.{ts,tsx,mts}', 'packages/cli/**/*.{ts,tsx,mts}'],
    rules: rendererInkImportRule,
  },
  {
    files: [
      'packages/sanitizer/src/**/*.{ts,tsx,mts}',
      'test/eslint-boundary-fixture/illegal-sanitizer-import.ts',
    ],
    rules: {
      'minitui/sanitizer-local-imports-only': 'error',
    },
  },
  {
    files: TEST_FILE_GLOBS,
    rules: {
      'minitui/no-vitest-replacement-api': 'error',
      'no-eval': 'error',
      'no-implied-eval': 'error',
      'no-restricted-globals': noDynamicFunctionGlobal,
    },
  },
  {
    // Config/test files carry no in-project type info — package tsconfigs are
    // include:["src/**"], so anything under a package's test/ dir, plus the root
    // determinism files and every tsup/vitest config, sits outside every tsconfig's
    // program. Turn the type-checked rules AND the project requirement back off for
    // them so they parse syntactically instead of erroring "not found by the project
    // service" under the type-aware preset above.
    files: [
      '**/*.js',
      '**/*.mjs',
      '**/*.cjs',
      'vitest.config.ts',
      'vitest.shared.ts',
      'vitest.determinism.constants.ts',
      'vitest.determinism.setup.ts',
      'vitest.determinism.test.ts',
      '**/tsup.config.ts',
      '**/vitest.config.ts',
      ...TEST_FILE_GLOBS,
    ],
    ...tseslint.configs.disableTypeChecked,
  },
);
