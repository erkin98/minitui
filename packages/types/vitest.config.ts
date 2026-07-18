import { defineProject } from 'vitest/config';

export default defineProject({
  test: {
    name: '@minitui/types',
    environment: 'node',
    include: ['test/**/*.test.ts'],
  },
});
