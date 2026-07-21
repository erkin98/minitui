// eslint.config.js
import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import importPlugin from 'eslint-plugin-import';
import { BOUNDARY_ZONES, restrictedPathsRule } from './config/eslint-boundaries.js';

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
      'test/eslint-boundary-fixture/**',
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
    files: ['**/*.ts', '**/*.tsx', '**/*.mts'],
    plugins: { import: importPlugin },
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
    // Exec-moat capability wall (AGENTS.md security invariant): ONLY packages/exec may
    // import the subprocess / OS-sandbox / MCP-client specifiers. Enforced repo-wide on
    // shipped SOURCE so a capability-wall breach reds at lint today — the plan-17 dist
    // bundle-leak gate scans the built bundle (the stronger, later backstop); this is the
    // cheap source-level companion. Scope is packages/*/src (the ship surface) only:
    // tooling scripts (scripts/*.mjs) legitimately shell out and are intentionally out of
    // scope. The three specifiers below are exec-ONLY across the whole product — no other
    // package ever needs them — so an except-exec ban is correct for every future package.
    files: ['packages/*/src/**/*.{ts,tsx,mts}'],
    ignores: ['packages/exec/**'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          paths: [
            {
              name: 'child_process',
              message: 'Exec-moat: only @minitui/exec may import child_process.',
            },
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
          ],
          patterns: [
            {
              group: ['@modelcontextprotocol/*', '@anthropic-ai/sandbox-runtime/*'],
              message: 'Exec-moat: only @minitui/exec may import MCP-client / OS-sandbox modules.',
            },
          ],
        },
      ],
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
      '**/test/**/*.{ts,tsx}',
      '**/__tests__/**/*.{ts,tsx}',
    ],
    ...tseslint.configs.disableTypeChecked,
  },
);
