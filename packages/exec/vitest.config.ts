import { defineProject, mergeConfig } from 'vitest/config';
import sharedVitestConfig from '../../vitest.shared.js';

export default mergeConfig(
  sharedVitestConfig,
  defineProject({
    test: {
      name: '@minitui/exec',
      environment: 'node',
      include: ['test/**/*.test.ts'],
    },
  }),
);
