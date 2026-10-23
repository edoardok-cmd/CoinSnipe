import { defineConfig } from 'vitest/config';

export default defineConfig({
  // tsconfig keeps `jsx: preserve` for Next; the unit tests render components, so compile JSX here.
  oxc: { jsx: { runtime: 'automatic' } },
  test: {
    include: ['tests/**/*.test.ts'],
    exclude: ['e2e/**', 'node_modules/**'],
  },
});
