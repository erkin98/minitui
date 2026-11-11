import { defineConfig } from 'tsup';

// One bundle of the program. The dependencies in the manifest (every @minitui package, ink, react, zod)
// stay external, and the bin imports the result through the package's own name.
export default defineConfig({
  entry: { cli: 'src/index.ts' },
  format: ['esm'],
  platform: 'node',
  target: 'node22',
  clean: true,
  sourcemap: true,
  dts: false,
});
