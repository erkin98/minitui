import { defineProject, mergeConfig } from 'vitest/config';
import sharedVitestConfig from '../../vitest.shared.js';

export default mergeConfig(
  sharedVitestConfig,
  defineProject({
    test: {
      name: '@minitui/test-kit',
      environment: 'node',
      include: ['test/**/*.test.ts', 'test/**/*.test.tsx'],
    },
  }),
);
