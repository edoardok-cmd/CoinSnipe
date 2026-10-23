import { defineConfig } from 'vitest/config';

// Repo-level checks (CI workflow guards). Workspace unit tests have their own configs.
export default defineConfig({
  test: {
    include: ['tests/**/*.test.mjs', 'tools/**/*.test.ts'],
  },
});
