import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/index.ts'],
  format: ['esm'],
  dts: { compilerOptions: { composite: false } },
  clean: true,
  sourcemap: true,
  target: 'node22',
  // ship the bundled bash grammar next to the dist so parser.ts resolves it at runtime. Delegate to
  // the package's own `bundle-grammars` script (pnpm runs it with cwd = the package dir, so the
  // ../../scripts relative path resolves deterministically regardless of tsup's onSuccess cwd).
  onSuccess: 'pnpm bundle-grammars',
});
