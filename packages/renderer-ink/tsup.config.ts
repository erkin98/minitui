import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/index.ts'],
  format: ['esm'],
  dts: { compilerOptions: { composite: false } },
  clean: true,
  sourcemap: true,
  target: 'node22',
  // regex so the @json-render/core/store-utils SUBPATH import stays external too
  external: ['react', 'ink', /^@json-render\//, /^@minitui\//, 'fast-json-patch'],
});
