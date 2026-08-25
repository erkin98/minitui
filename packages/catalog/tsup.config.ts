import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/index.ts'],
  format: ['esm'],
  dts: { compilerOptions: { composite: false } },
  sourcemap: true,
  clean: true,
  target: 'node22',
  external: [
    '@json-render/core',
    '@json-render/ink',
    'zod',
    '@minitui/types',
    '@minitui/renderer-core',
    '@minitui/sanitizer',
  ],
});
