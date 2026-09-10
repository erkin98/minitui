import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/index.ts'],
  format: ['esm'],
  dts: { compilerOptions: { composite: false } },
  clean: true,
  sourcemap: true,
  target: 'node22',
  external: ['@json-render/core', 'zod', '@minitui/types', '@minitui/catalog'],
});
