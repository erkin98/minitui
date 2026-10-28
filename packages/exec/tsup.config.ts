import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/index.ts'],
  format: ['esm'],
  // The public declarations name NodeJS.ProcessEnv, NodeJS.Platform and AbortSignal; a strict
  // consumer (types: [], lib ES2023, skipLibCheck: false) has no automatic @types inclusion, so the
  // banner resolves @types/node from this package's own dependencies. The rollup drops a source-level
  // triple-slash reference, so it is injected at emit.
  dts: {
    compilerOptions: { composite: false },
    banner: '/// <reference types="node" />',
  },
  clean: true,
  sourcemap: true,
  target: 'node22',
  // ship the bundled bash grammar next to the dist so parser.ts resolves it at runtime. Delegate to
  // the package's own `bundle-grammars` script (pnpm runs it with cwd = the package dir, so the
  // ../../scripts relative path resolves deterministically regardless of tsup's onSuccess cwd).
  onSuccess: 'pnpm bundle-grammars',
});
