import { defineConfig } from 'tsup';

// One entry point per job: each file in src/jobs becomes dist/jobs/<name>.js,
// runnable with `node dist/jobs/<name>.js`.
export default defineConfig({
  entry: ['src/index.ts', 'src/jobs/*.ts', '!src/**/*.test.ts'],
  format: ['esm'],
  sourcemap: true,
  clean: true,
  target: 'node22',
});
