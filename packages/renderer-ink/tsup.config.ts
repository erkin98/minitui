import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/index.ts'],
  format: ['esm'],
  // composite:false avoids TS6307 and guarantees declaration emission under the composite source
  // project. The banner makes the published declaration graph dependency-closed: MountInkArgs names the
  // ambient NodeJS.WriteStream and NodeJS.ReadStream (its io field), and a strict consumer has no
  // automatic @types inclusion. The reference resolves @types/node from THIS package's own
  // dependencies (why @types/node is a published dep, not a devDep). The bundler drops a source-level
  // triple-slash reference, so it must be injected at emit.
  dts: {
    compilerOptions: { composite: false },
    banner: '/// <reference types="node" />',
  },
  clean: true,
  sourcemap: true,
  target: 'node22',
  // regex so the @json-render/core/store-utils SUBPATH import stays external too
  external: ['react', 'ink', /^@json-render\//, /^@minitui\//, 'fast-json-patch'],
});
