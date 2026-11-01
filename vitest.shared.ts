// vitest.shared.ts
import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';

const fromRoot = (rel: string): string => fileURLToPath(new URL(rel, import.meta.url));

export const sharedVitestConfig = defineConfig({
  resolve: {
    // Dedup React/Ink under Vitest's transform (json-render's vitest pattern):
    // pnpm strict resolution can hand two packages two copies; the alias forces the
    // hoisted root copy so the Ink reconciler never sees a second React.
    alias: {
      react: fromRoot('./node_modules/react'),
      'react-dom': fromRoot('./node_modules/react-dom'),
      ink: fromRoot('./node_modules/ink'),
    },
  },
  test: {
    environment: 'node',
    // surface.test.ts builds a real TypeScript program per test: 0.8-1.0s plain and 3.5-4.8s with V8
    // coverage on an idle machine. Under the pre-push hook's load (nine of them at once) it took up to
    // 6.3s in the plain test step and up to 20.1s in the coverage step, which is why test:coverage leaves
    // the surface tests out. The slowest default-limit row left in the coverage step took 7.7s
    // (floor-operands). The 5000ms vitest default is too tight for the plain run under load; the 20s
    // limit applies to both steps.
    testTimeout: 20_000,
    setupFiles: [fromRoot('./vitest.determinism.setup.ts')],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'lcov'],
      include: [fromRoot('./packages/*/src/**/*.{ts,tsx}')],
      exclude: [fromRoot('./packages/*/dist/**')],
      thresholds: {
        statements: 85,
        branches: 80,
        functions: 80,
        lines: 85,
      },
    },
  },
});

export default sharedVitestConfig;
